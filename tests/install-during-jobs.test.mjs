// Issue #845: merged work is installed at the next tick whatever is running. A job started before the install keeps running on the version it
// started from; the first tick of the new version ingests its verdict and starts the next job. Fake GitHub and jobs, real SelfUpgrade state files,
// and the real rollback script (which repoints `current` exactly as an install does) for the files a running worker reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Team, validateTeamConfig } from '../supervisor/team.mjs';
import { SelfUpgrade, holdOf } from '../supervisor/upgrade.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const NOW = Date.now();
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REG = '## D-020 — x\n- Status: homeowner-approved\n\n## D-024 — z\n- Status: homeowner-approved\n';
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'medium' }, review: { model: 'opus', effort: 'medium' } }, codex: { implement: { effort: 'high' }, review: { effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
const manifests = { claude: { aliases: ['opus', 'sonnet'], efforts: ['low', 'medium', 'high'] }, codex: { aliases: [], efforts: ['low', 'medium', 'high'] } };

test('a review started before an install: its verdict is ingested by the next version, and the next job starts at once', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-jobs-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { created: [], comments: [], merges: [] };
  const pulls = [{ number: 50, title: 't', headRefName: 'codex/issue-50-x', headRefOid: H(5), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green }];
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => [], listMergedPulls: async () => [],
    getMergedPull: async () => null, comment: async (n, b) => calls.comments.push([n, b]), addLabel: async () => {}, removeLabel: async () => {}, hasComment: async () => false,
    findIssueByMarker: async () => null, board: async () => {}, createIssue: async () => 300, merge: async (n, h) => { calls.merges.push([n, h]); } };
  const jobs = { states: {}, seq: 0, active: [], listActive: async () => jobs.active, get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'running', provider: spec.provider }; jobs.active.push(jobs.states[id]); return { id }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const mk = () => new Team({ config: validateTeamConfig(structuredClone(config)), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REG, clock: { now: () => NOW }, limitedOf: () => ({ out: false }), providerModels: manifests });
  const old = mk();
  old.s.jobs.w1 = { kind: 'implement', agent: 'codex', model: 'gpt', pr: 50, branch: 'codex/issue-50-x', ingested: true, at: NOW - 1000 };
  const r1 = await old.tick();
  assert.deepEqual(r1.actions.map(a => a.type), ['review']);
  const [id, rec] = Object.entries(old.s.jobs).at(-1);
  assert.equal(jobs.states[id].status, 'running');

  // The install happens now, with the review still running: nothing waits, nothing is stopped.
  const FROM = H('a'), TO = H('b');
  const up = new SelfUpgrade({ root: path.join(dir, 'su'), clock: { now: () => NOW }, deps: {
    config: { agents: { claude: { branch_prefix: 'claude/' }, codex: { branch_prefix: 'codex/' } } }, independenceApproved: () => true,
    installed: () => FROM, fetchMain: () => TO, isAncestor: () => true, changedFiles: () => ['supervisor/team.mjs'],
    mainCommits: () => [{ sha: H('c'), pr: 7, head: H('d') }], mergedPull: async () => ({ state: 'MERGED', headRefName: 'claude/issue-9-x', headRefOid: H('d'), statusCheckRollup: green }),
    verdict: () => ({ verdict: 'PASS', reviewer: 'codex' }), activeJobs: async () => (await jobs.listActive()).length,
    preChecks: async () => ({ ok: true }), upgrade: async () => ({ ok: true }), dryRunTick: async () => ({ ok: true }), rollback: async () => ({ ok: true }), alert: async () => {} } });
  assert.equal(await up.step(), 'upgraded');
  assert.equal(jobs.active.length, 1, 'the running review was not touched');
  assert.deepEqual(holdOf('upgraded', up.s), { to: TO });         // the old process starts nothing in this tick only
  assert.equal(await up.verifyPending({ running: TO, ok: true }), 'verified');

  // The first tick of the new version (a fresh Team over the same state) reads the verdict the old worker's review wrote.
  const fresh = mk();
  const d = path.join(fresh.dir, 'inbox', rec.ticket); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'verdict.json'), JSON.stringify({ pr: 50, headSha: rec.head, verdict: 'PASS', findings: [], commandsRun: ['node --test'] }));
  jobs.states[id].status = 'completed'; jobs.active.length = 0;
  const report = { ingested: [] }; await fresh.ingest(report);
  assert.deepEqual(report.ingested.map(x => x.verdict), ['PASS']);
  assert.equal(fresh.s.verdicts[`50:${H(5)}`].verdict, 'PASS');
  assert.equal(holdOf('verified', up.s), null, 'no start is held after the install');
  const r2 = await fresh.tick();
  assert.deepEqual(r2.actions.map(a => a.type), ['merge'], 'the new version carries on from the old version\'s record');
});

test('a worker started from an old version directory keeps reading that version\'s files after `current` moves', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-files-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const FROM = H('a'), TO = H('b'), bin = path.join(dir, 'bin'), state = path.join(dir, 'state'), go = path.join(dir, 'go'), out = path.join(dir, 'out');
  fs.mkdirSync(bin);
  for (const [v, tag] of [[FROM, 'old'], [TO, 'new']]) {
    fs.mkdirSync(path.join(state, 'versions', v, 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(state, 'versions', v, 'supervisor', 'late.mjs'), `export default '${tag}';\n`);
    fs.writeFileSync(path.join(state, 'versions', v, 'supervisor', 'worker.mjs'), `import fs from 'node:fs';\nfor (let i = 0; i < 400 && !fs.existsSync(${JSON.stringify(go)}); i++) await new Promise(r => setTimeout(r, 25));\nconst late = (await import('./late.mjs')).default;\nfs.writeFileSync(${JSON.stringify(out)}, late);\n`);
  }
  fs.symlinkSync(`versions/${FROM}`, path.join(state, 'current'));
  fs.writeFileSync(path.join(bin, 'ai-supervisor'), '#!/usr/bin/env bash\necho new\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, `ai-supervisor.before-${FROM}`), '#!/usr/bin/env bash\necho old\n', { mode: 0o755 });
  // A job's worker is started from the resolved version path, as the wrapper does.
  const worker = spawn(process.execPath, [path.join(fs.realpathSync(path.join(state, 'current')), 'supervisor', 'worker.mjs')], { stdio: 'ignore' });
  const exited = new Promise(res => worker.on('exit', code => res(code)));
  // Repoint `current` to the other version while the worker runs (the rollback script does the same swap an install does).
  const r = spawnSync('bash', [new URL('../tools/rollback-supervisor.sh', import.meta.url).pathname, '--supervisor', FROM, TO], { encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_BIN_DIR: bin, AI_SUPERVISOR_STATE_DIR: state } });
  assert.equal(r.status, 0, r.stderr); assert.equal(worker.exitCode, null, 'the worker is still running');
  assert.equal(fs.readlinkSync(path.join(state, 'current')), `versions/${TO}`);
  fs.writeFileSync(go, '');
  assert.equal(await exited, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), 'old', 'the running worker finished on the files it started from');
});
