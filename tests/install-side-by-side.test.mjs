// Issue #846: real worker processes run from versioned install directories. A job records the directory it started on, finishes against it
// after a later install, and the next job starts on the new version.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJob } from '../supervisor/core.mjs';
import { jobVersions } from '../supervisor/versions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const A = 'a'.repeat(40), B = 'b'.repeat(40);

function world(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'R'), 'x\n'); git(repo, 'add', 'R'); git(repo, 'commit', '-qm', 'init');
  const base = path.join(dir, 'install');
  for (const v of [A, B]) fs.cpSync(path.join(here, '..', 'supervisor'), path.join(base, 'versions', v, 'supervisor'), { recursive: true });
  const root = path.join(dir, 'state'); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const manifest = { schema_version: 1, id: 'fake', display_name: 'fake', adapter_version: '0.1.0', launch: { command: process.execPath, args: [path.join(here, 'fake-agent.mjs'), 'done', path.join(dir, 'marker')], env_allowlist: ['HOME', 'PATH', 'LANG'] },
    capabilities: { launch: 'supported', resume: 'supported', session_status: 'supported', usage_limit_detection: 'supported', reset_time_parsing: 'supported', checkpoint: 'supported', non_interactive: 'supported' }, billing: { model: 'subscription', fallback_to_other_billing: false } };
  fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify(manifest));
  const registry = path.join(dir, 'registry.json'); fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { fake: { adapter: 'base', manifest: 'fake.json' } } }));
  const make = async n => { const worktree = path.join(dir, 'wt' + n); git(repo, 'worktree', 'add', '-qb', 'issue-' + n, worktree);
    return createJob(root, { role: 'devtest', provider: 'fake', repository: repo, worktree, issue: n, scope: 'fixture', allowed_actions: ['read'], prompt: 'x', handover: 'H.md' }, registry); };
  const cli = v => path.join(base, 'versions', v, 'supervisor', 'cli.mjs');
  const env = { ...process.env, AI_SUPERVISOR_STATE_ROOT: root, AI_SUPERVISOR_NO_WAKE: '1' };
  const run = (v, args) => spawnSync(process.execPath, [cli(v), ...args, '--state-root', root, '--registry', registry], { encoding: 'utf8', timeout: 120000, env });
  const read = id => JSON.parse(fs.readFileSync(path.join(root, 'jobs', id + '.json'), 'utf8'));
  return { root, make, run, read };
}

test('issue #846: a worker stamps the install directory it runs from', async t => {
  const w = world(t), job = await w.make(1);
  assert.equal(w.read(job.id).supervisorVersion, undefined);
  const r = w.run(A, ['worker', job.id]); assert.equal(r.status, 0, r.stderr);
  assert.equal(w.read(job.id).supervisorVersion, A);
});

test('issue #846: a job started on the old version finishes after an install, its record is ingested by the new version, and the next job starts on the new one', async t => {
  const w = world(t), first = await w.make(2), second = await w.make(3);
  // The old job is stamped with A and not finished: the state an install finds. Cleanup must keep A's directory.
  const stamped = w.read(first.id); fs.writeFileSync(path.join(w.root, 'jobs', first.id + '.json'), JSON.stringify({ ...stamped, status: 'queued', supervisorVersion: A }));
  assert.deepEqual([...jobVersions(w.root).versions], [A]);
  // The install: `current` now points at B, but the job's worker is A's process; it completes against A's directory.
  const finished = w.run(A, ['worker', first.id]); assert.equal(finished.status, 0, finished.stderr);
  const ingested = JSON.parse(w.run(B, ['status', first.id]).stdout);   // the new version reads the old worker's finished record
  assert.equal(ingested.status, 'completed'); assert.equal(w.read(first.id).supervisorVersion, A);
  // The next job starts on the new version and is stamped with it.
  const next = w.run(B, ['worker', second.id]); assert.equal(next.status, 0, next.stderr);
  assert.equal(w.read(second.id).supervisorVersion, B);
});
