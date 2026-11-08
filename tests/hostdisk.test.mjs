// Issue #1092: disk use per volume and the /tmp entry count, one line per tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSample, pruneLines, recordDiskSample, samplesFile, KEEP_MS, DEFAULT_VOLUMES, validateHealthConfig } from '../supervisor/hostdisk.mjs';
import { Team, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const scratch = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostdisk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const fakeStatfs = table => p => {
  if (!(p in table)) throw new Error('ENOENT');
  return table[p];
};
const NOW = 1_800_000_000_000;

test('a sample covers every configured volume with used and total bytes', () => {
  const statfs = fakeStatfs({ '/': { blocks: 1000, bfree: 250, bsize: 4096 }, '/mnt/cache': { blocks: 10, bfree: 10, bsize: 512 } });
  const sample = buildSample({ now: NOW, volumes: ['/', '/mnt/cache'], statfs, readdir: () => ['a'] });
  assert.deepEqual(sample.volumes, [
    { path: '/', usedBytes: 750 * 4096, totalBytes: 1000 * 4096, status: 'ok' },
    { path: '/mnt/cache', usedBytes: 0, totalBytes: 5120, status: 'ok' },
  ]);
  assert.equal(sample.at, NOW);
});

test('an unreadable volume is marked unreadable with no byte fields and the others still record', () => {
  const statfs = fakeStatfs({ '/': { blocks: 4, bfree: 1, bsize: 1 }, '/mnt/user': { blocks: 8, bfree: 8, bsize: 1 } });
  const { volumes } = buildSample({ now: NOW, volumes: ['/', '/gone', '/mnt/user'], statfs, readdir: () => [] });
  assert.deepEqual(volumes[1], { path: '/gone', status: 'unreadable' });
  assert.equal(volumes[0].status, 'ok');
  assert.equal(volumes[2].status, 'ok');
});

test('tmpEntries is the entry count of the folder, and null when it cannot be listed', () => {
  const statfs = fakeStatfs({});
  assert.equal(buildSample({ now: NOW, volumes: [], statfs, readdir: () => ['a', 'b', 'c'] }).tmpEntries, 3);
  const failing = () => { throw new Error('EACCES'); };
  assert.equal(buildSample({ now: NOW, volumes: [], statfs, readdir: failing }).tmpEntries, null);
});

test('tmpEntries matches a real fixture folder', t => {
  const dir = scratch(t);
  const tmp = path.join(dir, 'fixture');
  fs.mkdirSync(tmp);
  for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(tmp, n), '');
  fs.mkdirSync(path.join(tmp, 'sub'));
  const real = recordDiskSample({ root: dir, now: NOW, volumes: [dir], readdir: () => fs.readdirSync(tmp) });
  assert.equal(real.tmpEntries, 5);
  assert.equal(real.volumes[0].status, 'ok');
  assert.ok(real.volumes[0].totalBytes > 0);
});

test('lines older than 7 days are removed, newer lines are kept unchanged', () => {
  const old = JSON.stringify({ at: NOW - KEEP_MS - 1, volumes: [], tmpEntries: 1 });
  const edge = JSON.stringify({ at: NOW - KEEP_MS, volumes: [], tmpEntries: 2 });
  const fresh = '{"at":' + (NOW - 1000) + ',  "volumes":[],"tmpEntries":3}';
  const kept = pruneLines([old, edge, fresh, 'not json', '{"volumes":[]}', ''].join('\n'), NOW);
  assert.deepEqual(kept, [edge, fresh]);
});

test('recording appends exactly one line per call and prunes the file', t => {
  const root = scratch(t);
  const file = samplesFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fresh = JSON.stringify({ at: NOW - 60000, volumes: [], tmpEntries: 0 });
  fs.writeFileSync(file, `${JSON.stringify({ at: NOW - KEEP_MS - 5 })}\n${fresh}\n`);
  const statfs = fakeStatfs({ '/': { blocks: 2, bfree: 1, bsize: 10 } });
  recordDiskSample({ root, now: NOW, volumes: ['/'], statfs, readdir: () => [] });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], fresh);
  assert.deepEqual(JSON.parse(lines[1]), { at: NOW, volumes: [{ path: '/', usedBytes: 10, totalBytes: 20, status: 'ok' }], tmpEntries: 0 });
});

test('the health.volumes setting is validated and the shipped default is the four volumes', () => {
  assert.doesNotThrow(() => validateHealthConfig(undefined));
  assert.doesNotThrow(() => validateHealthConfig({ volumes: ['/'] }));
  for (const bad of [{}, { volumes: [] }, { volumes: ['rel'] }, { volumes: 'x' }, null]) assert.throws(() => validateHealthConfig(bad), /health\.volumes/);
  const shipped = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  assert.deepEqual(shipped.health.volumes, DEFAULT_VOLUMES);
  assert.throws(() => validateTeamConfig({ ...shipped, health: { volumes: [] } }), /health\.volumes/);
});

const teamConfig = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const makeTeam = (dir, health) => {
  const gh = { listPulls: async () => [], listIssues: async () => [], listMergedPulls: async () => [], getPull: async () => null, comment: async () => {},
    hasComment: async () => false, findIssueByMarker: async () => null, createIssue: async () => 1, board: async () => ({}) };
  const jobs = { listActive: async () => [], get: async () => null };
  const config = { ...teamConfig(), ...(health ? { health } : {}) };
  return new Team({ config, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => NOW } });
};

test('a tick writes exactly one line covering every configured volume; an unreadable volume does not fail it', async t => {
  const dir = scratch(t);
  const team = makeTeam(dir, { volumes: [dir, path.join(dir, 'no-such-volume')] });
  const report = await team.tickPass({ dryRun: false });
  assert.ok(!report.skipped.some(s => s.what === 'disk samples'), JSON.stringify(report.skipped));
  const lines = fs.readFileSync(samplesFile(team.root), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assert.equal(line.at, NOW);
  assert.deepEqual(line.volumes.map(v => [v.path, v.status]), [[dir, 'ok'], [path.join(dir, 'no-such-volume'), 'unreadable']]);
  assert.ok(Number.isInteger(line.tmpEntries));
});

test('a sampling failure is recorded in the report and never fails the tick', async t => {
  const dir = scratch(t);
  const team = makeTeam(dir);
  fs.mkdirSync(path.join(team.root, 'dashboard'), { recursive: true });
  fs.mkdirSync(samplesFile(team.root));   // a folder where the file belongs: reading it fails
  const report = await team.tickPass({ dryRun: false });
  assert.ok(report.skipped.some(s => s.what === 'disk samples'));
});

test('a dry run writes no sample', async t => {
  const dir = scratch(t);
  const team = makeTeam(dir);
  await team.tickPass({ dryRun: true });
  assert.ok(!fs.existsSync(samplesFile(team.root)));
});
