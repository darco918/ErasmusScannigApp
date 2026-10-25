// Turns the raw text of a receipt or invoice (from OCR or a PDF) into
// suggested values. Everything here is a best guess: the phone always shows
// the result to the user, who confirms or corrects it before submitting.
//
// Shared by the browser (phone page) and the Node tests, so it must stay
// dependency-free plain JavaScript.

import { AIRPORTS, CITIES } from './places.js';

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

const DATE_YMD = /(?<!\d)(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\.?(?!\d)/g;
const DATE_DMY = /(?<!\d)(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4}|\d{2})(?!\d)/g;
const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = `(${MONTH_KEYS.join('|')})[a-z]*\\.?`;
const DATE_DAY_MONTH = new RegExp(`(?<!\\d)(\\d{1,2})\\s*${MONTH},?\\s*(\\d{4})?(?!\\d)`, 'g');
const DATE_MONTH_DAY = new RegExp(`(?<![a-z])${MONTH}\\s+(\\d{1,2}),?\\s+(\\d{4})(?!\\d)`, 'g');
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
  // Tickets for the journey home can be dated after the day of submission.
  if (y < 2000 || date.getTime() > now.getTime() + 400 * 86400000) return null;
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
  // "12 Aug 2026", "12AUG" (boarding passes), "Aug 12, 2026".
  const folded = fold(text);
  for (const m of folded.matchAll(DATE_DAY_MONTH)) {
    const iso = validDate(m[3] ? +m[3] : new Date().getFullYear(), MONTH_KEYS.indexOf(m[2]) + 1, +m[1]);
    if (iso) found.push({ index: m.index, iso });
  }
  for (const m of folded.matchAll(DATE_MONTH_DAY)) {
    const iso = validDate(+m[3], MONTH_KEYS.indexOf(m[1]) + 1, +m[2]);
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
    transport: findTransport(normalized),
    ...findRoute(normalized),
  };
}

// ---------- means of transport ----------

const TRANSPORT_WORDS = {
  PLANE: [
    'flight', 'flug', 'boarding pass', 'boarding', 'airline', 'airlines', 'airways', 'airport', 'aeroport', 'aeropuerto',
    'wizz', 'wizz air', 'ryanair', 'easyjet', 'lufthansa', 'tarom', 'pegasus', 'turkish airlines', 'aegean', 'lot polish',
    'bulgaria air', 'iberia', 'vueling', 'air europa', 'austrian', 'repülő', 'repülőjegy', 'repülőtér', 'zbor', 'uçuş',
    'havalimanı', 'vuelo', 'lotnisko', 'samolot', 'полет', 'летище', 'самолет', 'самолетен', 'uçak', 'uçağı', 'avión',
    'zborul', 'avion', 'lotu', 'samolotem', 'boarding-pass', 'бордна карта',
  ],
  TRAIN: [
    'train', 'rail', 'railway', 'railways', 'intercity', 'máv', 'mav-start', 'cfr', 'cfr călători', 'tcdd', 'renfe', 'pkp',
    'bdž', 'бдж', 'vonat', 'vasút', 'tren', 'pociąg', 'kolej', 'koleje', 'влак', 'ouigo', 'iryo', 'regiojet', 'öbb', 'yht',
    'polregio', 'interregio', 'pendolino', 'vonatjegy', 'trenul', 'pociągu', 'kolejowy', 'влакът', 'жп',
    'treni', 'tren bileti', 'ferrocarril',
  ],
  BUS: [
    'bus', 'coach', 'flixbus', 'autobus', 'busz', 'volánbusz', 'otobüs', 'autocar', 'alsa', 'автобус', 'autogara', 'otogar',
    'dworzec autobusowy', 'havaist', 'автогара', 'union ivkoni', 'автобусен', 'автобусна', 'автобусни', 'buszjegy',
    'autobuz', 'autobuzul', 'autobusowy', 'autobusu', 'otobüsü', 'autobús', 'autocares',
  ],
  CARPOOLING: ['blablacar', 'carpool', 'carpooling', 'covoiturage', 'ride share', 'rideshare'],
};
const TRANSPORT_REGEXES = Object.entries(TRANSPORT_WORDS).map(([mode, words]) => [mode, words.map(wordPattern)]);

export function findTransport(text) {
  const folded = fold(text);
  let best = null;
  for (const [mode, regexes] of TRANSPORT_REGEXES) {
    const hits = regexes.filter((re) => re.test(folded)).length;
    if (hits && (!best || hits > best.hits)) best = { mode, hits };
  }
  return best ? best.mode : null;
}

// ---------- from / to ----------

const CITY_PATTERNS = CITIES.flatMap(([city, country, ...aliases]) =>
  [city, ...aliases].map((name) => ({ re: new RegExp(wordPattern(name).source, 'gu'), city, country })),
);
const CITY_BY_NAME = new Map(CITIES.map(([city, country]) => [city, country]));
const AIRPORT_PAIR = /(?<![A-Z])([A-Z]{3})\s*(?:-+|–|—|→|->|>|\/|to)\s*([A-Z]{3})(?![A-Z])/g;
// What may stand between two cities for them to read as "from - to".
const ROUTE_GAP = /^[ \t]*(?:-+>?|–|—|→|=>|>|\/|to|a|la|do|до|nach|hacia|spre)?[ \t]*$/u;

function cityMentions(folded) {
  const found = [];
  for (const { re, city, country } of CITY_PATTERNS) {
    for (const m of folded.matchAll(re)) found.push({ start: m.index, end: m.index + m[0].length, city, country });
  }
  // Longest name wins where two overlap ("Palma de Mallorca" over "Palma").
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  return found.filter((m, i) => !found.slice(0, i).some((o) => o.start <= m.start && o.end >= m.end && o !== m));
}

function route(from, to) {
  return { fromCity: from.city, fromCountry: from.country, toCity: to.city, toCountry: to.country };
}

export function findRoute(text) {
  // 1. Airport codes written as a pair: "SOF - BUD".
  for (const m of String(text).matchAll(AIRPORT_PAIR)) {
    const [from, to] = [AIRPORTS[m[1]], AIRPORTS[m[2]]];
    if (from && to && from !== to) {
      return route({ city: from, country: CITY_BY_NAME.get(from) }, { city: to, country: CITY_BY_NAME.get(to) });
    }
  }
  const folded = fold(text);
  const mentions = cityMentions(folded);
  // 2. Two cities joined by a dash, arrow or "to": "Budapest - Sofia".
  for (let i = 0; i + 1 < mentions.length; i++) {
    const [a, b] = [mentions[i], mentions[i + 1]];
    if (a.city !== b.city && ROUTE_GAP.test(folded.slice(a.end, b.start))) return route(a, b);
  }
  // 3. Otherwise the first two different cities, in reading order.
  const second = mentions.find((m) => mentions.length && m.city !== mentions[0].city);
  if (second) return route(mentions[0], second);
  return { fromCity: null, fromCountry: null, toCity: null, toCountry: null };
}
