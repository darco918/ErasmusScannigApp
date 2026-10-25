// Builds the printable claim document for each participant.
//
// PLACEHOLDER LAYOUT: replace `drawUser` with the real template once it is
// supplied. Everything else (fonts, one combined file, page breaks) stays.

import fontkit from '@pdf-lib/fontkit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import { BASE_CURRENCY } from './config.js';
import { formatMoney, userSummary } from './money.js';

// DejaVu covers Latin with all Central/Eastern European accents and Cyrillic,
// which the built-in PDF fonts do not.
const FONT_DIR = path.join(import.meta.dirname, '..', 'node_modules', 'dejavu-fonts-ttf', 'ttf');
let fontBytes;
async function loadFonts() {
  fontBytes ??= Promise.all([
    fs.readFile(path.join(FONT_DIR, 'DejaVuSans.ttf')),
    fs.readFile(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')),
  ]);
  return fontBytes;
}

const PAGE = { width: 595.28, height: 841.89, margin: 50 };
const GREY = rgb(0.4, 0.4, 0.4);
const LIGHT = rgb(0.85, 0.85, 0.85);
const RED = rgb(0.7, 0.1, 0.1);

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

function fit(text, font, size, width) {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let s = text;
  while (s.length && font.widthOfTextAtSize(`${s}…`, size) > width) s = s.slice(0, -1);
  return `${s}…`;
}

// Column layout of the receipts table: [title, width, align, gap after].
const COLUMNS = [
  ['No.', 30, 'left'],
  ['Date', 62, 'left'],
  ['Vendor', 158, 'left'],
  ['Amount', 70, 'right', 8],
  ['Cur.', 34, 'left'],
  [`Rate (1 ${BASE_CURRENCY} =)`, 76, 'right'],
  [BASE_CURRENCY, 65, 'right'],
];

function drawUser(doc, fonts, user, rates) {
  const { regular, bold } = fonts;
  const summary = userSummary(user, rates);
  const accepted = summary.receipts.filter((r) => r.status === 'accepted');
  const pages = [];
  let page;
  let y;

  const text = (s, x, size = 10, font = regular, color = rgb(0, 0, 0)) => page.drawText(s, { x, y, size, font, color });

  function newPage() {
    page = doc.addPage([PAGE.width, PAGE.height]);
    pages.push(page);
    y = PAGE.height - PAGE.margin;
  }

  function tableHeader() {
    let x = PAGE.margin;
    for (const [title, width, align, gap = 0] of COLUMNS) {
      const w = bold.widthOfTextAtSize(title, 8.5);
      text(title, align === 'right' ? x + width - gap - w : x, 8.5, bold);
      x += width;
    }
    y -= 6;
    page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.width - PAGE.margin, y }, thickness: 0.8 });
    y -= 13;
  }

  newPage();
  text('Travel Expense Claim', PAGE.margin, 18, bold);
  y -= 18;
  text(`Participant no. ${user.number} · submitted ${formatDate(user.submittedAt)}`, PAGE.margin, 9, regular, GREY);
  y -= 30;

  for (const [label, value] of [
    ['Name', `${user.firstName} ${user.lastName}`],
    ['Date of birth', formatDate(user.dob)],
    ['Email', user.email],
    ['Country', user.country],
  ]) {
    text(label, PAGE.margin, 10, bold);
    text(fit(value, regular, 10, 360), PAGE.margin + 110, 10);
    y -= 17;
  }
  y -= 18;
  text('Receipts and invoices', PAGE.margin, 12, bold);
  y -= 20;
  tableHeader();

  for (const r of accepted) {
    if (y < PAGE.margin + 40) {
      newPage();
      tableHeader();
    }
    const cells = [
      String(r.number),
      formatDate(r.date),
      r.vendor || '',
      formatMoney(r.amount),
      r.currency,
      r.rate === null ? 'missing' : r.currency === BASE_CURRENCY ? '' : String(r.rate),
      r.eur === null ? '—' : formatMoney(r.eur),
    ];
    let x = PAGE.margin;
    cells.forEach((cell, i) => {
      const [, width, align, gap = 0] = COLUMNS[i];
      const s = fit(cell, regular, 9, width - 6 - gap);
      const color = r.rate === null && i >= 5 ? RED : rgb(0, 0, 0);
      text(s, align === 'right' ? x + width - gap - regular.widthOfTextAtSize(s, 9) : x, 9, regular, color);
      x += width;
    });
    y -= 6;
    page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.width - PAGE.margin, y }, thickness: 0.4, color: LIGHT });
    y -= 12;
  }
  if (!accepted.length) {
    text('No accepted receipts.', PAGE.margin, 9, regular, GREY);
    y -= 18;
  }

  // Total, declaration and signature are kept together on one page.
  if (y < PAGE.margin + 190) newPage();
  y -= 6;
  const totalLabel = `Total to reimburse (${BASE_CURRENCY})`;
  const totalValue = formatMoney(summary.totalEur);
  text(totalLabel, PAGE.margin, 12, bold);
  text(totalValue, PAGE.width - PAGE.margin - bold.widthOfTextAtSize(totalValue, 12), 12, bold);
  y -= 18;
  if (summary.missingRates.length) {
    text(`No exchange rate set for ${summary.missingRates.join(', ')}: those receipts are not in the total.`, PAGE.margin, 9, regular, RED);
    y -= 16;
  }
  y -= 30;
  text('I confirm that the expenses listed above were incurred by me for travel and have not been', PAGE.margin, 9.5);
  y -= 13;
  text('claimed elsewhere.', PAGE.margin, 9.5);
  y -= 55;
  for (const [label, x] of [['Signature', PAGE.margin], ['Date', PAGE.margin + 300]]) {
    page.drawLine({ start: { x, y }, end: { x: x + 200, y }, thickness: 0.8 });
    page.drawText(label, { x, y: y - 13, size: 9, font: regular, color: GREY });
  }

  pages.forEach((p, i) => {
    const footer = `${user.firstName} ${user.lastName} · page ${i + 1} of ${pages.length}`;
    p.drawText(footer, { x: PAGE.margin, y: 28, size: 8, font: regular, color: GREY });
    const note = 'Placeholder layout';
    p.drawText(note, { x: PAGE.width - PAGE.margin - regular.widthOfTextAtSize(note, 8), y: 28, size: 8, font: regular, color: GREY });
  });
}

// One PDF containing every given user, each starting on a new page.
export async function renderDocuments(users, rates) {
  const [regularBytes, boldBytes] = await loadFonts();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(users.length === 1 ? `Travel expense claim – ${users[0].firstName} ${users[0].lastName}` : 'Travel expense claims');
  const fonts = {
    regular: await doc.embedFont(regularBytes, { subset: true }),
    bold: await doc.embedFont(boldBytes, { subset: true }),
  };
  if (!users.length) {
    doc.addPage([PAGE.width, PAGE.height]).drawText('No participants yet.', { x: PAGE.margin, y: PAGE.height - PAGE.margin, size: 12, font: fonts.regular });
  }
  for (const user of users) drawUser(doc, fonts, user, rates);
  return doc.save();
}
