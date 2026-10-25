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

  const check = (ok, label) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) failures += 1;
  };
  const shot = (page, name, full = false) => shotsDir && page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: full });

  // ---- Tablet: first-run project setup ----
  const tablet = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const adminPage = await tablet.newPage();
  const adminProblems = [];
  adminPage.on('console', (m) => m.type() === 'error' && adminProblems.push(m.text()));
  adminPage.on('pageerror', (e) => adminProblems.push(e.message));
  adminPage.on('dialog', (d) => d.accept());
  const fillProject = async (title, host, start, end) => {
    await adminPage.fill('input[placeholder^="e.g. A Taste"]', title);
    await adminPage.fill('input[placeholder^="e.g. No2026"]', 'No2026-1-BG01-KA151-YOU-000391902');
    await adminPage.selectOption('form select', host);
    await adminPage.locator('form input[type=date]').nth(0).fill(start);
    await adminPage.locator('form input[type=date]').nth(1).fill(end);
    await adminPage.click('text=Create project');
  };
  await adminPage.goto(`http://localhost:${port}/admin/`);
  await adminPage.waitForSelector('text=Welcome! Set up your project');
  await shot(adminPage, 'admin-setup');
  await fillProject('Taste of the Balkans', 'Bulgaria', '2026-08-10', '2026-08-18');
  await adminPage.waitForSelector('text=Active – phones send here');
  check(true, 'project created on first run');
  await shot(adminPage, 'admin-overview-empty', true);

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
  await page.click('#next'); // empty details: the browser asks for them
  check(await page.isVisible('.step[data-step="1"]'), 'phone stays on step 1 until details are filled');
  await page.fill('[name=firstName]', 'Zsófia');
  await page.fill('[name=lastName]', 'Nagy-Țurcanu');
  await page.fill('[name=dob]', '1994-11-03');
  await page.fill('[name=email]', 'zsofia@example.com');
  await page.selectOption('[name=country]', 'Hungary');
  await shot(page, 'phone-1-details');
  await page.click('#next');
  await page.waitForSelector('.step[data-step="2"]:not([hidden])');
  await shot(page, 'phone-2-empty');

  // All files at once, as "Choose files" allows.
  await page.setInputFiles('#file-input', files);
  const started = Date.now();
  const allRead = () => page.waitForFunction(() => {
    const items = [...document.querySelectorAll('.receipt')];
    return items.length && items.every((c) => c.dataset.state !== 'reading');
  }, null, { timeout: 300_000 });
  await allRead();
  console.log(`Read ${files.length} receipts in ${((Date.now() - started) / 1000).toFixed(1)} s (automatic languages: Hungarian + Bulgarian + English)`);

  // Receipts in other languages: pick the language and read again, as a participant would.
  for (const [i, r] of RECEIPTS.entries()) {
    if (['hun', 'bul'].includes(r.lang)) continue;
    const item = page.locator('.receipt').nth(i);
    await item.locator('.receipt-row').click();
    await item.locator('.reread summary').click();
    await item.locator('.reread select').selectOption(r.lang);
    await item.locator('.reread button').click();
    await allRead();
  }

  const fields = ['amount', 'currency', 'date', 'transport', 'fromCity', 'fromCountry', 'toCity', 'toCountry'];
  const cards = await page.$$eval('.receipt', (els, names) => els.map((el) =>
    Object.fromEntries(names.map((n) => [n, el.querySelector(`[name=${n}]`).value]))), fields);
  cards.forEach((card, i) => {
    const want = RECEIPTS[i].expect;
    const wrong = Object.keys(want).filter((k) => card[k] !== want[k]);
    check(!wrong.length, `${RECEIPTS[i].file.padEnd(15)} ${card.amount} ${card.currency} ${card.date} ${card.transport} ${card.fromCity}, ${card.fromCountry} -> ${card.toCity}, ${card.toCountry}${wrong.length ? `  (wrong: ${wrong.join(', ')})` : ''}`);
  });
  await page.click('.receipt:nth-child(1) .receipt-row');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'phone-2-list', true);

  // Reloading the page keeps the unsent form.
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForSelector('#restored:not([hidden])');
  await page.waitForFunction((n) => document.querySelectorAll('.receipt').length === n, files.length);
  const restored = await page.$$eval('.receipt', (els) => els.map((el) => el.dataset.state));
  check((await page.inputValue('[name=firstName]')) === 'Zsófia' && restored.every((s) => s === 'ready'),
    `reloaded page restores the details and all receipts (${restored.join(', ')})`);

  await page.click('#next');
  await page.waitForSelector('.step[data-step="3"]:not([hidden])');
  await shot(page, 'phone-3-review', true);
  await page.click('#next'); // Send
  await page.waitForSelector('#done-view:not([hidden])', { timeout: 60_000 });
  console.log(`Phone: ${await page.textContent('#done-text')}`);
  await shot(page, 'phone-4-done');
  if (problems.length) check(false, 'phone console errors:\n  ' + problems.join('\n  '));

  // The phone must not be able to open the admin view.
  const blocked = await page.goto(`http://${lan}:${port}/admin/`);
  check(blocked.status() === 403 || lan === '127.0.0.1', `admin view from phone -> ${blocked.status()}`);

  // ---- Tablet admin ----
  await adminPage.click('.tabs >> text=Exchange rates');
  await adminPage.waitForSelector('[data-key=rate-HUF]');
  for (const [code, rate] of [['HUF', '395.5'], ['BGN', '1.95583'], ['TRY', '48.2'], ['PLN', '4.25']]) {
    await adminPage.fill(`[data-key=rate-${code}]`, rate);
    await adminPage.press(`[data-key=rate-${code}]`, 'Tab');
    await adminPage.waitForSelector(`.toast.show:has-text("Rate for ${code} saved")`);
  }
  await shot(adminPage, 'admin-rates', true);
  await adminPage.click('.tabs >> text=Overview');
  await adminPage.waitForSelector('.checklist');
  const total = await adminPage.textContent('.tile.accent strong');
  check(total === '110.43 EUR', `admin group total: ${total}`);
  await shot(adminPage, 'admin-overview', true);

  await adminPage.click('.tabs >> text=Participants');
  await adminPage.waitForSelector('table.users tbody tr');
  await shot(adminPage, 'admin-participants');
  await adminPage.click('table.users tbody tr');
  await adminPage.waitForSelector('.admin-receipt');
  // Autosave: correct one value and see the total follow.
  const amount = adminPage.locator('[data-key$="-amount"]').first();
  await amount.fill('12000');
  await amount.press('Tab');
  await adminPage.waitForSelector('.toast.show:has-text("amount saved")');
  const after = await adminPage.textContent('.tile.accent strong');
  check(after === '109.57 EUR', `autosaved correction updates the total: ${after}`);
  await adminPage.click('.preview >> nth=0');
  await adminPage.waitForSelector('#viewer[open]');
  await shot(adminPage, 'admin-viewer');
  await adminPage.click('#viewer >> text=Close');
  await adminPage.click('text=Mark as checked');
  await adminPage.waitForSelector('text=✓ Checked');
  check(true, 'participant marked as checked');
  await adminPage.evaluate(() => window.scrollTo(0, 0));
  await shot(adminPage, 'admin-participant', true);

  const projectId = (await tablet.request.get(`http://localhost:${port}/api/admin/overview`).then((r) => r.json())).activeProjectId;
  await adminPage.goto(`http://localhost:${port}/admin/#p=${projectId}/exports`);
  await adminPage.waitForSelector('.export-card');
  await shot(adminPage, 'admin-exports');
  for (const url of [`/api/admin/projects/${projectId}/export/forms.pdf`, `/api/admin/projects/${projectId}/export/summary.xlsx`, `/api/admin/projects/${projectId}/export/archive.zip`]) {
    const res = await tablet.request.get(`http://localhost:${port}${url}`);
    const body = await res.body();
    check(res.ok(), `${path.basename(url)} -> ${res.status()} ${body.length} bytes`);
    if (shotsDir) await fs.writeFile(path.join(shotsDir, path.basename(url)), body);
  }

  // New project: starts empty, the first one stays available and can be reactivated.
  await adminPage.click('#new-project');
  await adminPage.waitForSelector('h2:text-is("New project")');
  await fillProject('Second event', 'Greece', '2026-11-02', '2026-11-09');
  await adminPage.waitForSelector('.project-title h1:text-is("Second event")');
  const config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  check(config.project.title === 'Second event' && config.project.routeCountries.includes('Greece'), 'new project is active for phones (host Greece added to route countries)');
  await adminPage.selectOption('#project-switch', projectId);
  await adminPage.waitForSelector('.project-title h1:text-is("Taste of the Balkans")');
  await adminPage.click('.tabs >> text=Participants');
  await adminPage.waitForSelector('.tabs a.current:has-text("Participants")');
  await adminPage.waitForSelector('table.users tbody tr');
  check((await adminPage.locator('table.users tbody tr').count()) === 1, 'first project still has its participant');
  await shot(adminPage, 'admin-old-project');
  await adminPage.click('.project-head >> text=Make active');
  await adminPage.waitForSelector('text=Active – phones send here');
  check(true, 'first project re-activated');
  if (adminProblems.length) check(false, 'admin console errors:\n  ' + adminProblems.join('\n  '));
} finally {
  await browser.close();
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(fixtures, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} problem(s) found` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
