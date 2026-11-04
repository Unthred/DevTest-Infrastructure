// Read-only access to UI review evidence for the dashboard (issue #455). Only the allowlisted directory <evidence root>/ui-review is ever
// read. A review run is one directory below it (report.md, manifest.json, screenshots, and before/ and after/ folders of screenshots).
// Rules, all enforced here and tested with hostile paths: names are a closed character set (no dots-only, slashes, NUL or encoded
// separators survive), at most one folder level inside a run, only .png, .json and .md files, no symlink is followed at any level (each
// component is checked with lstat and the file is opened with O_NOFOLLOW), only regular files, and a size cap per file.
import fs from 'node:fs';
import path from 'node:path';

export const EVIDENCE_SUBDIR = 'ui-review';
export const DEFAULT_EVIDENCE_ROOT = '/mnt/cache/appdata/devtest-infrastructure/evidence';
export const FILE_TYPES = { png: 'image/png', json: 'application/json; charset=utf-8', md: 'text/plain; charset=utf-8' };
export const MAX_BYTES = { png: 12 * 1024 * 1024, json: 512 * 1024, md: 512 * 1024 };
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.(png|json|md)$/;
const MAX_RUNS = 200, MAX_FILES = 400;

const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };
const realDir = p => { const s = lstat(p); return !!s && s.isDirectory() && !s.isSymbolicLink(); };

// The allowlisted directory, or null when it does not exist (or is a symlink, which is never followed).
export function evidenceDir(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return null;
  const dir = path.join(root, EVIDENCE_SUBDIR);
  return realDir(dir) ? dir : null;
}

export const validRun = name => typeof name === 'string' && RUN.test(name) && !/^\.+$/.test(name);
export const typeOf = file => FILE.exec(file)?.[1] ?? null;

// A request path below /evidence/files/ -> { run, parts } or null. Each segment is percent-decoded once, then must match the closed set.
export function parseFilePath(rest) {
  const segs = String(rest).split('/');
  if (segs.length < 2 || segs.length > 3) return null;
  const out = [];
  for (const s of segs) {
    let d; try { d = decodeURIComponent(s); } catch { return null; }
    out.push(d);
  }
  if (!validRun(out[0]) || !out.slice(1, -1).every(d => NAME.test(d) && !/^\.+$/.test(d)) || !FILE.test(out.at(-1))) return null;
  return { run: out[0], parts: out.slice(1) };
}

// Opens one evidence file safely. Returns { type, body } or { error: 'not-found' | 'too-large' }; never throws for hostile input.
export function readEvidenceFile(root, request) {
  const base = evidenceDir(root);
  const parsed = typeof request === 'string' ? parseFilePath(request) : request;
  if (!base || !parsed) return { error: 'not-found' };
  let dir = path.join(base, parsed.run);
  if (!realDir(dir)) return { error: 'not-found' };
  for (const part of parsed.parts.slice(0, -1)) { dir = path.join(dir, part); if (!realDir(dir)) return { error: 'not-found' }; }
  const file = path.join(dir, parsed.parts.at(-1)), ext = typeOf(parsed.parts.at(-1));
  const before = lstat(file);
  if (!before || !before.isFile() || before.isSymbolicLink()) return { error: 'not-found' };
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) return { error: 'not-found' };
    if (st.size > MAX_BYTES[ext]) return { error: 'too-large' };
    const body = Buffer.alloc(st.size);
    let got = 0; while (got < st.size) { const n = fs.readSync(fd, body, got, st.size - got, got); if (!n) break; got += n; }
    return { type: FILE_TYPES[ext], body: body.subarray(0, got) };
  } catch { return { error: 'not-found' }; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

// Regular, non-symlink entries of one directory that are allowed files (or, when `dirs`, allowed folder names).
function entries(dir, { dirs = false } = {}) {
  let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return list.filter(e => !e.isSymbolicLink() && (dirs ? e.isDirectory() && NAME.test(e.name) && !/^\.+$/.test(e.name) : e.isFile() && FILE.test(e.name))).map(e => e.name).sort().slice(0, MAX_FILES);
}

const profileOf = name => /(desktop|tablet|phone)(-\d+)?/.exec(name)?.[0] ?? 'other';
const clip = (v, n = 200) => String(v ?? '').replace(/[\0-\x1f\x7f]+/g, ' ').slice(0, n);

// Scalar fields of manifest.json worth showing (commit, data source, ...); anything else stays in the raw file.
function manifestFacts(root, run) {
  const r = readEvidenceFile(root, { run, parts: ['manifest.json'] });
  if (!r.body) return { present: false, facts: [] };
  let m; try { m = JSON.parse(r.body.toString('utf8')); } catch { return { present: true, facts: [], invalid: true }; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { present: true, facts: [], invalid: true };
  const facts = Object.entries(m).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 12).map(([k, v]) => [k, clip(v)]);
  const count = ['captures', 'files', 'entries', 'screenshots'].map(k => (Array.isArray(m[k]) ? m[k].length : null)).find(n => n !== null) ?? null;
  return { present: true, facts, count };
}

export function listRuns(root) {
  const base = evidenceDir(root);
  if (!base) return { available: false, runs: [] };
  let names; try { names = fs.readdirSync(base, { withFileTypes: true }); } catch { return { available: true, runs: [] }; }
  const runs = names.filter(e => !e.isSymbolicLink() && e.isDirectory() && validRun(e.name)).map(e => {
    const dir = path.join(base, e.name), st = lstat(dir);
    const top = entries(dir), shots = top.filter(f => typeOf(f) === 'png').length;
    let pairs = 0, extra = 0;
    const b = realDir(path.join(dir, 'before')) ? entries(path.join(dir, 'before')) : [], a = realDir(path.join(dir, 'after')) ? entries(path.join(dir, 'after')) : [];
    pairs = b.filter(f => a.includes(f) && typeOf(f) === 'png').length;
    for (const sub of entries(dir, { dirs: true })) if (sub !== 'before' && sub !== 'after') extra += entries(path.join(dir, sub)).filter(f => typeOf(f) === 'png').length;
    const mf = manifestFacts(root, e.name);
    return { name: e.name, mtime: st?.mtimeMs ?? 0, screenshots: shots + extra + pairs * 2, pairs, hasReport: top.includes('report.md'), hasManifest: top.includes('manifest.json'),
      commit: mf.facts.find(([k]) => k === 'commit')?.[1] ?? null, source: mf.facts.find(([k]) => /^data_?source$/i.test(k))?.[1] ?? null };
  }).sort((x, y) => y.mtime - x.mtime || x.name.localeCompare(y.name)).slice(0, MAX_RUNS);
  return { available: true, runs };
}

// One run: report text, manifest facts, screenshots grouped by profile, and before/after pairs matched by file name.
export function readRun(root, run) {
  const base = evidenceDir(root);
  if (!base || !validRun(run) || !realDir(path.join(base, run))) return null;
  const dir = path.join(base, run), top = entries(dir);
  const report = top.includes('report.md') ? readEvidenceFile(root, { run, parts: ['report.md'] }) : null;
  const before = realDir(path.join(dir, 'before')) ? entries(path.join(dir, 'before')).filter(f => typeOf(f) === 'png') : [];
  const after = realDir(path.join(dir, 'after')) ? entries(path.join(dir, 'after')).filter(f => typeOf(f) === 'png') : [];
  const pairs = before.filter(f => after.includes(f)).map(f => ({ name: f, profile: profileOf(f), before: ['before', f], after: ['after', f] }));
  const unpaired = [...before.filter(f => !after.includes(f)).map(f => ({ name: f, side: 'before' })), ...after.filter(f => !before.includes(f)).map(f => ({ name: f, side: 'after' }))];
  const shots = top.filter(f => typeOf(f) === 'png').map(f => ({ name: f, profile: profileOf(f), parts: [f] }));
  for (const sub of entries(dir, { dirs: true })) if (sub !== 'before' && sub !== 'after') for (const f of entries(path.join(dir, sub)).filter(x => typeOf(x) === 'png')) shots.push({ name: `${sub}/${f}`, profile: profileOf(f), parts: [sub, f] });
  const others = top.filter(f => typeOf(f) !== 'png' && f !== 'report.md');
  return { name: run, report: report?.body ? report.body.toString('utf8') : null, reportTooLarge: report?.error === 'too-large', manifest: manifestFacts(root, run), shots, pairs, unpaired, others, hasManifest: top.includes('manifest.json') };
}
