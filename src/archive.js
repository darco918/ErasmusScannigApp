// ZIP export: Country / Participant / receipts + their document, plus the
// combined PDF and the Excel summary at the top level.

import { ZipArchive } from 'archiver';
import path from 'node:path';
import { renderDocuments } from './documents.js';
import { renderWorkbook } from './excel.js';

export function safeName(name, max = 80) {
  const cleaned = String(name)
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, max);
  return cleaned || '_';
}

export function userFolderName(user) {
  return safeName(`${String(user.number).padStart(3, '0')} ${user.lastName} ${user.firstName}`);
}

export function receiptFileName(receipt) {
  const ext = path.extname(receipt.file.storedName);
  const base = path.basename(receipt.file.originalName, path.extname(receipt.file.originalName));
  return `${String(receipt.number).padStart(2, '0')} ${safeName(base, 60)}${ext}`;
}

export async function streamArchive(res, store, stamp) {
  const { users, settings } = store.state;
  const root = `receipts-${stamp}`;
  const [combined, workbook] = await Promise.all([renderDocuments(users, settings.rates), renderWorkbook(users, settings.rates)]);

  const zip = new ZipArchive({ zlib: { level: 6 } });
  const done = new Promise((resolve, reject) => {
    zip.on('error', reject);
    res.on('close', resolve);
  });
  res.attachment(`${root}.zip`);
  zip.pipe(res);

  zip.append(Buffer.from(combined), { name: `${root}/All documents.pdf` });
  zip.append(workbook, { name: `${root}/Summary.xlsx` });
  for (const user of users) {
    const folder = `${root}/${safeName(user.country)}/${userFolderName(user)}`;
    zip.append(Buffer.from(await renderDocuments([user], settings.rates)), { name: `${folder}/Document.pdf` });
    for (const r of user.receipts) {
      const sub = r.status === 'rejected' ? `${folder}/Rejected` : folder;
      zip.file(path.join(store.userDir(user.id), r.file.storedName), { name: `${sub}/${receiptFileName(r)}` });
    }
  }
  await zip.finalize();
  await done;
}
