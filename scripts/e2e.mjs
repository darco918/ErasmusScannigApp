// End-to-end check in a real browser: a "phone" opens the form over the
// network address, receipts are read by OCR / pdf.js, the form is sent, and
// the "tablet" admin view shows the result. Needs Playwright + Chromium:
//   npm run e2e [-- --screenshots <dir>]

import fontkit from '@pdf-lib/fontkit';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../src/app.js';
import { lanAddresses } from '../src/network.js';
import { openStore } from '../src/store.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const shotsArg = process.argv.indexOf('--screenshots');
const shotsDir = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null;
const fontDir = path.join(import.meta.dirname, '..', 'node_modules', 'dejavu-fonts-ttf', 'ttf');

const RECEIPTS = [
  {
    file: 'hu-train.png', lang: 'hun',
    lines: ['MÁV-START Zrt.', 'NYUGTA', '2025.04.02. 08:15', '', 'Menetjegy 1 db     9 990 Ft', 'Helyjegy 1 db      2 350 Ft', '', 'ÖSSZESEN:         12 340 Ft', 'KÉSZPÉNZ          15 000 Ft', 'VISSZAJÁRÓ         2 660 Ft'],
    expect: { amount: '12340.00', currency: 'HUF', date: '2025-04-02' },
  },
  {
    file: 'bg-taxi.jpg', lang: 'bul',
    lines: ['ТАКСИ ОК СУПЕРТРАНС', 'ФИСКАЛЕН БОН', 'Дата 18.09.2025', '', 'Превоз           23,40', 'ДДС               3,90', '', 'ОБЩО             23,40 лв', 'В БРОЙ           30,00', 'РЕСТО             6,60'],
    expect: { amount: '23.40', currency: 'BGN', date: '2025-09-18' },
  },
  {
    file: 'tr-bus.png', lang: 'tur',
    lines: ['HAVAIST OTOBÜS', 'FİŞ NO: 0042', 'TARİH: 10.06.2025', '', 'BİLET          *250,00', 'TOPKDV          *41,67', '', 'TOPLAM         *250,00 TL'],
    expect: { amount: '250.00', currency: 'TRY', date: '2025-06-10' },
  },
  {
    file: 'es-scanned.pdf', lang: 'spa', scanned: true,
    lines: ['RENFE VIAJEROS', 'Factura simplificada', 'Fecha: 05/07/2025', '', 'Base imponible   37,19', 'IVA 10%           3,72', '', 'TOTAL A PAGAR    40,91 EUR'],
    expect: { amount: '40.91', currency: 'EUR', date: '2025-07-05' },
  },
  {
    file: 'pl-invoice.pdf', lang: 'pol', textPdf: true,
    lines: ['PKP Intercity S.A.', 'Faktura VAT 2025/08/117', 'Data wystawienia: 2025-08-11', '', 'Bilet normalny Warszawa - Kraków   89,99', 'PTU A 23%   16,83', '', 'Do zapłaty: 89,99 zł'],
    expect: { amount: '89.99', currency: 'PLN', date: '2025-08-11' },
  },
];

async function renderReceiptImage(page, lines, type) {
  const rows = lines.map((l) => `<div>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;') || '&nbsp;'}</div>`).join('');
  await page.setContent(`<body style="margin:0;background:#cfc8bb;padding:40px">
    <div id="r" style="width:520px;background:#fbfaf6;padding:36px 30px;font:24px/1.5 'DejaVu Sans Mono',monospace;color:#222;white-space:pre;transform:rotate(-1deg);box-shadow:0 2px 8px #0003">${rows}</div></body>`);
  return page.locator('body').screenshot({ type, quality: type === 'jpeg' ? 85 : undefined });
}

async function textPdf(lines) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await fs.readFile(path.join(fontDir, 'DejaVuSans.ttf')), { subset: true });
  const page = doc.addPage([595, 842]);
  lines.forEach((line, i) => page.drawText(line, { x: 50, y: 780 - i * 22, size: 13, font }));
  return Buffer.from(await doc.save());
}

async function scannedPdf(png) {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png);
  const page = doc.addPage([img.width * 0.75, img.height * 0.75]);
  page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  return Buffer.from(await doc.save());
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipts-e2e-'));
const fixtures = await fs.mkdtemp(path.join(os.tmpdir(), 'receipts-fixtures-'));
const store = await openStore(dataDir);
const server = http.createServer(createApp(store));
await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
const port = server.address().port;
const lan = lanAddresses()[0] || '127.0.0.1';
const browser = await chromium.launch();
let failures = 0;

try {
  // Build the receipt files.
  const maker = await browser.newPage();
  const files = [];
  for (const r of RECEIPTS) {
    let bytes;
    if (r.textPdf) bytes = await textPdf(r.lines);
    else if (r.scanned) bytes = await scannedPdf(await renderReceiptImage(maker, r.lines, 'png'));
    else bytes = await renderReceiptImage(maker, r.lines, r.file.endsWith('.jpg') ? 'jpeg' : 'png');
    const file = path.join(fixtures, r.file);
    await fs.writeFile(file, bytes);
    files.push(file);
    if (shotsDir && !r.textPdf && !r.scanned) await fs.writeFile(path.join(shotsDir, `sample-${r.file}`), bytes);
  }
  await maker.close();

  // ---- Phone ----
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await phone.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('dialog', (d) => d.accept());

  const phoneUrl = `http://${lan}:${port}/`;
  console.log(`Phone opens ${phoneUrl}`);
  await page.goto(phoneUrl);
  await page.fill('[name=firstName]', 'Zsófia');
  await page.fill('[name=lastName]', 'Nagy-Țurcanu');
  await page.fill('[name=dob]', '1994-11-03');
  await page.fill('[name=email]', 'zsofia@example.com');
  await page.selectOption('[name=country]', 'Hungary');

  // Each file gets the language a user would pick for it.
  for (const [i, file] of files.entries()) {
    await page.selectOption('#default-lang', RECEIPTS[i].lang);
    await page.setInputFiles('#file-input', file);
  }
  const started = Date.now();
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.receipt')];
    return cards.length && cards.every((c) => c.dataset.state === 'done' || c.dataset.state === 'failed');
  }, null, { timeout: 300_000 });
  console.log(`Read ${files.length} receipts in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  const cards = await page.$$eval('.receipt', (els) => els.map((el) => {
    const [amount, date, vendor] = [...el.querySelectorAll('input')].map((i) => i.value);
    return { state: el.dataset.state, status: el.querySelector('.status').textContent, amount, currency: el.querySelector('.fields select').value, date, vendor };
  }));
  cards.forEach((card, i) => {
    const want = RECEIPTS[i].expect;
    const wrong = Object.keys(want).filter((k) => card[k] !== want[k]);
    if (wrong.length) failures += 1;
    console.log(`${wrong.length ? 'FAIL' : 'ok  '} ${RECEIPTS[i].file.padEnd(16)} amount=${card.amount} ${card.currency} date=${card.date} vendor="${card.vendor}"${wrong.length ? `  (expected ${JSON.stringify(want)})` : ''}`);
  });
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'phone-form.png'), fullPage: true });

  await page.click('#send');
  await page.waitForSelector('#done-view:not([hidden])', { timeout: 60_000 });
  console.log(`Phone: ${await page.textContent('#done-text')}`);
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'phone-done.png') });
  if (problems.length) {
    failures += 1;
    console.log('Phone console errors:\n  ' + problems.join('\n  '));
  }

  // The phone must not be able to open the admin view.
  const blocked = await page.goto(`http://${lan}:${port}/admin/`);
  console.log(`${blocked.status() === 403 || lan === '127.0.0.1' ? 'ok  ' : 'FAIL'} admin view from phone -> ${blocked.status()}`);

  // ---- Tablet admin ----
  const tablet = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const adminPage = await tablet.newPage();
  const adminProblems = [];
  adminPage.on('console', (m) => m.type() === 'error' && adminProblems.push(m.text()));
  adminPage.on('pageerror', (e) => adminProblems.push(e.message));
  await adminPage.goto(`http://localhost:${port}/admin/`);
  await adminPage.waitForSelector('table.users tbody tr');
  for (const [code, rate] of [['HUF', '395.5'], ['BGN', '1.95583'], ['TRY', '48.2'], ['PLN', '4.25']]) {
    await adminPage.fill(`.rate:has(span:text-is("${code}")) input`, rate);
  }
  await adminPage.click('text=Save settings');
  await adminPage.waitForFunction(() => document.querySelector('.tile.accent strong')?.textContent !== '40.91 EUR');
  console.log(`Admin group total: ${await adminPage.textContent('.tile.accent strong')}`);
  if (shotsDir) await adminPage.screenshot({ path: path.join(shotsDir, 'admin-overview.png'), fullPage: true });
  await adminPage.click('table.users tbody tr');
  await adminPage.waitForSelector('.admin-receipt');
  if (shotsDir) await adminPage.screenshot({ path: path.join(shotsDir, 'admin-participant.png'), fullPage: true });
  if (adminProblems.length) {
    failures += 1;
    console.log('Admin console errors:\n  ' + adminProblems.join('\n  '));
  }

  for (const url of ['/api/admin/export/documents.pdf', '/api/admin/export/summary.xlsx', '/api/admin/export/archive.zip']) {
    const res = await tablet.request.get(`http://localhost:${port}${url}`);
    const body = await res.body();
    console.log(`${res.ok() ? 'ok  ' : 'FAIL'} ${url} -> ${res.status()} ${body.length} bytes`);
    if (!res.ok()) failures += 1;
    if (shotsDir) await fs.writeFile(path.join(shotsDir, path.basename(url)), body);
  }
} finally {
  await browser.close();
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(fixtures, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} problem(s) found` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
