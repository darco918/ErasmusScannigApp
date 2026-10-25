// Draws the "Travel costs reimbursement form": one A4 page per participant,
// laid out like the organisation's template (positions measured from it, in
// PDF points from the top of the page). Each accepted receipt is one row.

import fontkit from '@pdf-lib/fontkit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import { BASE_CURRENCY } from './config.js';
import { formatMoney, userSummary } from './money.js';

// Liberation Sans has the same metrics as Arial (the template's font) and
// covers Hungarian, Romanian, Turkish, Polish and Cyrillic letters.
const FONT_DIR = path.join(import.meta.dirname, '..', 'assets', 'fonts');
let fontBytes;
async function loadFonts() {
  fontBytes ??= Promise.all([
    fs.readFile(path.join(FONT_DIR, 'LiberationSans-Regular.ttf')),
    fs.readFile(path.join(FONT_DIR, 'LiberationSans-Bold.ttf')),
  ]);
  return fontBytes;
}

const PAGE = { width: 596, height: 842 };
const LEFT = 72.4;
const SIZE = 7; // body text size used throughout the template
const ASCENT = 0.905; // Arial ascent, to turn "top of text" into a baseline
const COLS = [72.4, 104.4, 169.4, 220.4, 294.4, 346.4, 425.4, 517.4];
const TABLE = { top: 153.4, headerBottom: 201.4, bodyBottom: 635.4, totalBottom: 659.4, ratesBottom: 684.4 };
const TEMPLATE_ROWS = 13;
const LINE = 0.75;
const BLACK = rgb(0, 0, 0);
const RED = rgb(0.75, 0.1, 0.1);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

// "10-18 August 2026", "28 July - 3 August 2026", "29 December 2026 - 4 January 2027".
export function formatEventDates(start, end) {
  if (!start || !end) return '';
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  if (sy === ey && sm === em) return sd === ed ? `${sd} ${MONTHS[sm - 1]} ${sy}` : `${sd}-${ed} ${MONTHS[em - 1]} ${ey}`;
  if (sy === ey) return `${sd} ${MONTHS[sm - 1]} - ${ed} ${MONTHS[em - 1]} ${ey}`;
  return `${sd} ${MONTHS[sm - 1]} ${sy} - ${ed} ${MONTHS[em - 1]} ${ey}`;
}

function fit(text, font, size, width) {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let s = text;
  while (s.length && font.widthOfTextAtSize(`${s}…`, size) > width) s = s.slice(0, -1);
  return `${s}…`;
}

function drawForm(doc, fonts, project, user) {
  const { regular, bold } = fonts;
  const page = doc.addPage([PAGE.width, PAGE.height]);
  const Y = (top) => PAGE.height - top; // template coordinates are measured from the top
  const write = (text, x, top, { font = regular, size = SIZE, color = BLACK } = {}) =>
    page.drawText(text, { x, y: Y(top + size * ASCENT), size, font, color });
  const hline = (top, x1 = COLS[0], x2 = COLS[COLS.length - 1]) =>
    page.drawLine({ start: { x: x1, y: Y(top) }, end: { x: x2, y: Y(top) }, thickness: LINE });
  const vline = (x, top, bottom) => page.drawLine({ start: { x, y: Y(top) }, end: { x, y: Y(bottom) }, thickness: LINE });

  const summary = userSummary(user, project.rates);
  const rows = summary.receipts.filter((r) => r.status === 'accepted');

  // Heading
  const title = 'Travel costs reimbursement form';
  write(title, (PAGE.width - bold.widthOfTextAtSize(title, 10)) / 2, 72.3, { font: bold, size: 10 });
  const labelled = (label, value, top, valueFont = regular) => {
    write(label, 72, top, { font: bold });
    write(fit(value, valueFont, SIZE, 440), 72 + bold.widthOfTextAtSize(`${label} `, SIZE), top, { font: valueFont });
  };
  labelled('Name:', `${user.firstName} ${user.lastName}`, 86);
  labelled('Country:', user.country, 105.3);
  labelled('Event and dates:', `“${project.title}”, ${formatEventDates(project.startDate, project.endDate)}`, 124.7, bold);
  labelled('Project:', project.projectNumber, 134.3, bold);

  // Table grid
  const count = Math.max(TEMPLATE_ROWS, rows.length);
  const rowHeight = (TABLE.bodyBottom - TABLE.headerBottom) / count; // shrinks to keep one page
  hline(TABLE.top);
  hline(TABLE.headerBottom);
  for (let i = 1; i <= count; i++) hline(TABLE.headerBottom + i * rowHeight);
  hline(TABLE.totalBottom);
  hline(TABLE.ratesBottom);
  for (const x of COLS) vline(x, TABLE.top, TABLE.bodyBottom);
  for (const x of [COLS[0], COLS[6], COLS[7]]) vline(x, TABLE.bodyBottom, TABLE.ratesBottom);

  // Column titles
  const headers = ['No.', 'From', 'To', 'Means of transport', 'Dates', ['Price in currency', 'other than EUR'], 'Price in EUR'];
  headers.forEach((h, i) => {
    [].concat(h).forEach((line, n) => write(line, COLS[i] + 1.5, 154.4 + n * 9.7, { font: bold }));
  });

  // One row per receipt. Text shrinks with the rows when there are more than 13.
  const size = Math.min(SIZE, (rowHeight - 3) / 2.3);
  const lead = size * 1.2;
  rows.forEach((r, i) => {
    const top = TABLE.headerBottom + i * rowHeight;
    write(String(i + 1), COLS[0] + 1.5, top + 1, { size });
    const cell = (col, lines, align = 'left', color = BLACK) => {
      const width = COLS[col + 1] - COLS[col] - 4;
      const block = lines.filter(Boolean).map((l) => fit(l, regular, size, width));
      const start = top + (rowHeight - block.length * lead) / 2 + (lead - size) / 2;
      block.forEach((line, n) => {
        const x = align === 'right' ? COLS[col + 1] - 2 - regular.widthOfTextAtSize(line, size) : COLS[col] + 2;
        write(line, x, start + n * lead, { size, color });
      });
    };
    cell(1, [r.fromCity, r.fromCountry]);
    cell(2, [r.toCity, r.toCountry]);
    cell(3, [r.transport]);
    cell(4, [formatDate(r.date)]);
    if (r.currency !== BASE_CURRENCY) cell(5, [`${formatMoney(r.amount)} ${r.currency}`], 'right');
    if (r.eur === null) cell(6, ['no rate'], 'right', RED);
    else cell(6, [formatMoney(r.eur)], 'right');
  });

  // Total and exchange rates rows
  write('Total 100%', 72, 636.1, { font: bold });
  const total = formatMoney(summary.sumEur);
  write(total, COLS[7] - 2 - bold.widthOfTextAtSize(total, SIZE), 636.1 + 8, { font: bold });

  write('Exchange rates', 72, 660.8, { font: bold });
  const used = [...new Set(rows.map((r) => r.currency).filter((c) => c !== BASE_CURRENCY))].sort();
  const rates = used.map((c) => (project.rates[c] ? `1 EUR = ${project.rates[c]} ${c}` : `${c}: no rate set`)).join('; ');
  if (rates) {
    const x = 72 + bold.widthOfTextAtSize('Exchange rates  ', SIZE);
    const space = COLS[6] - 2 - x;
    const rateSize = Math.max(5, Math.min(SIZE, (SIZE * space) / regular.widthOfTextAtSize(rates, SIZE)));
    write(fit(rates, regular, rateSize, space), x, 660.8 + (SIZE - rateSize) / 2, { size: rateSize });
  }

  // Confirmation, last day of the project, signature
  const amount = formatMoney(summary.totalEur);
  write(`I confirm that I have traveled to the above-mentioned destination and I am entitled to receive the reimbursement of ${amount} EUR.`, 72, 709.3);
  write(`Date ${formatDate(project.endDate)}`, 72, 728.7);
  write('Signature:', 72, 738.3);
}

// One PDF with a form for every given participant, one page each.
export async function renderDocuments(project, users) {
  const [regularBytes, boldBytes] = await loadFonts();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(users.length === 1 ? `Travel costs reimbursement form – ${users[0].firstName} ${users[0].lastName}` : `Travel costs reimbursement forms – ${project.title}`);
  const fonts = {
    regular: await doc.embedFont(regularBytes, { subset: true }),
    bold: await doc.embedFont(boldBytes, { subset: true }),
  };
  if (!users.length) {
    doc.addPage([PAGE.width, PAGE.height]).drawText('No participants yet.', { x: LEFT, y: PAGE.height - 80, size: 12, font: fonts.regular });
  }
  for (const user of users) drawForm(doc, fonts, project, user);
  return doc.save();
}
