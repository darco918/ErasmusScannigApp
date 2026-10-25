import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { streamArchive } from './archive.js';
import { CURRENCIES, publicConfig } from './config.js';
import { renderDocuments } from './documents.js';
import { renderWorkbook } from './excel.js';
import { groupSummary } from './money.js';
import { isLoopback, lanAddresses } from './network.js';
import { submissionHandler } from './submit.js';
import { validateDetails, validateRates, validateReceipt, ValidationError } from './validate.js';

const ROOT = path.join(import.meta.dirname, '..');
const MODULES = path.join(ROOT, 'node_modules');

// Everything is served from the tablet; nothing may load from the internet.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "img-src 'self' blob: data:",
  "style-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// The admin view only opens in a browser on the tablet itself
// (http://localhost:PORT/admin). Phones on the hotspot are refused.
function adminOnly(req, res, next) {
  const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  const local = isLoopback(req.socket.remoteAddress) && ['localhost', '127.0.0.1', '::1'].includes(host);
  if (!local) {
    res.status(403).type('text/plain').send('The admin view only opens on the tablet itself, at http://localhost:' + req.socket.localPort + '/admin');
    return;
  }
  // Blocks other web pages from posting to the admin API (they cannot set custom headers).
  if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Admin') !== '1') {
    res.status(403).json({ error: 'Missing admin header.' });
    return;
  }
  next();
}

function serializeState(store, port) {
  const { settings, users } = store.state;
  const group = groupSummary(users, settings.rates);
  const phoneUrls = settings.phoneUrl ? [settings.phoneUrl] : lanAddresses().map((ip) => `http://${ip}:${port}/`);
  return {
    settings,
    currencies: CURRENCIES,
    phoneUrls,
    totals: { totalEur: group.totalEur, receiptCount: group.receiptCount, missingRates: group.missingRates, userCount: users.length },
    users: group.perUser.map(({ user, ...s }) => ({
      id: user.id,
      number: user.number,
      submittedAt: user.submittedAt,
      firstName: user.firstName,
      lastName: user.lastName,
      dob: user.dob,
      email: user.email,
      country: user.country,
      acceptedCount: s.acceptedCount,
      rejectedCount: s.rejectedCount,
      totalEur: s.totalEur,
      missingRates: s.missingRates,
      receipts: s.receipts.map((r) => ({
        id: r.id,
        number: r.number,
        amount: r.amount,
        currency: r.currency,
        date: r.date,
        vendor: r.vendor,
        status: r.status,
        rate: r.rate,
        eur: r.eur,
        editedAt: r.editedAt || null,
        submitted: r.submitted,
        scan: r.scan,
        file: { originalName: r.file.originalName, mime: r.file.mime, size: r.file.size },
      })),
    })),
  };
}

export function createApp(store) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    next();
  });

  // Libraries for reading receipts on the phone. Cached, since they are large.
  const cached = { maxAge: '7d', immutable: true, setHeaders: (res) => res.set('Cache-Control', 'public, max-age=604800') };
  app.use('/vendor/tesseract', express.static(path.join(MODULES, 'tesseract.js', 'dist'), cached));
  app.use('/vendor/tesseract-core', express.static(path.join(MODULES, 'tesseract.js-core'), cached));
  app.use('/vendor/pdfjs', express.static(path.join(MODULES, 'pdfjs-dist', 'legacy', 'build'), cached));
  app.use('/vendor/pdfjs-cmaps', express.static(path.join(MODULES, 'pdfjs-dist', 'cmaps'), cached));
  app.use('/vendor/pdfjs-fonts', express.static(path.join(MODULES, 'pdfjs-dist', 'standard_fonts'), cached));
  app.get('/vendor/lang/:file', (req, res) => {
    const m = /^([a-z]{3})\.traineddata\.gz$/.exec(req.params.file);
    if (!m || !(m[1] in publicConfig().OCR_LANGUAGES)) {
      res.sendStatus(404);
      return;
    }
    res.set('Cache-Control', 'public, max-age=604800');
    res.type('application/octet-stream');
    res.sendFile(path.join(MODULES, '@tesseract.js-data', m[1], '4.0.0_best_int', req.params.file));
  });

  // Phone side.
  app.use(express.static(path.join(ROOT, 'public')));
  app.get('/api/config', (req, res) => res.json(publicConfig()));
  app.post('/api/submissions', submissionHandler(store));

  // Tablet (admin) side.
  app.use('/admin', adminOnly, express.static(path.join(ROOT, 'admin')));
  const admin = express.Router();
  admin.use(adminOnly, express.json({ limit: '100kb' }));
  const port = (req) => req.socket.localPort;

  admin.get('/state', (req, res) => res.json(serializeState(store, port(req))));

  admin.put('/settings', async (req, res) => {
    const rates = validateRates(req.body.rates);
    const phoneUrl = typeof req.body.phoneUrl === 'string' ? req.body.phoneUrl.trim() : '';
    if (phoneUrl && !/^https?:\/\/[^\s]{1,200}$/.test(phoneUrl)) throw new ValidationError({ phoneUrl: 'Phone address must start with http://' });
    await store.update((state) => {
      state.settings.rates = rates;
      state.settings.phoneUrl = phoneUrl;
    });
    res.json(serializeState(store, port(req)));
  });

  const requireUser = (req) => {
    const user = store.findUser(req.params.id);
    if (!user) throw Object.assign(new Error('Participant not found.'), { status: 404 });
    return user;
  };
  const requireReceipt = (req) => {
    const receipt = requireUser(req).receipts.find((r) => r.id === req.params.rid);
    if (!receipt) throw Object.assign(new Error('Receipt not found.'), { status: 404 });
    return receipt;
  };

  admin.patch('/users/:id', async (req, res) => {
    requireUser(req);
    const changes = validateDetails(req.body, { partial: true });
    await store.update(() => Object.assign(store.findUser(req.params.id), changes));
    res.json(serializeState(store, port(req)));
  });

  admin.delete('/users/:id', async (req, res) => {
    const user = requireUser(req);
    await store.update((state) => {
      state.users = state.users.filter((u) => u.id !== user.id);
      for (const [key, id] of Object.entries(state.submissionIds)) if (id === user.id) delete state.submissionIds[key];
    });
    await fs.rm(store.userDir(user.id), { recursive: true, force: true });
    res.json(serializeState(store, port(req)));
  });

  admin.patch('/users/:id/receipts/:rid', async (req, res) => {
    requireReceipt(req);
    const changes = validateReceipt(req.body, { partial: true });
    await store.update(() => {
      Object.assign(requireReceipt(req), changes, { editedAt: new Date().toISOString() });
    });
    res.json(serializeState(store, port(req)));
  });

  admin.get('/users/:id/receipts/:rid/file', (req, res) => {
    const user = requireUser(req);
    const receipt = requireReceipt(req);
    if (req.query.download) res.attachment(receipt.file.originalName);
    // Images can never run scripts; PDFs open in the browser's own viewer.
    if (receipt.file.mime.startsWith('image/')) res.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'");
    res.type(receipt.file.mime);
    res.sendFile(path.join(store.userDir(user.id), receipt.file.storedName));
  });

  admin.get('/users/:id/document.pdf', async (req, res) => {
    const user = requireUser(req);
    const pdf = await renderDocuments([user], store.state.settings.rates);
    res.type('application/pdf').attachment(`Document ${user.lastName} ${user.firstName}.pdf`).send(Buffer.from(pdf));
  });

  admin.get('/export/documents.pdf', async (req, res) => {
    const pdf = await renderDocuments(store.state.users, store.state.settings.rates);
    res.type('application/pdf').attachment(`All documents ${stamp()}.pdf`).send(Buffer.from(pdf));
  });

  admin.get('/export/summary.xlsx', async (req, res) => {
    const xlsx = await renderWorkbook(store.state.users, store.state.settings.rates);
    res.type('xlsx').attachment(`Summary ${stamp()}.xlsx`).send(xlsx);
  });

  admin.get('/export/archive.zip', (req, res) => streamArchive(res, store, stamp()));

  admin.get('/qr.svg', async (req, res) => {
    const url = String(req.query.url || '').slice(0, 300);
    if (!/^https?:\/\//.test(url)) throw new ValidationError({ url: 'Bad address.' });
    res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 1 }));
  });

  app.use('/api/admin', admin);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use((err, req, res, next) => {
    if (res.headersSent) {
      console.error(err);
      res.destroy();
      return;
    }
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({
      error: status >= 500 ? 'Something went wrong on the tablet. Please try again.' : err.message,
      errors: err.errors,
    });
  });

  return app;
}
