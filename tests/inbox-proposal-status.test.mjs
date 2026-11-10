// Issue #1122: a proposal's status matches what the job did. One path claims an approved prompt; a second attempt records nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as inbox from '../supervisor/inbox.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const GOOD = { kind: 'prompt', title: 'Tidy the docs index', prompt: 'Fix the broken link in docs/README.md.' };
const rep = () => ({ ingested: [], notified: [], actions: [], skipped: [] });

function world(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-status-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, 'inbox'), state = path.join(tmp, 'state'), created = [];
  fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'status'), { recursive: true });
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const gh = { listPulls: async () => [], getPull: async () => null, listIssues: async () => [], board: async () => {}, listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, findIssueByMarker: async () => null };
  const jobs = { listActive: async () => [], get: async () => null, create: async spec => { created.push(spec); return { id: 'e0cc278b'.padEnd(32, '0') }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({ config, root: stateRoot(state), gh, jobs, git, register: REGISTER, clock: { now: () => 5000 }, providerModels: { claude: { aliases: ['sonnet'], pattern: '^claude-', efforts: ['medium'] } } });
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(GOOD));
  inbox.scan(dir, 1);
  assert.equal(inbox.decide(dir, id, 'approve', 2).ok, true);
  return { dir, team, created, id, act: { type: 'inbox', agent: 'claude', key: id, inboxId: id, title: GOOD.title } };
}
const finishJob = (w, text, status = 'completed') => {
  const [jobId, rec] = Object.entries(w.team.s.jobs).find(([, r]) => r.kind === 'inbox');
  const ticketDir = path.join(w.team.dir, 'inbox', String(rec.ticket));
  fs.mkdirSync(ticketDir, { recursive: true });
  if (text) fs.writeFileSync(path.join(ticketDir, 'inbox-result.txt'), text);
  w.team.ingestInbox(jobId, rec, { status, updatedAt: 6000 });
  return jobId;
};

test('valid: approve once, the item is running with the job id, then done with the summary', async t => {
  const w = world(t);
  await w.team.runAction(w.act, rep());
  assert.equal(w.created.length, 1);
  assert.equal(inbox.statusOf(w.dir, w.id).state, 'running');
  assert.equal(inbox.statusOf(w.dir, w.id).job, 'e0cc278b');
  finishJob(w, 'STATUS: done\nAdded the setting.');
  const st = inbox.statusOf(w.dir, w.id);
  assert.equal(st.state, 'done');
  assert.equal(st.job, 'e0cc278b');
  assert.match(st.result, /Added the setting/);
});

test('boundary: a second claim attempt while running, and after done, starts no job and records no failure', async t => {
  const w = world(t);
  await w.team.runAction(w.act, rep());
  await w.team.runAction(w.act, rep());
  assert.equal(w.created.length, 1, 'one job only');
  assert.equal(inbox.statusOf(w.dir, w.id).state, 'running');
  assert.equal(inbox.statusOf(w.dir, w.id).reason ?? null, null);
  finishJob(w, 'STATUS: done\nAll good.');
  await w.team.runAction(w.act, rep());
  const st = inbox.statusOf(w.dir, w.id);
  assert.equal(st.state, 'done', 'a late second attempt does not overwrite the finished state');
  assert.equal(w.created.length, 1);
  assert.match(st.result, /All good/);
});

test('invalid: a job that truly fails shows failed with its real reason, and a vanished item still fails honestly', async t => {
  const w = world(t);
  await w.team.runAction(w.act, rep());
  finishJob(w, 'STATUS: failed\nThe tests did not pass.');
  const st = inbox.statusOf(w.dir, w.id);
  assert.equal(st.state, 'failed');
  assert.match(st.reason, /did not achieve the task/);
  assert.equal(st.job, 'e0cc278b');
  const gone = world(t);
  gone.act.inboxId = 'f'.repeat(32);
  await gone.team.runAction(gone.act, rep());
  assert.equal(gone.created.length, 0);
  assert.notEqual(inbox.statusOf(gone.dir, gone.id).state, 'failed', 'the real item is untouched');
  const missing = inbox.statusOf(gone.dir, 'f'.repeat(32));
  assert.equal(missing.state, 'failed', 'the vanished item itself ends failed');
  assert.match(missing.reason, /unknown item/);
});

test('boundary: two paths racing at once (Promise.all) start one job and record no failure', async t => {
  const w = world(t);
  await Promise.all([w.team.runAction(w.act, rep()), w.team.runAction(w.act, rep())]);
  assert.equal(w.created.length, 1);
  assert.equal(inbox.statusOf(w.dir, w.id).state, 'running');
});

test('boundary: an item undone after the planner picked it stays pending, not failed', async t => {
  const w = world(t);
  assert.equal(inbox.undo(w.dir, w.id, 3).ok, true);
  await w.team.runAction(w.act, rep());
  assert.equal(w.created.length, 0);
  assert.equal(inbox.statusOf(w.dir, w.id).state, 'pending');
});

test('repair: a false failure of a finished job is replaced by the job real outcome; a real failure is untouched', async t => {
  const w = world(t);
  await w.team.runAction(w.act, rep());
  const [jobId, rec] = Object.entries(w.team.s.jobs).find(([, r]) => r.kind === 'inbox');
  const ticketDir = path.join(w.team.dir, 'inbox', String(rec.ticket));
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, 'inbox-result.txt'), 'STATUS: done\nConfig changed.');
  inbox.finish(w.dir, w.id, { state: 'failed', reason: 'the item is not an approved prompt', result: 'nothing was done' }, 5500);   // the 9 Nov state
  w.team.jobs.get = async () => ({ status: 'completed', updatedAt: 6000 });
  const r = rep();
  await w.team.processInbox(r);
  const st = inbox.statusOf(w.dir, w.id);
  assert.equal(st.state, 'done');
  assert.equal(st.job, jobId.slice(0, 8));
  assert.match(st.result, /Config changed/);
  assert.equal(st.reason, null, 'the stale false-failure reason is cleared');
  assert.equal(r.actions.some(a => a.type === 'inbox-status-repaired'), true);
  inbox.finish(w.dir, w.id, { state: 'failed', reason: 'the agent reported that it did not achieve the task', result: 'x' }, 7000);
  await w.team.processInbox(rep());
  assert.equal(inbox.statusOf(w.dir, w.id).state, 'failed', 'a real failure stays');
});
