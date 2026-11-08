// Disk use per volume and the number of entries in /tmp, one line per tick in <root>/dashboard/disk-samples.jsonl.
// Reads only through the statfs and readdir functions it is given; no shell command is spawned. A failure is reported to the
// caller's log and never reaches the tick.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_VOLUMES = ['/', '/tmp', '/mnt/cache', '/mnt/user'];
export const KEEP_MS = 7 * 24 * 3600000;
export const TMP_FOLDER = '/tmp';
export const samplesFile = root => path.join(root, 'dashboard', 'disk-samples.jsonl');

export function validateHealthConfig(health) {
  if (health === undefined) return;
  const volumes = health?.volumes;
  const ok = Array.isArray(volumes) && volumes.length > 0 && volumes.every(v => typeof v === 'string' && path.isAbsolute(v));
  if (!ok) throw new Error('invalid team config: health.volumes must be a non-empty list of absolute paths');
}

function volumeSample(volumePath, statfs) {
  try {
    const s = statfs(volumePath);
    const totalBytes = s.blocks * s.bsize;
    const usedBytes = totalBytes - s.bfree * s.bsize;
    if (!Number.isFinite(totalBytes) || !Number.isFinite(usedBytes)) throw new Error('not numbers');
    return { path: volumePath, usedBytes, totalBytes, status: 'ok' };
  } catch {
    return { path: volumePath, status: 'unreadable' };
  }
}

function countEntries(folder, readdir) {
  try {
    return readdir(folder).length;
  } catch {
    return null;
  }
}

// Pure: the sample for one tick from the two readers.
export function buildSample({ now, volumes, statfs, readdir }) {
  return {
    at: now,
    volumes: volumes.map(v => volumeSample(v, statfs)),
    tmpEntries: countEntries(TMP_FOLDER, readdir),
  };
}

// Pure: the lines of an existing file that are not older than 7 days, unchanged. A line without a readable time is dropped.
export function pruneLines(text, now) {
  const keep = line => {
    try {
      const at = JSON.parse(line).at;
      return Number.isFinite(at) && now - at <= KEEP_MS;
    } catch {
      return false;
    }
  };
  return text.split('\n').filter(line => line.trim() && keep(line));
}

// Appends this tick's line and drops old ones. Returns the sample.
export function recordDiskSample({ root, now, volumes = DEFAULT_VOLUMES, statfs = p => fs.statfsSync(p), readdir = p => fs.readdirSync(p) }) {
  const sample = buildSample({ now, volumes, statfs, readdir });
  const file = samplesFile(root);
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lines = [...pruneLines(existing, now), JSON.stringify(sample)];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${lines.join('\n')}\n`);
  fs.renameSync(temp, file);
  return sample;
}
