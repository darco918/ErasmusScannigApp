// Receives one participant's form plus all their receipt files in a single
// multipart request. Files are streamed to a temp folder first and only moved
// into place once everything has been validated.

import Busboy from 'busboy';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from './config.js';
import { validateDetails, validateReceipt, ValidationError } from './validate.js';

// Only accept what the browser can show or the admin can open safely.
export function detectFileType(head) {
  const ascii = head.toString('latin1');
  if (ascii.startsWith('%PDF-')) return { mime: 'application/pdf', ext: '.pdf' };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (ascii.startsWith('\x89PNG\r\n\x1a\n')) return { mime: 'image/png', ext: '.png' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  if (ascii.slice(4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(ascii.slice(8, 12))) {
    return { mime: 'image/heic', ext: '.heic' };
  }
  return null;
}

function receiveMultipart(req, tmpDir) {
  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: LIMITS.maxFileBytes, files: LIMITS.maxReceipts, fields: 3, fieldSize: 512 * 1024 },
        defParamCharset: 'utf8',
      });
    } catch {
      reject(new ValidationError({ form: 'Expected a form upload.' }));
      return;
    }
    const files = new Map();
    const writes = [];
    let data = null;
    let failure = null;

    busboy.on('field', (name, value) => {
      if (name === 'data') data = value;
    });
    busboy.on('file', (name, stream, info) => {
      if (!/^file\d{1,3}$/.test(name) || files.has(name)) {
        stream.resume();
        return;
      }
      const tmpPath = path.join(tmpDir, crypto.randomUUID());
      const hash = crypto.createHash('sha256');
      const entry = { tmpPath, originalName: info.filename || 'receipt', size: 0, head: Buffer.alloc(0), truncated: false };
      files.set(name, entry);
      stream.on('data', (chunk) => {
        hash.update(chunk);
        entry.size += chunk.length;
        if (entry.head.length < 16) entry.head = Buffer.concat([entry.head, chunk]).subarray(0, 16);
      });
      stream.on('limit', () => {
        entry.truncated = true;
      });
      const out = fs.createWriteStream(tmpPath);
      writes.push(
        new Promise((done, fail) => {
          out.on('finish', () => {
            entry.sha256 = hash.digest('hex');
            done();
          });
          out.on('error', fail);
        }),
      );
      stream.pipe(out);
    });
    busboy.on('filesLimit', () => {
      failure = new ValidationError({ files: `At most ${LIMITS.maxReceipts} receipts per person.` });
    });
    busboy.on('error', (err) => {
      failure = failure || err;
    });
    busboy.on('close', async () => {
      try {
        await Promise.all(writes);
      } catch (err) {
        failure = failure || err;
      }
      resolve({ data, files, failure });
    });
    req.on('aborted', () => {
      failure = failure || new Error('Upload was interrupted.');
    });
    req.pipe(busboy);
  });
}

async function removeTemp(files) {
  await Promise.all([...files.values()].map((f) => fsp.rm(f.tmpPath, { force: true })));
}

export function submissionHandler(store) {
  return async (req, res, next) => {
    let files = new Map();
    try {
      const received = await receiveMultipart(req, store.tmpDir);
      files = received.files;
      if (received.failure) throw received.failure;

      let data;
      try {
        data = JSON.parse(received.data || '');
      } catch {
        throw new ValidationError({ form: 'The form data is missing.' });
      }

      const submissionId = typeof data.submissionId === 'string' ? data.submissionId.slice(0, 64) : '';
      if (!/^[\w-]{8,64}$/.test(submissionId)) throw new ValidationError({ form: 'Missing submission id.' });
      const existing = store.state.submissionIds[submissionId];
      if (existing) {
        // The phone retried after a dropped connection: the first attempt already counted.
        const user = store.findUser(existing);
        res.json({ ok: true, duplicate: true, number: user?.number ?? null, receiptCount: user?.receipts.length ?? 0 });
        return;
      }

      const details = validateDetails(data);
      const items = Array.isArray(data.receipts) ? data.receipts : [];
      if (!items.length) throw new ValidationError({ receipts: 'Please add at least one receipt.' });
      if (items.length > LIMITS.maxReceipts) {
        throw new ValidationError({ receipts: `At most ${LIMITS.maxReceipts} receipts per person.` });
      }

      const used = new Set();
      const receipts = items.map((item, i) => {
        const label = `Receipt ${i + 1}`;
        const file = files.get(item.field);
        if (!file || used.has(item.field)) throw new ValidationError({ receipts: `${label}: file is missing.` });
        used.add(item.field);
        if (file.truncated) {
          throw new ValidationError({ receipts: `${label}: file is larger than ${LIMITS.maxFileBytes / 1024 / 1024} MB.` });
        }
        const type = detectFileType(file.head);
        if (!type) throw new ValidationError({ receipts: `${label}: only photos (JPEG, PNG, WebP, HEIC) and PDFs are accepted.` });
        let fields;
        try {
          fields = validateReceipt({ amount: item.amount, currency: item.currency, date: item.date || '', vendor: item.vendor || '' });
        } catch (err) {
          throw new ValidationError({ receipts: `${label}: ${err.message}` });
        }
        const scan = item.scan && typeof item.scan === 'object' ? item.scan : null;
        return {
          id: crypto.randomUUID(),
          number: i + 1,
          file: { tmpPath: file.tmpPath, originalName: file.originalName.slice(0, 200), mime: type.mime, ext: type.ext, size: file.size, sha256: file.sha256 },
          ...fields,
          status: 'accepted',
          submitted: { ...fields },
          scan: scan && {
            amount: typeof scan.amount === 'number' ? scan.amount : null,
            currency: typeof scan.currency === 'string' ? scan.currency.slice(0, 3) : null,
            confidence: typeof scan.confidence === 'string' ? scan.confidence.slice(0, 10) : null,
            lang: typeof scan.lang === 'string' ? scan.lang.slice(0, 3) : null,
          },
        };
      });

      const user = await store.update(async (state) => {
        // Two copies of the same retry can race past the check above.
        if (state.submissionIds[submissionId]) return store.findUser(state.submissionIds[submissionId]);
        const id = crypto.randomUUID();
        const dir = store.userDir(id);
        await fsp.mkdir(dir, { recursive: true });
        try {
          for (const r of receipts) {
            const storedName = `${String(r.number).padStart(2, '0')}-${r.id}${r.file.ext}`;
            await fsp.rename(r.file.tmpPath, path.join(dir, storedName));
            r.file.storedName = storedName;
            delete r.file.tmpPath;
            delete r.file.ext;
          }
        } catch (err) {
          await fsp.rm(dir, { recursive: true, force: true });
          throw err;
        }
        const record = { id, number: state.nextUserNumber, submittedAt: new Date().toISOString(), ...details, receipts };
        state.nextUserNumber += 1;
        state.users.push(record);
        state.submissionIds[submissionId] = id;
        return record;
      });
      res.status(201).json({ ok: true, number: user.number, receiptCount: user.receipts.length });
    } catch (err) {
      next(err);
    } finally {
      // Anything still in tmp is a failed or unused upload.
      await removeTemp(files);
    }
  };
}
