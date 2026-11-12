// Issue #1007 items 3 to 5: per-job scratch folder, sweep, host pressure hold, test-slot leak guard, install precheck reasons.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeJobTmp, removeJobTmp, tmpEnv, sweepJobTmp, hostPressure, pressureText, guardTmp, jobTmpRoot, jobTmpName } from '../supervisor/jobtmp.mjs';
import { selfCheck } from '../supervisor/selfcheck.mjs';
import { TEST_COMMAND } from '../supervisor/team.mjs';
import { runProcess } from '../supervisor/process.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const world = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jobtmp-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('a job folder is made under the state root, exported as TMPDIR and CLAUDE_CODE_TMPDIR, and removed', t => {
  const root = world(t), dir = makeJobTmp(root, 'abc-123');
  assert.equal(dir, path.join(jobTmpRoot(root), jobTmpName('abc-123'))); assert.ok(fs.statSync(dir).isDirectory());
  assert.deepEqual(tmpEnv(dir), { TMPDIR: dir, CLAUDE_CODE_TMPDIR: dir }); assert.deepEqual(tmpEnv(null), {});
  fs.writeFileSync(path.join(dir, 'scratch'), 'x'); removeJobTmp(dir); assert.ok(!fs.existsSync(dir));
});

test('runProcess gives the agent its own TMPDIR and removes it after the run, and /tmp gains nothing', async t => {
  const root = world(t), wt = path.join(root, 'wt'); fs.mkdirSync(wt);
  const out = path.join(root, 'seen');
  const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(out)},[process.env.TMPDIR,process.env.CLAUDE_CODE_TMPDIR,String(fs.existsSync(process.env.TMPDIR))].join('\\n'));fs.writeFileSync(process.env.TMPDIR+'/scratch','x')`;
  const J = '3'.repeat(32), job = { id: J, kind: 'implement', worktree: wt, issue: 1007, attempts: 1, status: 'running', provider: 'codex', role: 'devtest', scope: 's', allowedActions: ['read'], prompt: 'p' };
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true }); fs.mkdirSync(path.join(root, 'events'), { recursive: true });
  const adapter = { command: () => [process.execPath, '-e', script], observe: () => null, preflight: () => true };
  const config = { manifest: { launch: { env_allowlist: ['PATH', 'HOME'] } } };
  await runProcess(root, job, config, adapter, { now: () => Date.now(), sleep: async () => {} });
  const [tmp, cc, existed] = fs.readFileSync(out, 'utf8').split('\n');
  assert.equal(tmp, path.join(jobTmpRoot(root), 'job-' + J)); assert.equal(cc, tmp); assert.equal(existed, 'true');
  assert.ok(!fs.existsSync(tmp), 'the job folder is gone when the job ends');
});

test('the sweep removes old folders no active job owns, keeps owned and fresh ones, and reports what it freed', t => {
  const root = world(t), base = jobTmpRoot(root); fs.mkdirSync(base, { recursive: true });
  const mk = (name, ageH) => { const d = path.join(base, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'f'), 'x'.repeat(5000)); const at = new Date(Date.now() - ageH * 3600000); fs.utimesSync(d, at, at); return d; };
  const old = mk('job-old', 7), owned = mk(jobTmpName('run1'), 9), fresh = mk('job-fresh', 1);
  const log = path.join(root, 'team', 'temp-sweeps.jsonl');
  const r = sweepJobTmp(root, { ownedIds: ['run1'], logFile: log });
  assert.deepEqual(r.removed, ['job-old']); assert.ok(r.bytes >= 5000);
  assert.ok(!fs.existsSync(old)); assert.ok(fs.existsSync(owned)); assert.ok(fs.existsSync(fresh));
  assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).removed, 1);
});

test('host pressure holds over 80% disk or 90% swap and names the top consumers', t => {
  const dir = world(t); fs.writeFileSync(path.join(dir, 'big'), 'x'.repeat(20000));
  assert.equal(hostPressure({ disk: { percent: 80 }, swap: { percent: 90 }, dirs: [dir] }).hold, false);
  const d = hostPressure({ disk: { percent: 81 }, swap: { percent: 10 }, dirs: [dir] });
  assert.equal(d.hold, true); assert.match(pressureText(d), /root volume is 81% full/); assert.match(pressureText(d), /big/);
  assert.equal(hostPressure({ disk: { percent: 10 }, swap: { percent: 95 }, dirs: [dir] }).hold, false);   // issue #1151: swap used alone never holds
  assert.equal(hostPressure({ disk: null, swap: null, dirs: [dir] }).hold, false);
});

test('pressure raises one Inbox item through the self-check', () => {
  const r = selfCheck({ state: {}, pressure: { text: 'the root volume is 91% full' }, now: 1 });
  assert.equal(r.items.length, 1); assert.equal(r.items[0].id, 'selfcheck-host-pressure'); assert.match(r.items[0].text, /91% full/);
  assert.equal(selfCheck({ state: {}, now: 1 }).items.length, 0);
});

test('the guard helper reports what a run left in its TMPDIR and removes its folder', t => {
  const base = world(t), g = guardTmp({ TMPDIR: base });
  assert.notEqual(g.env.TMPDIR, base); fs.mkdirSync(path.join(g.env.TMPDIR, 'leftover'));
  assert.deepEqual(g.finish(), ['leftover']); assert.ok(!fs.existsSync(g.dir));
});

test('test-slot run fails a passing suite that leaves a file in TMPDIR, and passes a clean one', t => {
  const root = world(t), cli = path.join(here, '..', 'supervisor', 'cli.mjs'), base = path.join(root, 'base'); fs.mkdirSync(base);
  const run = body => spawnSync(process.execPath, [cli, 'test-slot', 'run', '--no-reuse', '--state-root', root, '--', process.execPath, '-e', body], { encoding: 'utf8', env: { ...process.env, TMPDIR: base, AI_SUPERVISOR_STATE_ROOT: root } });
  const leak = run("require('fs').writeFileSync(require('path').join(process.env.TMPDIR,'leaked'),'x')");
  assert.equal(leak.status, 1, leak.stderr); assert.match(leak.stderr, /left 1 item\(s\).*leaked/);
  const clean = run('0');
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(fs.readdirSync(base), [], 'the guard folder is removed');
});

test('the common prompt tells agents to use TMPDIR', async () => {
  const { buildPrompts } = await import('../supervisor/team.mjs').then(m => ({ buildPrompts: m }));
  assert.ok(TEST_COMMAND);
  const src = fs.readFileSync(path.join(here, '..', 'supervisor', 'team.mjs'), 'utf8');
  assert.match(src, /Use \$TMPDIR .* never \/tmp directly/);
});
