// Config migrations on install (issue #153). A release may ship supervisor/migrations/NNN-name.mjs, each exporting
// `description` (one line) and `migrate(oldLocalConfig) -> newLocalConfig`, a pure function reviewed like any code. No shell hooks.
// Before a tick, pending migrations (number above the applied one) run in order against <root>/team.local.json: timestamped
// backup (mode 600), apply, validate, write, record the number, append to <root>/team/incidents.jsonl. A failing migration leaves
// the file untouched and is recorded as `failed`; the caller stops the tick and the dashboard shows a Needs you item.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LOCAL_FILE = 'team.local.json';
const NAME = /^(\d{3})-([a-z0-9][a-z0-9-]*)\.mjs$/;
export const stateFile = root => path.join(root, 'team', 'migrations.json');
export const incidentsFile = root => path.join(root, 'team', 'incidents.jsonl');

export function readMigrationState(root) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    return { applied: Number.isSafeInteger(s.applied) && s.applied >= 0 ? s.applied : 0, failed: s.failed && typeof s.failed === 'object' ? s.failed : null };
  } catch { return { applied: 0, failed: null }; }
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}
const saveState = (root, s) => writeAtomic(stateFile(root), JSON.stringify(s, null, 2) + '\n');
function incident(root, now, entry) {
  fs.mkdirSync(path.dirname(incidentsFile(root)), { recursive: true });
  fs.appendFileSync(incidentsFile(root), JSON.stringify({ at: now, kind: 'migration', ...entry }) + '\n', { mode: 0o600 });
}
export function readIncidents(root) {
  let text = '';
  try { text = fs.readFileSync(incidentsFile(root), 'utf8'); } catch { return []; }
  return text.split('\n').flatMap(l => { try { const r = JSON.parse(l); return r && typeof r === 'object' ? [r] : []; } catch { return []; } });
}

export function listMigrations(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const found = names.map(f => ({ f, m: NAME.exec(f) })).filter(x => x.m).map(x => ({ number: Number(x.m[1]), name: x.m[2], file: path.join(dir, x.f) }));
  found.sort((a, b) => a.number - b.number);
  for (let i = 1; i < found.length; i++) if (found[i].number === found[i - 1].number) throw new Error(`duplicate migration number ${found[i].number}`);
  return found;
}

// Returns { applied: [{number,name}], failed: null | {number,name,error}, pending: n }. Never throws for a migration problem.
export async function runMigrations({ root, dir, validate = () => {}, now = Date.now() }) {
  const state = readMigrationState(root);
  let all;
  try { all = listMigrations(dir); } catch (error) { return { applied: [], failed: { number: 0, name: 'migrations', error: String(error.message).slice(0, 200) } }; }
  const pending = all.filter(m => m.number > state.applied);
  const applied = [];
  const localFile = path.join(root, LOCAL_FILE);
  for (const mig of pending) {
    const fail = error => {
      const failed = { number: mig.number, name: mig.name, error: String(error?.message || error).slice(0, 200), at: now };
      if (!(state.failed && state.failed.number === failed.number && state.failed.error === failed.error)) incident(root, now, { result: 'failed', number: mig.number, name: mig.name, error: failed.error });
      saveState(root, { applied: state.applied, failed });
      return { applied, failed, pending: pending.length - applied.length };
    };
    try {
      const mod = await import(pathToFileURL(mig.file).href);
      if (typeof mod.migrate !== 'function' || typeof mod.description !== 'string' || !mod.description.trim() || /[\r\n]/.test(mod.description)) throw new Error('must export migrate() and a one-line description');
      let text = null;
      try { text = fs.readFileSync(localFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw new Error('team.local.json is unreadable'); }
      let backup = null;
      if (text !== null) {
        let old; try { old = JSON.parse(text); } catch { throw new Error('team.local.json is not valid JSON'); }
        const next = mod.migrate(structuredClone(old));
        if (next == null || typeof next !== 'object' || Array.isArray(next)) throw new Error('migrate() did not return an object');
        validate(next);
        backup = `${localFile}.bak-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${String(mig.number).padStart(3, '0')}`;
        writeAtomic(backup, text);
        writeAtomic(localFile, JSON.stringify(next, null, 2) + '\n');
      }
      state.applied = mig.number; state.failed = null;
      saveState(root, { applied: state.applied, failed: null });
      incident(root, now, { result: 'applied', number: mig.number, name: mig.name, description: mod.description.trim().slice(0, 200), changed: backup !== null, ...(backup ? { backup: path.basename(backup) } : {}) });
      applied.push({ number: mig.number, name: mig.name });
    } catch (error) { return fail(error); }
  }
  return { applied, failed: null, pending: 0 };
}
