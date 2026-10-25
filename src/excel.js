// Excel export. The sums are real formulas (with their values pre-filled),
// so the workbook still adds up if someone corrects a rate in Excel.

import ExcelJS from 'exceljs';
import { BASE_CURRENCY } from './config.js';
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

export async function renderWorkbook(users, rates) {
  const group = groupSummary(users, rates);
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  const summary = wb.addWorksheet('Summary');
  const detail = wb.addWorksheet('Receipts');
  const rateSheet = wb.addWorksheet('Rates');

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
    { header: 'User no.', key: 'user', width: 9 },
    { header: 'Last name', key: 'last', width: 16 },
    { header: 'First name', key: 'first', width: 16 },
    { header: 'Country', key: 'country', width: 11 },
    { header: 'Receipt no.', key: 'no', width: 11 },
    { header: 'Date', key: 'date', width: 12, style: { numFmt: DATE } },
    { header: 'Vendor', key: 'vendor', width: 28 },
    { header: 'Amount', key: 'amount', width: 12, style: { numFmt: MONEY } },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: `Rate (1 ${BASE_CURRENCY} =)`, key: 'rate', width: 14 },
    { header: `Amount ${BASE_CURRENCY}`, key: 'eur', width: 13, style: { numFmt: MONEY } },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Original file', key: 'file', width: 30 },
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
        vendor: r.vendor,
        amount: r.amount,
        currency: r.currency,
        status: r.status === 'accepted' ? 'Accepted' : 'Rejected',
        file: r.file.originalName,
      });
      const n = row.number;
      row.getCell('rate').value = { formula: `IFERROR(VLOOKUP(I${n},${rateRange},2,FALSE),"")`, result: r.rate ?? '' };
      row.getCell('eur').value = { formula: `IF(ISNUMBER(J${n}),ROUND(H${n}/J${n},2),"")`, result: r.eur ?? '' };
    }
  }
  styleHeader(detail);
  detail.autoFilter = { from: 'A1', to: 'M1' };
  const last = Math.max(detail.rowCount, 2);

  // Summary: one row per participant, group total at the bottom.
  summary.columns = [
    { header: 'User no.', key: 'no', width: 9 },
    { header: 'Last name', key: 'last', width: 16 },
    { header: 'First name', key: 'first', width: 16 },
    { header: 'Date of birth', key: 'dob', width: 13, style: { numFmt: DATE } },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Country', key: 'country', width: 11 },
    { header: 'Receipts', key: 'count', width: 10 },
    { header: `Total ${BASE_CURRENCY}`, key: 'total', width: 13, style: { numFmt: MONEY } },
    { header: 'Notes', key: 'notes', width: 34 },
  ];
  for (const s of group.perUser) {
    const row = summary.addRow({
      no: s.user.number,
      last: s.user.lastName,
      first: s.user.firstName,
      dob: asDate(s.user.dob),
      email: s.user.email,
      country: s.user.country,
      notes: s.missingRates.length ? `No rate for ${s.missingRates.join(', ')}; not in total` : '',
    });
    const n = row.number;
    row.getCell('count').value = { formula: `COUNTIFS(Receipts!$A$2:$A$${last},A${n},Receipts!$L$2:$L$${last},"Accepted")`, result: s.acceptedCount };
    row.getCell('total').value = {
      formula: `SUMIFS(Receipts!$K$2:$K$${last},Receipts!$A$2:$A$${last},A${n},Receipts!$L$2:$L$${last},"Accepted")`,
      result: s.totalEur,
    };
  }
  styleHeader(summary);
  const lastUser = summary.rowCount;
  const totalRow = summary.addRow({ last: 'Group total' });
  totalRow.font = { bold: true };
  const hasUsers = lastUser >= 2;
  totalRow.getCell('count').value = hasUsers ? { formula: `SUM(G2:G${lastUser})`, result: group.receiptCount } : 0;
  totalRow.getCell('total').value = hasUsers ? { formula: `SUM(H2:H${lastUser})`, result: group.totalEur } : 0;
  totalRow.getCell('total').numFmt = MONEY;
  totalRow.border = { top: { style: 'thin' } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
