import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createApp } from '../src/app.js';
import { lanAddresses } from '../src/network.js';
import { openStore } from '../src/store.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let server;
let base;
let dataDir;
let pdfBytes;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipts-test-'));
  const store = await openStore(dataDir);
  server = http.createServer(createApp(store));
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText('Hotel Example\nTotal 120.00 EUR', { x: 50, y: 700, font, size: 12 });
  pdfBytes = Buffer.from(await doc.save());
});

after(async () => {
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const admin = (url, init = {}) =>
  fetch(`${base}/api/admin${url}`, {
    ...init,
    headers: { 'X-Admin': '1', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });

function submission(overrides = {}, files = [['file0', PNG, 'photo.png'], ['file1', pdfBytes, 'hotel.pdf']]) {
  const data = {
    submissionId: `test-${Math.random().toString(36).slice(2)}`,
    firstName: 'Anna',
    lastName: 'Kovács',
    dob: '1990-04-12',
    email: 'Anna@example.com',
    country: 'Hungary',
    receipts: [
      { field: 'file0', amount: 12340, currency: 'HUF', date: '2025-04-02', vendor: 'MÁV-START' },
      { field: 'file1', amount: 120, currency: 'EUR', date: '2025-04-03', vendor: 'Hotel Example' },
    ],
    ...overrides,
  };
  const form = new FormData();
  form.append('data', JSON.stringify(data));
  for (const [name, bytes, filename] of files) form.append(name, new Blob([bytes]), filename);
  return { data, form };
}

let userId;

test('a phone can submit details with receipts', async () => {
  const { data, form } = submission();
  const res = await fetch(`${base}/api/submissions`, { method: 'POST', body: form });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.number, 1);
  assert.equal(body.receiptCount, 2);

  // A retry with the same submission id does not create a second participant.
  const retry = await fetch(`${base}/api/submissions`, { method: 'POST', body: submission(data).form });
  assert.equal((await retry.json()).duplicate, true);

  const state = await (await admin('/state')).json();
  assert.equal(state.users.length, 1);
  const user = state.users[0];
  userId = user.id;
  assert.equal(user.email, 'anna@example.com');
  assert.equal(user.receipts[0].file.mime, 'image/png');
  assert.equal(user.receipts[1].file.mime, 'application/pdf');

  // Originals are kept byte for byte.
  const original = await admin(`/users/${user.id}/receipts/${user.receipts[1].id}/file`);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), pdfBytes);
});

test('submissions are validated', async () => {
  const bad = await fetch(`${base}/api/submissions`, { method: 'POST', body: submission({ email: 'nope' }).form });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Email/);

  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const fake = await fetch(`${base}/api/submissions`, {
    method: 'POST',
    body: submission({}, [['file0', html, 'photo.jpg'], ['file1', pdfBytes, 'hotel.pdf']]).form,
  });
  assert.equal(fake.status, 400);
  assert.match((await fake.json()).error, /only photos/);

  const noFile = await fetch(`${base}/api/submissions`, { method: 'POST', body: submission({}, [['file0', PNG, 'a.png']]).form });
  assert.equal(noFile.status, 400);

  const state = await (await admin('/state')).json();
  assert.equal(state.users.length, 1);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')), []);
});

test('the admin view is refused from other devices and without the admin header', async () => {
  const ip = lanAddresses()[0];
  if (ip) {
    const res = await fetch(`http://${ip}:${server.address().port}/api/admin/state`);
    assert.equal(res.status, 403);
    const page = await fetch(`http://${ip}:${server.address().port}/admin/`);
    assert.equal(page.status, 403);
  }
  const spoofed = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/admin/state', headers: { Host: 'evil.example' } }, resolve);
  });
  assert.equal(spoofed.statusCode, 403);
  spoofed.resume();

  const noHeader = await fetch(`${base}/api/admin/settings`, { method: 'PUT', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(noHeader.status, 403);
});

test('rates, edits and rejections change the totals', async () => {
  let state = await (await admin('/state')).json();
  assert.deepEqual(state.totals.missingRates, ['HUF']);
  assert.equal(state.totals.totalEur, 120);

  state = await (await admin('/settings', { method: 'PUT', body: JSON.stringify({ rates: { HUF: '400', RON: '' } }) })).json();
  assert.equal(state.totals.totalEur, 150.85); // 12340 / 400 = 30.85
  assert.deepEqual(state.settings.rates, { HUF: 400 });

  const receipts = state.users[0].receipts;
  state = await (await admin(`/users/${userId}/receipts/${receipts[1].id}`, { method: 'PATCH', body: JSON.stringify({ amount: '110.5' }) })).json();
  assert.equal(state.totals.totalEur, 141.35);
  assert.equal(state.users[0].receipts[1].submitted.amount, 120);

  state = await (await admin(`/users/${userId}/receipts/${receipts[0].id}`, { method: 'PATCH', body: JSON.stringify({ status: 'rejected' }) })).json();
  assert.equal(state.totals.totalEur, 110.5);

  const badEdit = await admin(`/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ dob: '2999-01-01' }) });
  assert.equal(badEdit.status, 400);
  state = await (await admin(`/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ firstName: 'Anna Mária' }) })).json();
  assert.equal(state.users[0].firstName, 'Anna Mária');
});

test('exports: combined PDF, Excel with formulas, ZIP by country', async () => {
  // A second participant in another country.
  const second = submission({ firstName: 'Ion', lastName: 'Popescu', country: 'Romania', email: 'ion@example.com', receipts: [
    { field: 'file0', amount: 231.45, currency: 'RON', date: '2025-05-21', vendor: 'Petrom' },
  ] }, [['file0', PNG, 'bon.png']]);
  assert.equal((await fetch(`${base}/api/submissions`, { method: 'POST', body: second.form })).status, 201);
  await admin('/settings', { method: 'PUT', body: JSON.stringify({ rates: { HUF: 400, RON: 4.97 } }) });

  const pdf = await PDFDocument.load(await (await admin('/export/documents.pdf')).arrayBuffer());
  assert.equal(pdf.getPageCount(), 2);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await (await admin('/export/summary.xlsx')).arrayBuffer());
  const summary = wb.getWorksheet('Summary');
  assert.equal(summary.getCell('B2').value, 'Kovács');
  assert.match(summary.getCell('H2').value.formula, /^SUMIFS/);
  assert.equal(summary.getCell('H2').value.result, 110.5);
  assert.equal(summary.getCell('H3').value.result, 46.57); // 231.45 / 4.97
  assert.equal(summary.getCell('B4').value, 'Group total');
  assert.equal(summary.getCell('H4').value.result, 157.07);
  const receipts = wb.getWorksheet('Receipts');
  assert.equal(receipts.rowCount, 4);
  assert.equal(receipts.getCell('L2').value, 'Rejected');

  const zip = await JSZip.loadAsync(await (await admin('/export/archive.zip')).arrayBuffer());
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).map((n) => n.replace(/^receipts-[^/]+\//, '')).sort();
  assert.deepEqual(names, [
    'All documents.pdf',
    'Hungary/001 Kovács Anna Mária/02 hotel.pdf',
    'Hungary/001 Kovács Anna Mária/Document.pdf',
    'Hungary/001 Kovács Anna Mária/Rejected/01 photo.png',
    'Romania/002 Popescu Ion/01 bon.png',
    'Romania/002 Popescu Ion/Document.pdf',
    'Summary.xlsx',
  ]);
});

test('deleting a participant removes their files', async () => {
  const state = await (await admin(`/users/${userId}`, { method: 'DELETE' })).json();
  assert.equal(state.users.length, 1);
  await assert.rejects(fs.access(path.join(dataDir, 'uploads', userId)));
});
