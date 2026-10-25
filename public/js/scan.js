// Reads text out of a receipt on the phone itself: PDFs through pdf.js
// (their real text when they have it), photos and scanned PDFs through
// Tesseract OCR. All library files are served by the tablet.

const MAX_SIDE = 2400; // px; bigger photos are slower without reading better
const MAX_PDF_PAGES = 5;
const MAX_OCR_PAGES = 3;

let tesseractLoaded;
function loadTesseract() {
  tesseractLoaded ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/tesseract/tesseract.min.js';
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => reject(new Error('Could not load the receipt reader.'));
    document.head.append(script);
  });
  return tesseractLoaded;
}

// One OCR worker, re-initialised only when the language changes.
let worker = null;
let workerLangs = '';
let reportProgress = () => {};
// `langs` lists the languages to read with, most likely first; English is always added.
async function getWorker(langs) {
  langs = [...new Set([...langs, 'eng'])];
  const key = langs.join('+');
  const Tesseract = await loadTesseract();
  if (!worker) {
    worker = await Tesseract.createWorker(langs, 1, {
      workerPath: '/vendor/tesseract/worker.min.js',
      corePath: '/vendor/tesseract-core',
      langPath: '/vendor/lang',
      workerBlobURL: false,
      logger: (m) => {
        if (m.status === 'recognizing text') reportProgress(m.progress);
      },
    });
  } else if (key !== workerLangs) {
    await worker.reinitialize(langs, 1);
  }
  workerLangs = key;
  return worker;
}

async function ocr(canvas, langs, onProgress) {
  const w = await getWorker(langs);
  reportProgress = onProgress;
  try {
    const { data } = await w.recognize(canvas);
    return data.text;
  } finally {
    reportProgress = () => {};
  }
}

function canvasFor(width, height) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  return { canvas, scale };
}

async function imageToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode(); // browsers apply the photo's rotation (EXIF) here
    const { canvas } = canvasFor(img.naturalWidth, img.naturalHeight);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

let pdfjsLoaded;
async function loadPdfjs() {
  pdfjsLoaded ??= import('/vendor/pdfjs/pdf.min.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    return pdfjs;
  });
  return pdfjsLoaded;
}

// Rebuilds visual lines from pdf.js text items (grouped by their height on the page).
function textItemsToLines(items) {
  const rows = [];
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const size = Math.abs(item.transform[3]) || item.height || 10;
    let row = rows.find((r) => Math.abs(r.y - y) < size * 0.5);
    if (!row) rows.push((row = { y, parts: [] }));
    row.parts.push({ x, str: item.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.str.trim()).join(' ')).join('\n');
}

async function renderPage(page, maxSide) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(maxSide / Math.max(base.width, base.height), 4);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  return canvas;
}

async function readPdf(file, langs, onProgress) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    cMapUrl: '/vendor/pdfjs-cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs-fonts/',
  });
  const doc = await task.promise;
  try {
    const first = await doc.getPage(1);
    const thumbnail = (await renderPage(first, 240)).toDataURL('image/jpeg', 0.7);

    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    const texts = [];
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      texts.push(textItemsToLines((await page.getTextContent()).items));
    }
    let text = texts.join('\n');
    // A scanned PDF has (almost) no text of its own: read it like a photo.
    if (text.replace(/\s/g, '').length < 20) {
      const ocrPages = Math.min(doc.numPages, MAX_OCR_PAGES);
      const parts = [];
      for (let i = 1; i <= ocrPages; i++) {
        const canvas = await renderPage(await doc.getPage(i), MAX_SIDE);
        parts.push(await ocr(canvas, langs, (p) => onProgress((i - 1 + p) / ocrPages)));
      }
      text = parts.join('\n');
    }
    return { text, thumbnail, source: 'pdf' };
  } finally {
    task.destroy();
  }
}

export function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

// Returns { text, thumbnail? }. Throws if the file cannot be read at all
// (e.g. an image format this browser cannot decode): the user then types the values.
export async function readReceipt(file, langs, onProgress = () => {}) {
  if (isPdf(file)) return readPdf(file, langs, onProgress);
  const canvas = await imageToCanvas(file);
  return { text: await ocr(canvas, langs, onProgress), source: 'photo' };
}
