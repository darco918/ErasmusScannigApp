// All data lives in one JSON file plus a folder of original uploads per
// project and participant. For a few dozen participants per project this is
// plenty, and it needs no native modules, which keeps Termux installs simple.
//
// Nothing is ever deleted by starting a new project: every project stays in
// db.json, and a dated copy of db.json is kept in backups/ once per day.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY = { version: 2, settings: { phoneUrl: '' }, activeProjectId: null, projects: [] };

export function newProject(details) {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    title: '',
    projectNumber: '',
    startDate: '',
    endDate: '',
    hostCountry: '',
    ...details,
    rates: {},
    nextUserNumber: 1,
    users: [],
    submissionIds: {},
  };
}

// Data saved before projects existed becomes one project, uploads included.
async function migrate(state, uploadsDir) {
  if (state.version === 2) return state;
  const project = newProject({ title: 'Earlier submissions' });
  project.rates = state.settings?.rates || {};
  project.nextUserNumber = state.nextUserNumber || 1;
  project.users = state.users || [];
  project.submissionIds = state.submissionIds || {};
  await fs.mkdir(path.join(uploadsDir, project.id), { recursive: true });
  for (const user of project.users) {
    await fs.rename(path.join(uploadsDir, user.id), path.join(uploadsDir, project.id, user.id)).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
  return {
    ...structuredClone(EMPTY),
    settings: { phoneUrl: state.settings?.phoneUrl || '' },
    activeProjectId: project.users.length ? project.id : null,
    projects: project.users.length ? [project] : [],
  };
}

export async function openStore(dataDir) {
  const dbFile = path.join(dataDir, 'db.json');
  const uploadsDir = path.join(dataDir, 'uploads');
  const tmpDir = path.join(dataDir, 'tmp');
  const backupDir = path.join(dataDir, 'backups');
  for (const dir of [uploadsDir, tmpDir, backupDir]) await fs.mkdir(dir, { recursive: true });

  let state;
  try {
    state = JSON.parse(await fs.readFile(dbFile, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    state = structuredClone(EMPTY);
  }
  const migrated = state.version !== 2;
  state = await migrate(state, uploadsDir);

  // Writes are queued so two requests never interleave a save.
  let queue = Promise.resolve();
  async function save() {
    const backup = path.join(backupDir, `db-${new Date().toISOString().slice(0, 10)}.json`);
    await fs.copyFile(dbFile, backup, fs.constants.COPYFILE_EXCL).catch(() => {});
    const tmp = `${dbFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, dbFile);
  }
  if (migrated) await save();

  return {
    dataDir,
    uploadsDir,
    tmpDir,
    get state() {
      return state;
    },
    userDir(projectId, userId) {
      return path.join(uploadsDir, projectId, userId);
    },
    project(id) {
      return state.projects.find((p) => p.id === id) || null;
    },
    activeProject() {
      return state.projects.find((p) => p.id === state.activeProjectId) || null;
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
