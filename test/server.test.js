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
let cookie = '';
let dataDir;
let pdfBytes;

async function startServer(dir) {
  const store = await openStore(dir);
  const s = http.createServer(createApp(store));
  await new Promise((resolve) => s.listen(0, '0.0.0.0', resolve));
  return s;
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipts-test-'));
  server = await startServer(dataDir);
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
    headers: { 'X-Admin': '1', Cookie: cookie, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });

async function unlock(pin = '080900') {
  const res = await fetch(`${base}/api/admin/unlock`, {
    method: 'POST',
    headers: { 'X-Admin': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (res.ok) cookie = res.headers.get('set-cookie').split(';')[0];
  return res;
}
const json = async (res) => {
  const body = await res.json();
  assert.ok(res.ok, `${res.status}: ${JSON.stringify(body)}`);
  return body;
};
const send = (method, url, body) => admin(url, { method, body: body && JSON.stringify(body) });

const journey = {
  date: '2026-08-09',
  transport: 'TRAIN',
  fromCity: 'Budapest',
  fromCountry: 'Hungary',
  toCity: 'Sofia',
  toCountry: 'Bulgaria',
};

function submission(projectId, overrides = {}, files = [['file0', PNG, 'photo.png'], ['file1', pdfBytes, 'hotel.pdf']]) {
  const data = {
    submissionId: `test-${Math.random().toString(36).slice(2)}`,
    projectId,
    firstName: 'Anna',
    lastName: 'Kovács',
    dob: '1990-04-12',
    email: 'Anna@example.com',
    country: 'Hungary',
    receipts: [
      { field: 'file0', amount: 12340, currency: 'HUF', ...journey },
      { field: 'file1', amount: 120, currency: 'EUR', ...journey, transport: 'BUS' },
    ],
    ...overrides,
  };
  const form = new FormData();
  form.append('data', JSON.stringify(data));
  for (const [name, bytes, filename] of files) form.append(name, new Blob([bytes]), filename);
  return { data, form };
}
const post = (form) => fetch(`${base}/api/submissions`, { method: 'POST', body: form });

const PROJECT = {
  title: 'Taste of the Balkans',
  projectNumber: 'No2026-1-BG01-KA151-YOU-000391902',
  startDate: '2026-08-10',
  endDate: '2026-08-18',
  hostCountry: 'Bulgaria',
};

let projectId;
let userId;

test('the admin view needs the PIN', async () => {
  assert.equal((await admin('/overview')).status, 401);
  assert.deepEqual(await (await admin('/session')).json(), { unlocked: false });
  const wrong = await unlock('123456');
  assert.equal(wrong.status, 401);
  assert.match((await wrong.json()).error, /Wrong PIN. 4 attempts left/);
  assert.equal((await unlock()).status, 200);
  assert.deepEqual(await (await admin('/session')).json(), { unlocked: true });
  assert.equal((await admin('/overview')).status, 200);

  // Locking ends the session.
  await admin('/lock', { method: 'POST' });
  assert.equal((await admin('/overview')).status, 401);
  await unlock();
});

test('too many wrong PINs lock the screen for a while', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipts-pin-'));
  const s = http.createServer(createApp(await openStore(dir), { pin: '4321' }));
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const tryPin = (pin) => fetch(`http://127.0.0.1:${s.address().port}/api/admin/unlock`, {
    method: 'POST', headers: { 'X-Admin': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
  });
  try {
    for (let i = 0; i < 4; i++) assert.equal((await tryPin('0000')).status, 401);
    assert.equal((await tryPin('0000')).status, 429);
    assert.equal((await tryPin('4321')).status, 429, 'even the right PIN waits until the lock ends');
  } finally {
    s.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('before a project exists, phones are told to wait', async () => {
  const config = await json(await fetch(`${base}/api/config`));
  assert.equal(config.project, null);
  const res = await post(submission('x').form);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not started a project/);
});

test('the admin creates the first project; it becomes active', async () => {
  const bad = await send('POST', '/projects', { ...PROJECT, endDate: '2026-08-01' });
  assert.equal(bad.status, 400);

  projectId = (await json(await send('POST', '/projects', PROJECT))).id;
  const overview = await json(await admin('/overview'));
  assert.equal(overview.activeProjectId, projectId);
  const config = await json(await fetch(`${base}/api/config`));
  assert.equal(config.project.title, 'Taste of the Balkans');
  assert.deepEqual(config.project.routeCountries, ['Bulgaria', 'Hungary', 'Poland', 'Romania', 'Spain', 'Turkey', 'Other']);
});

test('a phone can submit details with receipts', async () => {
  const { data, form } = submission(projectId);
  const res = await post(form);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.number, 1);
  assert.equal(body.receiptCount, 2);

  // A retry with the same submission id does not create a second participant.
  const retry = await post(submission(projectId, data).form);
  assert.equal((await retry.json()).duplicate, true);

  const state = await json(await admin(`/projects/${projectId}`));
  assert.equal(state.users.length, 1);
  const user = state.users[0];
  userId = user.id;
  assert.equal(user.email, 'anna@example.com');
  assert.equal(user.receipts[0].fromCity, 'Budapest');
  assert.equal(user.receipts[1].transport, 'BUS');

  // Originals are kept byte for byte.
  const original = await admin(`/projects/${projectId}/users/${user.id}/receipts/${user.receipts[1].id}/file`);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), pdfBytes);
});

test('submissions are validated', async () => {
  const expectError = async (form, pattern) => {
    const res = await post(form);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, pattern);
  };
  await expectError(submission(projectId, { email: 'nope' }).form, /Email/);
  await expectError(submission('old-project').form, /changed the project/);
  await expectError(
    submission(projectId, { receipts: [{ field: 'file0', amount: 10, currency: 'EUR', ...journey, transport: '' }] }, [['file0', PNG, 'a.png']]).form,
    /means of transport/,
  );
  await expectError(
    submission(projectId, { receipts: [{ field: 'file0', amount: 10, currency: 'EUR', ...journey, toCity: '' }] }, [['file0', PNG, 'a.png']]).form,
    /To city/,
  );
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  await expectError(submission(projectId, {}, [['file0', html, 'photo.jpg'], ['file1', pdfBytes, 'hotel.pdf']]).form, /only photos/);

  const state = await json(await admin(`/projects/${projectId}`));
  assert.equal(state.users.length, 1);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')), []);
});

test('the admin view is refused from other devices and without the admin header', async () => {
  const ip = lanAddresses()[0];
  if (ip) {
    const res = await fetch(`http://${ip}:${server.address().port}/api/admin/overview`);
    assert.equal(res.status, 403);
    const page = await fetch(`http://${ip}:${server.address().port}/admin/`);
    assert.equal(page.status, 403);
  }
  const spoofed = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/admin/overview', headers: { Host: 'evil.example' } }, resolve);
  });
  assert.equal(spoofed.statusCode, 403);
  spoofed.resume();

  const noHeader = await fetch(`${base}/api/admin/projects`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(noHeader.status, 403);
});

test('rates, edits, rejections and a cap change the totals', async () => {
  let state = await json(await admin(`/projects/${projectId}`));
  assert.deepEqual(state.totals.missingRates, ['HUF']);
  assert.equal(state.totals.totalEur, 120);

  await json(await send('PUT', `/projects/${projectId}/rates`, { rates: { HUF: '400', RON: '' } }));
  state = await json(await admin(`/projects/${projectId}`));
  assert.equal(state.totals.totalEur, 150.85); // 12340 / 400 = 30.85
  assert.deepEqual(state.project.rates, { HUF: 400 });

  const receipts = state.users[0].receipts;
  await json(await send('PATCH', `/projects/${projectId}/users/${userId}/receipts/${receipts[1].id}`, { amount: '110.5', toCity: 'Plovdiv' }));
  state = await json(await admin(`/projects/${projectId}`));
  assert.equal(state.totals.totalEur, 141.35);
  assert.equal(state.users[0].receipts[1].toCity, 'Plovdiv');
  assert.equal(state.users[0].receipts[1].submitted.amount, 120);

  await json(await send('PATCH', `/projects/${projectId}/users/${userId}`, { capEur: '100' }));
  state = await json(await admin(`/projects/${projectId}`));
  assert.equal(state.users[0].sumEur, 141.35);
  assert.equal(state.users[0].totalEur, 100);
  assert.equal(state.users[0].capped, true);
  await json(await send('PATCH', `/projects/${projectId}/users/${userId}`, { capEur: '' }));

  await json(await send('PATCH', `/projects/${projectId}/users/${userId}/receipts/${receipts[0].id}`, { status: 'rejected' }));
  state = await json(await admin(`/projects/${projectId}`));
  assert.equal(state.totals.totalEur, 110.5);

  const badEdit = await send('PATCH', `/projects/${projectId}/users/${userId}`, { dob: '2999-01-01' });
  assert.equal(badEdit.status, 400);
  await json(await send('PATCH', `/projects/${projectId}/users/${userId}`, { firstName: 'Anna Mária' }));
});

test('exports: forms PDF, Excel with formulas, ZIP by country', async () => {
  const second = submission(projectId, {
    firstName: 'Ion', lastName: 'Popescu', country: 'Romania', email: 'ion@example.com',
    receipts: [{ field: 'file0', amount: 231.45, currency: 'RON', ...journey, fromCity: 'București', fromCountry: 'Romania' }],
  }, [['file0', PNG, 'bon.png']]);
  assert.equal((await post(second.form)).status, 201);
  await json(await send('PUT', `/projects/${projectId}/rates`, { rates: { HUF: 400, RON: 4.97 } }));

  const pdf = await PDFDocument.load(await (await admin(`/projects/${projectId}/export/forms.pdf`)).arrayBuffer());
  assert.equal(pdf.getPageCount(), 2);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await (await admin(`/projects/${projectId}/export/summary.xlsx`)).arrayBuffer());
  const summary = wb.getWorksheet('Summary');
  assert.equal(summary.getCell('B2').value, 'Kovács');
  assert.match(summary.getCell('H2').value.formula, /^SUMIFS/);
  assert.equal(summary.getCell('J2').value.result, 110.5);
  assert.equal(summary.getCell('J3').value.result, 46.57); // 231.45 / 4.97
  assert.equal(summary.getCell('B4').value, 'Group total');
  assert.equal(summary.getCell('J4').value.result, 157.07);
  const receipts = wb.getWorksheet('Receipts');
  assert.equal(receipts.getCell('G2').value, 'Budapest, Hungary');
  assert.equal(receipts.getCell('N2').value, 'Rejected');
  assert.equal(wb.getWorksheet('Project').getCell('B1').value, 'Taste of the Balkans');

  const zip = await JSZip.loadAsync(await (await admin(`/projects/${projectId}/export/archive.zip`)).arrayBuffer());
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).map((n) => n.replace(/^[^/]+\//, '')).sort();
  assert.deepEqual(names, [
    'All forms.pdf',
    'Hungary/001 Kovács Anna Mária/02 hotel.pdf',
    'Hungary/001 Kovács Anna Mária/Form.pdf',
    'Hungary/001 Kovács Anna Mária/Rejected/01 photo.png',
    'Romania/002 Popescu Ion/01 bon.png',
    'Romania/002 Popescu Ion/Form.pdf',
    'Summary.xlsx',
  ]);
  assert.match(Object.keys(zip.files)[0], /^Taste of the Balkans /);
});

test('a new project starts empty; the old one is kept and can be reactivated', async () => {
  const newId = (await json(await send('POST', '/projects', { ...PROJECT, title: 'Second event', projectNumber: 'X-2' }))).id;
  const overview = await json(await admin('/overview'));
  assert.equal(overview.activeProjectId, newId);
  assert.equal(overview.projects.length, 2);
  assert.equal(overview.projects.find((p) => p.id === projectId).userCount, 2);
  assert.equal((await json(await admin(`/projects/${newId}`))).users.length, 0);
  assert.equal((await json(await fetch(`${base}/api/config`))).project.title, 'Second event');

  // Old project data survives a restart of the server.
  server.close();
  server = await startServer(dataDir);
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await admin('/overview')).status, 401, 'a restart asks for the PIN again');
  await unlock();
  const old = await json(await admin(`/projects/${projectId}`));
  assert.equal(old.users.length, 2);

  await json(await send('POST', `/projects/${projectId}/activate`));
  assert.equal((await json(await admin('/overview'))).activeProjectId, projectId);
  const backups = await fs.readdir(path.join(dataDir, 'backups'));
  assert.equal(backups.length, 1);
});

test('deleting a participant removes their files', async () => {
  await json(await send('DELETE', `/projects/${projectId}/users/${userId}`));
  assert.equal((await json(await admin(`/projects/${projectId}`))).users.length, 1);
  await assert.rejects(fs.access(path.join(dataDir, 'uploads', projectId, userId)));
});

test('data from before projects existed is moved into a project', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipts-migrate-'));
  try {
    await fs.mkdir(path.join(dir, 'uploads', 'u1'), { recursive: true });
    await fs.writeFile(path.join(dir, 'uploads', 'u1', '01-r1.png'), PNG);
    await fs.writeFile(path.join(dir, 'db.json'), JSON.stringify({
      settings: { rates: { HUF: 400 }, phoneUrl: '' },
      nextUserNumber: 2,
      users: [{ id: 'u1', number: 1, firstName: 'Old', lastName: 'Data', receipts: [{ id: 'r1', number: 1, amount: 4000, currency: 'HUF', status: 'accepted', file: { storedName: '01-r1.png' } }] }],
      submissionIds: {},
    }));
    const store = await openStore(dir);
    const project = store.activeProject();
    assert.equal(project.title, 'Earlier submissions');
    assert.equal(project.users[0].firstName, 'Old');
    assert.deepEqual(project.rates, { HUF: 400 });
    await fs.access(path.join(dir, 'uploads', project.id, 'u1', '01-r1.png'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
