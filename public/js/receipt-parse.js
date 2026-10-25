// Turns the raw text of a receipt or invoice (from OCR or a PDF) into
// suggested values. Everything here is a best guess: the phone always shows
// the result to the user, who confirms or corrects it before submitting.
//
// Shared by the browser (phone page) and the Node tests, so it must stay
// dependency-free plain JavaScript.

// Lowercase, strip accents and fold letters OCR often confuses, so that
// "ÖSSZESEN", "osszesen" and "Összesen" all match the same keyword.
export function fold(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ł/g, 'l')
    .replace(/ı/g, 'i');
}

// Matches a keyword only as a whole word (JS \b does not understand Cyrillic).
function wordPattern(word) {
  const escaped = fold(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}])`, 'u');
}

const STRONG_TOTAL = [
  // English
  'grand total', 'total due', 'amount due', 'balance due', 'total to pay', 'total amount', 'amount paid', 'total paid',
  // Hungarian
  'fizetendő', 'végösszeg', 'fizetendő összeg', 'bruttó összesen',
  // Romanian
  'total de plată', 'total plată', 'de plată', 'total general',
  // Turkish
  'genel toplam', 'ödenecek tutar', 'toplam tutar', 'ödenecek',
  // Spanish
  'total a pagar', 'importe total', 'total factura', 'a pagar',
  // Polish
  'do zapłaty', 'razem do zapłaty', 'suma pln', 'kwota do zapłaty',
  // Bulgarian
  'общо за плащане', 'обща сума', 'сума за плащане', 'за плащане',
].map(wordPattern);

const GENERIC_TOTAL = [
  'total', 'sum', 'összesen', 'összeg', 'toplam', 'importe', 'suma', 'razem', 'ogółem', 'общо', 'сума', 'всичко',
].map(wordPattern);

// Lines that mention a total-like word but hold some other figure.
const NOT_TOTAL = [
  'subtotal', 'sub total', 'sub-total', 'vat', 'tax', 'net', 'netto', 'nettó', 'base', 'base imponible',
  'áfa', 'tva', 'kdv', 'iva', 'ptu', 'ддс', 'данъчна основа',
  'change', 'cash', 'tendered', 'rest', 'visszajáró', 'készpénz', 'numerar', 'para üstü', 'nakit',
  'cambio', 'entregado', 'efectivo', 'reszta', 'gotówka', 'ресто', 'в брой',
  'discount', 'kedvezmény', 'reducere', 'indirim', 'descuento', 'rabat', 'отстъпка',
].map(wordPattern);

const CURRENCY_PATTERNS = {
  EUR: ['€', 'eur', 'euro', 'евро'],
  HUF: ['ft', 'huf', 'forint'],
  RON: ['lei', 'ron'],
  TRY: ['₺', 'tl', 'türk lirası'],
  PLN: ['zł', 'pln'],
  BGN: ['лв', 'лева', 'bgn'],
  GBP: ['£', 'gbp'],
  USD: ['$', 'usd'],
  CHF: ['chf'],
  CZK: ['kč', 'czk'],
};
const CURRENCY_REGEXES = Object.entries(CURRENCY_PATTERNS).map(([code, words]) => [
  code,
  words.map((w) => (/^\p{L}/u.test(w) ? wordPattern(w) : new RegExp(w.replace(/[$]/g, '\\$'), 'u'))),
]);

const DOCUMENT_WORDS = [
  'receipt', 'invoice', 'tax invoice', 'ticket', 'welcome', 'bon fiscal', 'factura', 'factură', 'nyugta', 'számla',
  'fiş', 'fiş no', 'fatura', 'bienvenido', 'paragon', 'paragon fiskalny', 'faktura', 'фактура', 'касова бележка',
  'фискален бон', 'бон',
].map(wordPattern);

const DATE_YMD = /(?<!\d)(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\.?(?!\d)/g;
const DATE_DMY = /(?<!\d)(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4}|\d{2})(?!\d)/g;
const TIME = /(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)/g;
const PERCENT = /\d+(?:[.,]\d+)?\s?%/g;
const AMOUNT = /(?<![\d.,])(\d{1,3}(?:[ \u00a0\u202f.,']\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?!\d)/g;

// "1.234,56", "1,234.56", "12 340", "45,9" -> numbers. Returns null if unusable.
export function parseAmount(token) {
  let s = String(token).replace(/[\s\u00a0\u202f']/g, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    s = s.split(thousands).join('').replace(decimal, '.');
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? '.' : ',';
    const parts = s.split(sep);
    if (parts.length > 2 || parts[parts.length - 1].length === 3) {
      s = parts.join(''); // only thousands separators
    } else {
      s = parts.join('.');
    }
  }
  const value = Number(s);
  return Number.isFinite(value) ? value : null;
}

function validDate(y, m, d) {
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  const now = new Date();
  if (y < 2000 || date.getTime() > now.getTime() + 2 * 86400000) return null;
  return date.toISOString().slice(0, 10);
}

export function findDate(text) {
  const found = [];
  for (const m of text.matchAll(DATE_YMD)) {
    const iso = validDate(+m[1], +m[2], +m[3]);
    if (iso) found.push({ index: m.index, iso });
  }
  for (const m of text.matchAll(DATE_DMY)) {
    // Day first: none of the target countries writes month first.
    const iso = validDate(+m[3], +m[2], +m[1]);
    if (iso) found.push({ index: m.index, iso });
  }
  found.sort((a, b) => a.index - b.index);
  return found.length ? found[0].iso : null;
}

function amountsIn(line) {
  const cleaned = line
    .replace(DATE_YMD, ' ')
    .replace(DATE_DMY, ' ')
    .replace(TIME, ' ')
    .replace(PERCENT, ' ');
  const values = [];
  for (const m of cleaned.matchAll(AMOUNT)) {
    const value = parseAmount(m[1]);
    if (value !== null) values.push({ value, hasDecimals: /[.,]\d{1,2}$/.test(m[1]) });
  }
  return values;
}

export function findCurrency(text) {
  const folded = fold(text);
  let best = null;
  for (const [code, regexes] of CURRENCY_REGEXES) {
    let count = 0;
    for (const re of regexes) {
      count += (folded.match(new RegExp(re.source, 'gu')) || []).length;
    }
    if (count > 0 && (!best || count > best.count)) best = { code, count };
  }
  return best ? best.code : null;
}

function findTotal(lines) {
  const candidates = [];
  lines.forEach((line, i) => {
    const folded = fold(line);
    let score = 0;
    if (STRONG_TOTAL.some((re) => re.test(folded))) score = 3;
    else if (GENERIC_TOTAL.some((re) => re.test(folded))) score = 2;
    if (!score || NOT_TOTAL.some((re) => re.test(folded))) return;

    let amounts = amountsIn(line);
    let source = line;
    // Some layouts put the figure on the line below the label.
    for (let j = i + 1; !amounts.length && j <= i + 2 && j < lines.length; j++) {
      amounts = amountsIn(lines[j]);
      source = `${line} ${lines[j]}`;
    }
    if (!amounts.length) return;
    // The figure for the label is normally the rightmost on the line.
    const { value } = amounts[amounts.length - 1];
    if (value > 0) candidates.push({ value, score, source });
  });
  if (!candidates.length) return null;
  const top = Math.max(...candidates.map((c) => c.score));
  // Among equally good labels the largest figure wins (cards, rounding, etc. repeat it).
  return candidates
    .filter((c) => c.score === top)
    .reduce((a, b) => (b.value > a.value ? b : a));
}

function findVendor(lines) {
  for (const line of lines.slice(0, 6)) {
    const letters = (line.match(/\p{L}/gu) || []).length;
    if (letters < 3 || letters < line.replace(/\s/g, '').length / 2) continue;
    if (DOCUMENT_WORDS.some((re) => re.test(fold(line)) && fold(line).replace(re, '').trim().length < 3)) continue;
    const cleaned = line.replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.)]+$/gu, '').trim();
    if (cleaned.length >= 3) return cleaned.slice(0, 80);
  }
  return null;
}

// Main entry point. `hints.currency` is the fallback when the text shows none.
export function parseReceipt(text, hints = {}) {
  const normalized = String(text || '').normalize('NFC');
  const lines = normalized.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let amount = null;
  let confidence = 'none';
  let currency = null;
  const total = findTotal(lines);
  if (total) {
    amount = total.value;
    confidence = 'high';
    currency = findCurrency(total.source);
  } else {
    // No total label: fall back to the largest figure with decimals.
    const all = lines.flatMap(amountsIn).filter((a) => a.hasDecimals && a.value > 0);
    if (all.length) {
      amount = Math.max(...all.map((a) => a.value));
      confidence = 'low';
    }
  }

  return {
    amount,
    confidence,
    currency: currency || findCurrency(normalized) || hints.currency || null,
    date: findDate(normalized),
    vendor: findVendor(lines),
  };
}
