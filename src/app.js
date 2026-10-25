import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { streamArchive, safeName } from './archive.js';
import { CURRENCIES, publicConfig, routeCountries } from './config.js';
import { renderDocuments } from './documents.js';
import { renderWorkbook } from './excel.js';
import { groupSummary } from './money.js';
import { isLoopback, lanAddresses } from './network.js';
import { newProject } from './store.js';
import { submissionHandler } from './submit.js';
import { validateDetails, validateProject, validateRates, validateReceipt, ValidationError } from './validate.js';

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

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

// The admin view only opens in a browser on the tablet itself
// (http://localhost:PORT/admin). Phones on the network are refused.
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

const projectInfo = (p) => ({
  id: p.id,
  title: p.title,
  projectNumber: p.projectNumber,
  startDate: p.startDate,
  endDate: p.endDate,
  hostCountry: p.hostCountry,
  createdAt: p.createdAt,
});

function overview(store, port) {
  const { settings, projects, activeProjectId } = store.state;
  const phoneUrls = settings.phoneUrl ? [settings.phoneUrl] : lanAddresses().map((ip) => `http://${ip}:${port}/`);
  return {
    activeProjectId,
    phoneUrls,
    settings,
    projects: projects.map((p) => ({ ...projectInfo(p), userCount: p.users.length, totalEur: groupSummary(p.users, p.rates).totalEur })),
  };
}

function projectState(project) {
  const group = groupSummary(project.users, project.rates);
  return {
    project: { ...projectInfo(project), rates: project.rates, routeCountries: routeCountries(project.hostCountry) },
    currencies: CURRENCIES,
    totals: { totalEur: group.totalEur, receiptCount: group.receiptCount, missingRates: group.missingRates, userCount: project.users.length },
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
      sumEur: s.sumEur,
      capEur: s.capEur,
      capped: s.capped,
      totalEur: s.totalEur,
      missingRates: s.missingRates,
      receipts: s.receipts.map((r) => ({
        id: r.id,
        number: r.number,
        amount: r.amount,
        currency: r.currency,
        date: r.date || '',
        transport: r.transport || '',
        fromCity: r.fromCity || '',
        fromCountry: r.fromCountry || '',
        toCity: r.toCity || '',
        toCountry: r.toCountry || '',
        status: r.status,
        rate: r.rate,
        eur: r.eur,
        editedAt: r.editedAt || null,
        submitted: r.submitted,
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
  app.get('/api/config', (req, res) => res.json(publicConfig(store.activeProject())));
  app.post('/api/submissions', submissionHandler(store));

  // Tablet (admin) side.
  app.use('/admin', adminOnly, express.static(path.join(ROOT, 'admin')));
  const admin = express.Router();
  admin.use(adminOnly, express.json({ limit: '100kb' }));
  const port = (req) => req.socket.localPort;
  const ok = (res) => res.json({ ok: true });

  admin.get('/overview', (req, res) => res.json(overview(store, port(req))));

  admin.put('/settings', async (req, res) => {
    const phoneUrl = typeof req.body.phoneUrl === 'string' ? req.body.phoneUrl.trim() : '';
    if (phoneUrl && !/^https?:\/\/[^\s]{1,200}$/.test(phoneUrl)) throw new ValidationError({ phoneUrl: 'Phone address must start with http://' });
    await store.update((state) => {
      state.settings.phoneUrl = phoneUrl;
    });
    ok(res);
  });

  // A new project starts empty and becomes the one phones submit to.
  // Earlier projects are kept untouched.
  admin.post('/projects', async (req, res) => {
    const details = validateProject(req.body);
    const project = newProject(details);
    await store.update((state) => {
      state.projects.push(project);
      state.activeProjectId = project.id;
    });
    res.status(201).json({ ok: true, id: project.id });
  });

  // Every lookup happens inside store.update, so edits always land on the saved data.
  const getProject = (pid) => {
    const project = store.project(pid);
    if (!project) throw notFound('Project not found.');
    return project;
  };
  const getUser = (pid, id) => {
    const user = getProject(pid).users.find((u) => u.id === id);
    if (!user) throw notFound('Participant not found.');
    return user;
  };
  const getReceipt = (pid, id, rid) => {
    const receipt = getUser(pid, id).receipts.find((r) => r.id === rid);
    if (!receipt) throw notFound('Receipt not found.');
    return receipt;
  };

  admin.patch('/projects/:pid', async (req, res) => {
    getProject(req.params.pid);
    const changes = validateProject(req.body, { partial: true });
    await store.update(() => Object.assign(getProject(req.params.pid), changes));
    ok(res);
  });

  admin.post('/projects/:pid/activate', async (req, res) => {
    getProject(req.params.pid);
    await store.update((state) => {
      state.activeProjectId = req.params.pid;
    });
    ok(res);
  });

  admin.get('/projects/:pid', (req, res) => res.json(projectState(getProject(req.params.pid))));

  admin.put('/projects/:pid/rates', async (req, res) => {
    getProject(req.params.pid);
    const rates = validateRates(req.body.rates);
    await store.update(() => {
      getProject(req.params.pid).rates = rates;
    });
    ok(res);
  });

  admin.patch('/projects/:pid/users/:id', async (req, res) => {
    getUser(req.params.pid, req.params.id);
    const changes = validateDetails(req.body, { partial: true, allowCap: true });
    await store.update(() => Object.assign(getUser(req.params.pid, req.params.id), changes));
    ok(res);
  });

  admin.delete('/projects/:pid/users/:id', async (req, res) => {
    const { pid, id } = req.params;
    getUser(pid, id);
    await store.update(() => {
      const project = getProject(pid);
      project.users = project.users.filter((u) => u.id !== id);
      for (const [key, uid] of Object.entries(project.submissionIds)) if (uid === id) delete project.submissionIds[key];
    });
    await fs.rm(store.userDir(pid, id), { recursive: true, force: true });
    ok(res);
  });

  admin.patch('/projects/:pid/users/:id/receipts/:rid', async (req, res) => {
    const { pid, id, rid } = req.params;
    getReceipt(pid, id, rid);
    const changes = validateReceipt(req.body, { partial: true });
    await store.update(() => {
      Object.assign(getReceipt(pid, id, rid), changes, { editedAt: new Date().toISOString() });
    });
    ok(res);
  });

  admin.get('/projects/:pid/users/:id/receipts/:rid/file', (req, res) => {
    const { pid, id, rid } = req.params;
    const receipt = getReceipt(pid, id, rid);
    if (req.query.download) res.attachment(receipt.file.originalName);
    // Images can never run scripts; PDFs open in the browser's own viewer.
    if (receipt.file.mime.startsWith('image/')) res.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'");
    res.type(receipt.file.mime);
    res.sendFile(path.join(store.userDir(pid, id), receipt.file.storedName));
  });

  admin.get('/projects/:pid/users/:id/form.pdf', async (req, res) => {
    const project = getProject(req.params.pid);
    const user = getUser(req.params.pid, req.params.id);
    const pdf = await renderDocuments(project, [user]);
    res.type('application/pdf').attachment(safeName(`Form ${user.lastName} ${user.firstName}.pdf`)).send(Buffer.from(pdf));
  });

  admin.get('/projects/:pid/export/forms.pdf', async (req, res) => {
    const project = getProject(req.params.pid);
    const pdf = await renderDocuments(project, project.users);
    res.type('application/pdf').attachment(safeName(`All forms ${project.title} ${stamp()}.pdf`)).send(Buffer.from(pdf));
  });

  admin.get('/projects/:pid/export/summary.xlsx', async (req, res) => {
    const project = getProject(req.params.pid);
    const xlsx = await renderWorkbook(project, project.users);
    res.type('xlsx').attachment(safeName(`Summary ${project.title} ${stamp()}.xlsx`)).send(xlsx);
  });

  admin.get('/projects/:pid/export/archive.zip', (req, res) => streamArchive(res, store, getProject(req.params.pid), stamp()));

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
