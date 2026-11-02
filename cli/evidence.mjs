// Per-run evidence: unique directories, artifact records with hashes, the stored result.json and lookups by run id.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_ARTIFACT_BYTES = 64 * 1048576;
export const newRunId = () => crypto.randomBytes(8).toString('hex');
export const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
const dirName = (id) => new RegExp(`^\\d{8}T\\d{6}Z-${id}$`);

export function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(65536); let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// A new run directory is never reused: mkdir without `recursive` fails if it exists.
export function createRunDir(runsRoot, runId, started) {
  fs.mkdirSync(runsRoot, { recursive: true, mode: 0o750 });
  const dir = path.join(runsRoot, `${stamp(started)}-${runId}`);
  fs.mkdirSync(dir, { mode: 0o750 });
  fs.mkdirSync(path.join(dir, 'artifacts'), { mode: 0o750 });
  return dir;
}

export function artifactRecord(kind, file, runDir) {
  const st = fs.statSync(file);
  return { kind, path: path.relative(runDir, file), sha256: sha256(file), bytes: st.size };
}

// Copies the allow-listed result files out of a run's /out directory. Symlinks are never followed and files over the cap are skipped.
const KINDS = [[/\.png$/, 'screenshot'], [/\.md$/, 'report'], [/\.json$/, 'metadata']];
export function collectWebArtifacts(outDir, runDir) {
  const dest = path.join(runDir, 'artifacts');
  const artifacts = [];
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry.name)) continue;
    const kind = KINDS.find(([re]) => re.test(entry.name))?.[1];
    if (!kind) continue;
    const from = path.join(outDir, entry.name);
    if (fs.lstatSync(from).size > MAX_ARTIFACT_BYTES) continue;
    const to = path.join(dest, entry.name);
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(to, 0o640);
    artifacts.push(artifactRecord(kind, to, runDir));
  }
  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}

export function findRunDir(runsRoot, runId) {
  if (!fs.existsSync(runsRoot)) return null;
  const re = dirName(runId);
  const hit = fs.readdirSync(runsRoot, { withFileTypes: true }).find((e) => e.isDirectory() && !e.isSymbolicLink() && re.test(e.name));
  return hit ? path.join(runsRoot, hit.name) : null;
}

export function readStoredResult(runDir) {
  const file = path.join(runDir, 'result.json');
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeStoredResult(runDir, result, overwrite = false) {
  fs.writeFileSync(path.join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: overwrite ? 'w' : 'wx', mode: 0o640 });
}
