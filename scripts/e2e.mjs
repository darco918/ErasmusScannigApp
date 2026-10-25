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
const fontDir = path.join(import.meta.dirname, '..', 'assets', 'fonts');

const RECEIPTS = [
  {
    file: 'hu-train.png', lang: 'hun',
    lines: ['MÁV-START Zrt.', 'Menetjegy', 'Szeged - Budapest', '2026.08.09. 08:15', '', 'Menetjegy 1 db     9 990 Ft', 'Helyjegy 1 db      2 350 Ft', '', 'ÖSSZESEN:         12 340 Ft'],
    expect: { amount: '12340.00', currency: 'HUF', date: '2026-08-09', transport: 'TRAIN', fromCity: 'Szeged', fromCountry: 'Hungary', toCity: 'Budapest', toCountry: 'Hungary' },
  },
  {
    file: 'bg-bus.jpg', lang: 'bul',
    lines: ['АВТОБУСЕН БИЛЕТ', 'София - Пловдив', 'Дата 10.08.2026', '', 'Превоз           23,40', 'ДДС               3,90', '', 'ОБЩО             23,40 лв'],
    expect: { amount: '23.40', currency: 'BGN', date: '2026-08-10', transport: 'BUS', fromCity: 'Sofia', fromCountry: 'Bulgaria', toCity: 'Plovdiv', toCountry: 'Bulgaria' },
  },
  {
    file: 'tr-bus.png', lang: 'tur',
    lines: ['HAVAIST OTOBÜS', 'İstanbul - Edirne', 'TARİH: 08.08.2026', '', 'BİLET          *250,00', 'TOPKDV          *41,67', '', 'TOPLAM         *250,00 TL'],
    expect: { amount: '250.00', currency: 'TRY', date: '2026-08-08', transport: 'BUS', fromCity: 'Istanbul', fromCountry: 'Turkey', toCity: 'Edirne', toCountry: 'Turkey' },
  },
  {
    file: 'es-scanned.pdf', lang: 'spa', scanned: true,
    lines: ['RENFE VIAJEROS', 'Madrid - Barcelona', 'Fecha: 07/08/2026', '', 'Base imponible   37,19', 'IVA 10%           3,72', '', 'TOTAL A PAGAR    40,91 EUR'],
    expect: { amount: '40.91', currency: 'EUR', date: '2026-08-07', transport: 'TRAIN', fromCity: 'Madrid', fromCountry: 'Spain', toCity: 'Barcelona', toCountry: 'Spain' },
  },
  {
    file: 'pl-flight.pdf', lang: 'pol', textPdf: true,
    lines: ['Wizz Air Hungary Ltd.', 'Boarding pass / Karta pokładowa', 'Flight W6 1234   WAW - SOF', 'Date: 9 Aug 2026', '', 'Bilet   89,99', '', 'Do zapłaty: 89,99 zł'],
    expect: { amount: '89.99', currency: 'PLN', date: '2026-08-09', transport: 'PLANE', fromCity: 'Warsaw', fromCountry: 'Poland', toCity: 'Sofia', toCountry: 'Bulgaria' },
  },
];

async function renderReceiptImage(page, lines, type) {
  const rows = lines.map((l) => `<div>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;') || '&nbsp;'}</div>`).join('');
  await page.setContent(`<body style="margin:0;background:#cfc8bb;padding:40px">
    <div id="r" style="width:520px;background:#fbfaf6;padding:36px 30px;font:24px/1.5 'DejaVu Sans Mono','Liberation Mono',monospace;color:#222;white-space:pre;transform:rotate(-1deg);box-shadow:0 2px 8px #0003">${rows}</div></body>`);
  return page.locator('body').screenshot({ type, quality: type === 'jpeg' ? 85 : undefined });
}

async function textPdf(lines) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await fs.readFile(path.join(fontDir, 'LiberationSans-Regular.ttf')), { subset: true });
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

  // ---- Tablet: first-run project setup ----
  const tablet = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const adminPage = await tablet.newPage();
  const adminProblems = [];
  adminPage.on('console', (m) => m.type() === 'error' && adminProblems.push(m.text()));
  adminPage.on('pageerror', (e) => adminProblems.push(e.message));
  adminPage.on('dialog', (d) => d.accept());
  await adminPage.goto(`http://localhost:${port}/admin/`);
  await adminPage.waitForSelector('text=Set up your project');
  if (shotsDir) await adminPage.screenshot({ path: path.join(shotsDir, 'admin-setup.png') });
  await adminPage.fill('input[placeholder^="e.g. A Taste"]', 'Taste of the Balkans');
  await adminPage.fill('input[placeholder^="e.g. No2026"]', 'No2026-1-BG01-KA151-YOU-000391902');
  await adminPage.selectOption('select:has(option[value="Bulgaria"])', 'Bulgaria');
  const dates = adminPage.locator('input[type=date]');
  await dates.nth(0).fill('2026-08-10');
  await dates.nth(1).fill('2026-08-18');
  await adminPage.click('text=Create project');
  await adminPage.waitForSelector('text=Active – phones submit here');
  console.log('ok   project created on first run');

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

  const fields = ['amount', 'currency', 'date', 'transport', 'fromCity', 'fromCountry', 'toCity', 'toCountry'];
  const cards = await page.$$eval('.receipt', (els, names) => els.map((el) =>
    Object.fromEntries(names.map((n) => [n, el.querySelector(`[name=${n}]`).value]))), fields);
  cards.forEach((card, i) => {
    const want = RECEIPTS[i].expect;
    const wrong = Object.keys(want).filter((k) => card[k] !== want[k]);
    if (wrong.length) failures += 1;
    console.log(`${wrong.length ? 'FAIL' : 'ok  '} ${RECEIPTS[i].file.padEnd(15)} ${card.amount} ${card.currency} ${card.date} ${card.transport} ${card.fromCity}, ${card.fromCountry} -> ${card.toCity}, ${card.toCountry}${wrong.length ? `  (wrong: ${wrong.join(', ')})` : ''}`);
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
  await adminPage.goto(`http://localhost:${port}/admin/`);
  await adminPage.waitForSelector('table.users tbody tr');
  await adminPage.click('summary:has-text("Exchange rates")');
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
  const projectId = (await tablet.request.get(`http://localhost:${port}/api/admin/overview`).then((r) => r.json())).activeProjectId;

  for (const url of [`/api/admin/projects/${projectId}/export/forms.pdf`, `/api/admin/projects/${projectId}/export/summary.xlsx`, `/api/admin/projects/${projectId}/export/archive.zip`]) {
    const res = await tablet.request.get(`http://localhost:${port}${url}`);
    const body = await res.body();
    console.log(`${res.ok() ? 'ok  ' : 'FAIL'} ${path.basename(url)} -> ${res.status()} ${body.length} bytes`);
    if (!res.ok()) failures += 1;
    if (shotsDir) await fs.writeFile(path.join(shotsDir, path.basename(url)), body);
  }

  // New project: starts empty, the first one stays available and can be reactivated.
  await adminPage.click('a.back');
  await adminPage.click('text=New project');
  await adminPage.waitForSelector('h2:text-is("New project")');
  await adminPage.fill('input[placeholder^="e.g. A Taste"]', 'Second event');
  await adminPage.fill('input[placeholder^="e.g. No2026"]', 'No2026-1-BG01-KA151-YOU-000391902');
  await adminPage.selectOption('select:has(option[value="Bulgaria"])', 'Greece');
  await adminPage.locator('input[type=date]').nth(0).fill('2026-11-02');
  await adminPage.locator('input[type=date]').nth(1).fill('2026-11-09');
  await adminPage.click('text=Create project');
  await adminPage.waitForSelector('h2:has-text("Second event")');
  await adminPage.waitForSelector('text=No submissions yet');
  const config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  const newOk = config.project.title === 'Second event' && config.project.routeCountries.includes('Greece');
  console.log(`${newOk ? 'ok  ' : 'FAIL'} new project is active for phones (host Greece added to route countries)`);
  if (!newOk) failures += 1;
  await adminPage.selectOption('.project-switch select', projectId);
  await adminPage.waitForSelector('h2:has-text("Taste of the Balkans")');
  const kept = (await adminPage.locator('table.users tbody tr').count()) === 1;
  console.log(`${kept ? 'ok  ' : 'FAIL'} first project still has its participant`);
  if (!kept) failures += 1;
  if (shotsDir) await adminPage.screenshot({ path: path.join(shotsDir, 'admin-old-project.png') });
  await adminPage.click('text=Make active');
  await adminPage.waitForSelector('text=Active – phones submit here');
  console.log('ok   first project re-activated');
  if (adminProblems.length) {
    failures += 1;
    console.log('Admin console errors:\n  ' + adminProblems.join('\n  '));
  }

} finally {
  await browser.close();
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(fixtures, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} problem(s) found` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
