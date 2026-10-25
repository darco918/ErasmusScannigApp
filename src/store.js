// All data lives in one JSON file plus a folder of original uploads per user.
// For a few dozen users this is plenty, and it needs no native modules,
// which keeps installation in Termux simple.

import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY = { settings: { rates: {}, phoneUrl: '' }, nextUserNumber: 1, users: [], submissionIds: {} };

export async function openStore(dataDir) {
  const dbFile = path.join(dataDir, 'db.json');
  const uploadsDir = path.join(dataDir, 'uploads');
  const tmpDir = path.join(dataDir, 'tmp');
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(tmpDir, { recursive: true });

  let state;
  try {
    state = { ...structuredClone(EMPTY), ...JSON.parse(await fs.readFile(dbFile, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    state = structuredClone(EMPTY);
  }

  // Writes are queued so two requests never interleave a save.
  let queue = Promise.resolve();
  async function save() {
    const tmp = `${dbFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, dbFile);
  }

  return {
    dataDir,
    uploadsDir,
    tmpDir,
    get state() {
      return state;
    },
    userDir(userId) {
      return path.join(uploadsDir, userId);
    },
    findUser(id) {
      return state.users.find((u) => u.id === id) || null;
    },
    // Runs `change(state)` and persists the result. Returns what `change` returns.
    update(change) {
      const run = queue.then(async () => {
        const snapshot = structuredClone(state);
        try {
          const result = await change(state);
          await save();
          return result;
        } catch (err) {
          state = snapshot;
          throw err;
        }
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}
