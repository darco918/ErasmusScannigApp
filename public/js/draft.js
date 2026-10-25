// Keeps the unsent form (details and receipt files) in the phone's browser
// storage. Phones often reload the page after taking a photo when memory is
// low; with this the participant picks up where they left off.
// Storage can be unavailable (private mode, full disk): everything here fails
// quietly and the form simply works without it.

const DB = 'travel-receipts';
const STORE = 'draft';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadDraft(projectId) {
  try {
    const draft = await run('readonly', (store) => store.get('current'));
    return draft && draft.projectId === projectId ? draft : null;
  } catch {
    return null;
  }
}

export async function saveDraft(draft) {
  try {
    await run('readwrite', (store) => store.put(draft, 'current'));
  } catch (err) {
    console.warn('Could not save the draft', err);
  }
}

export async function clearDraft() {
  try {
    await run('readwrite', (store) => store.delete('current'));
  } catch {}
}
