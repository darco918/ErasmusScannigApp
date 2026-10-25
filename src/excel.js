// Excel export for one project. The sums are real formulas (with their values
// pre-filled), so the workbook still adds up if someone corrects a rate in Excel.

import ExcelJS from 'exceljs';
import { BASE_CURRENCY } from './config.js';
import { formatEventDates } from './documents.js';
import { groupSummary } from './money.js';

const MONEY = '#,##0.00';
const DATE = 'dd.mm.yyyy';

function asDate(iso) {
  return iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`) : null;
}

function styleHeader(sheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function place(city, country) {
  return [city, country].filter(Boolean).join(', ');
}

export async function renderWorkbook(project, users) {
  const rates = project.rates;
  const group = groupSummary(users, rates);
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  const summary = wb.addWorksheet('Summary');
  const detail = wb.addWorksheet('Receipts');
  const rateSheet = wb.addWorksheet('Rates');
  const info = wb.addWorksheet('Project');

  info.columns = [{ key: 'label', width: 18 }, { key: 'value', width: 50 }];
  for (const [label, value] of [
    ['Project', project.title],
    ['Project number', project.projectNumber],
    ['Dates', formatEventDates(project.startDate, project.endDate)],
    ['Host country', project.hostCountry],
    ['Exported', new Date().toLocaleString('en-GB')],
  ]) {
    info.addRow({ label, value }).getCell('label').font = { bold: true };
  }

  // Rates: every currency in use or configured.
  rateSheet.columns = [
    { header: 'Currency', key: 'currency', width: 12 },
    { header: `1 ${BASE_CURRENCY} =`, key: 'rate', width: 14 },
  ];
  const currencies = new Set([BASE_CURRENCY, ...Object.keys(rates)]);
  for (const u of users) for (const r of u.receipts) currencies.add(r.currency);
  for (const code of [...currencies].sort((a, b) => (a === BASE_CURRENCY ? -1 : b === BASE_CURRENCY ? 1 : a.localeCompare(b)))) {
    rateSheet.addRow({ currency: code, rate: code === BASE_CURRENCY ? 1 : rates[code] ?? null });
  }
  styleHeader(rateSheet);
  const rateRange = `Rates!$A$2:$B$${rateSheet.rowCount}`;

  // Receipts: one row per receipt, rejected ones included but not counted.
  detail.columns = [
    { header: 'User no.', key: 'user', width: 9 }, // A
    { header: 'Last name', key: 'last', width: 16 }, // B
    { header: 'First name', key: 'first', width: 16 }, // C
    { header: 'Country', key: 'country', width: 11 }, // D
    { header: 'Receipt no.', key: 'no', width: 11 }, // E
    { header: 'Date', key: 'date', width: 12, style: { numFmt: DATE } }, // F
    { header: 'From', key: 'from', width: 22 }, // G
    { header: 'To', key: 'to', width: 22 }, // H
    { header: 'Transport', key: 'transport', width: 13 }, // I
    { header: 'Amount', key: 'amount', width: 12, style: { numFmt: MONEY } }, // J
    { header: 'Currency', key: 'currency', width: 10 }, // K
    { header: `Rate (1 ${BASE_CURRENCY} =)`, key: 'rate', width: 14 }, // L
    { header: `Amount ${BASE_CURRENCY}`, key: 'eur', width: 13, style: { numFmt: MONEY } }, // M
    { header: 'Status', key: 'status', width: 10 }, // N
    { header: 'Original file', key: 'file', width: 30 }, // O
  ];
  for (const s of group.perUser) {
    for (const r of s.receipts) {
      const row = detail.addRow({
        user: s.user.number,
        last: s.user.lastName,
        first: s.user.firstName,
        country: s.user.country,
        no: r.number,
        date: asDate(r.date),
        from: place(r.fromCity, r.fromCountry),
        to: place(r.toCity, r.toCountry),
        transport: r.transport || '',
        amount: r.amount,
        currency: r.currency,
        status: r.status === 'accepted' ? 'Accepted' : 'Rejected',
        file: r.file.originalName,
      });
      const n = row.number;
      row.getCell('rate').value = { formula: `IFERROR(VLOOKUP(K${n},${rateRange},2,FALSE),"")`, result: r.rate ?? '' };
      row.getCell('eur').value = { formula: `IF(ISNUMBER(L${n}),ROUND(J${n}/L${n},2),"")`, result: r.eur ?? '' };
    }
  }
  styleHeader(detail);
  detail.autoFilter = { from: 'A1', to: 'O1' };
  const last = Math.max(detail.rowCount, 2);

  // Summary: one row per participant, group total at the bottom.
  summary.columns = [
    { header: 'User no.', key: 'no', width: 9 }, // A
    { header: 'Last name', key: 'last', width: 16 }, // B
    { header: 'First name', key: 'first', width: 16 }, // C
    { header: 'Date of birth', key: 'dob', width: 13, style: { numFmt: DATE } }, // D
    { header: 'Email', key: 'email', width: 28 }, // E
    { header: 'Country', key: 'country', width: 11 }, // F
    { header: 'Receipts', key: 'count', width: 10 }, // G
    { header: `Sum ${BASE_CURRENCY}`, key: 'sum', width: 13, style: { numFmt: MONEY } }, // H
    { header: `Cap ${BASE_CURRENCY}`, key: 'cap', width: 11, style: { numFmt: MONEY } }, // I
    { header: `Reimbursed ${BASE_CURRENCY}`, key: 'total', width: 16, style: { numFmt: MONEY } }, // J
    { header: 'Notes', key: 'notes', width: 34 }, // K
  ];
  for (const s of group.perUser) {
    const row = summary.addRow({
      no: s.user.number,
      last: s.user.lastName,
      first: s.user.firstName,
      dob: asDate(s.user.dob),
      email: s.user.email,
      country: s.user.country,
      cap: s.capEur,
      notes: s.missingRates.length ? `No rate for ${s.missingRates.join(', ')}; not in total` : '',
    });
    const n = row.number;
    const mine = `Receipts!$A$2:$A$${last},A${n},Receipts!$N$2:$N$${last},"Accepted"`;
    row.getCell('count').value = { formula: `COUNTIFS(${mine})`, result: s.acceptedCount };
    row.getCell('sum').value = { formula: `SUMIFS(Receipts!$M$2:$M$${last},${mine})`, result: s.sumEur };
    row.getCell('total').value = { formula: `IF(ISNUMBER(I${n}),MIN(H${n},I${n}),H${n})`, result: s.totalEur };
  }
  styleHeader(summary);
  const lastUser = summary.rowCount;
  const totalRow = summary.addRow({ last: 'Group total' });
  totalRow.font = { bold: true };
  const hasUsers = lastUser >= 2;
  const sum = (col, result) => (hasUsers ? { formula: `SUM(${col}2:${col}${lastUser})`, result } : 0);
  totalRow.getCell('count').value = sum('G', group.receiptCount);
  totalRow.getCell('sum').value = sum('H', group.perUser.reduce((a, s) => a + s.sumEur, 0));
  totalRow.getCell('total').value = sum('J', group.totalEur);
  totalRow.border = { top: { style: 'thin' } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
