// Issue #1147: every Inbox prompt carries the report contract once, and a job's named report is checked when the job ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as inbox from '../supervisor/inbox.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { withReportContract, reportState, reportNote, renderContract, reportNameFor, FINISHED_MARKER } from '../supervisor/inboxreport.mjs';
import { FINISHED_MARKER as READER_MARKER } from '../foreman-mcp/reports.mjs';

const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const GOOD = { kind: 'prompt', title: 'Write the coverage rules', prompt: 'Summarise the coverage rules.' };
const rep = () => ({ ingested: [], notified: [], actions: [], skipped: [] });

function world(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-report-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, 'inbox'), state = path.join(tmp, 'state'), reportsDir = path.join(tmp, 'reports'), created = [];
  fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'status'), { recursive: true });
  fs.mkdirSync(reportsDir);
  const config = {
    schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
    access: { mode: 'full', decision: 'D-020' }, inbox: { dir }, reports_dir: reportsDir,
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
    agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } },
  };
  const none = async () => null;
  const noop = async () => {};
  const gh = {
    listPulls: async () => [], getPull: none, listIssues: async () => [], listMergedPulls: async () => [],
    board: noop, comment: noop, addLabel: noop, findIssueByMarker: none,
  };
  const jobs = { listActive: async () => [], get: async () => null, create: async spec => { created.push(spec); return { id: 'e0cc278b'.padEnd(32, '0') }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const providerModels = { claude: { aliases: ['sonnet'], pattern: '^claude-', efforts: ['medium'] } };
  const team = new Team({ config, root: stateRoot(state), gh, jobs, git, register: REGISTER, clock: { now: () => 5000 }, providerModels });
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(GOOD));
  inbox.scan(dir, 1);
  assert.equal(inbox.decide(dir, id, 'approve', 2).ok, true);
  const act = { type: 'inbox', agent: 'claude', key: id, inboxId: id, title: GOOD.title };
  return { dir, team, created, id, reportsDir, reportName: reportNameFor(id), act };
}
const finish = w => {
  const [jobId, rec] = Object.entries(w.team.s.jobs).find(([, r]) => r.kind === 'inbox');
  const ticketDir = path.join(w.team.dir, 'inbox', String(rec.ticket));
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, 'inbox-result.txt'), 'STATUS: done\nWrote it.');
  w.team.ingestInbox(jobId, rec, { status: 'completed', updatedAt: 6000 });
};
const writeReport = (w, text) => fs.writeFileSync(path.join(w.reportsDir, w.reportName), text);

test('the marker here is the reader\'s marker', () => assert.equal(FINISHED_MARKER, READER_MARKER));

test('valid: the started job prompt carries the contract once, naming folder, STATUS line and marker', async t => {
  const w = world(t);
  await w.team.runAction(w.act, rep());
  const prompt = w.created[0].prompt;
  const contract = renderContract({ reportsDir: w.reportsDir, reportName: w.reportName });
  assert.equal(prompt.split(contract).length - 1, 1);
  assert.ok(prompt.includes(w.reportsDir) && prompt.includes(w.reportName) && prompt.includes('STATUS:') && prompt.includes(FINISHED_MARKER));
  assert.ok(prompt.endsWith(contract), 'the contract is the last thing the agent reads');
});

test('valid: a job whose report ends with the marker leaves the result without a report note', async t => {
  const w = world(t);
  await w.team.runAction(w.act, rep());
  writeReport(w, `STATUS: done\nBody\n${FINISHED_MARKER}\n`);
  finish(w);
  const st = inbox.statusOf(w.dir, w.id);
  assert.equal(st.state, 'done');
  assert.doesNotMatch(st.result, /unfinished|missing/);
});

test('boundary: a prompt that already holds the contract is not duplicated', () => {
  const opts = { reportsDir: '/r', reportName: 'inbox-aaaaaaaa.md' };
  const once = withReportContract('Do the task.', opts);
  assert.equal(withReportContract(once, opts), once);
});

test('boundary: trailing spaces, CRLF and blank lines after the marker still count as finished', t => {
  const w = world(t);
  for (const tail of [`${FINISHED_MARKER}   `, `${FINISHED_MARKER}\r\n`, `${FINISHED_MARKER}\n\n\n`]) {
    writeReport(w, `STATUS: done\nBody\n${tail}`);
    assert.equal(reportState(w), 'finished', JSON.stringify(tail));
  }
});

test('invalid: no marker reads unfinished and the Inbox result names the file', async t => {
  const w = world(t);
  await w.team.runAction(w.act, rep());
  writeReport(w, 'STATUS: done\nBody with no marker\n');
  finish(w);
  const st = inbox.statusOf(w.dir, w.id);
  assert.equal(st.state, 'done', 'the task outcome is not rewritten');
  assert.match(st.result, new RegExp(`Report ${w.reportName} is unfinished`));
});

test('invalid: a marker that is not the final line reads unfinished', t => {
  const w = world(t);
  writeReport(w, `STATUS: done\n${FINISHED_MARKER}\nmore text after it\n`);
  assert.equal(reportState(w), 'unfinished');
  assert.match(reportNote({ reportsDir: w.reportsDir, reportName: w.reportName }), /unfinished/);
});

test('invalid: a missing report file is reported as missing, not finished', async t => {
  const w = world(t);
  await w.team.runAction(w.act, rep());
  assert.equal(reportState(w), 'missing');
  finish(w);
  const st = inbox.statusOf(w.dir, w.id);
  assert.match(st.result, new RegExp(`Report ${w.reportName} is missing`));
  assert.doesNotMatch(st.result, /finished/);
});

test('boundary: with no reports folder configured the prompt is unchanged and no note is added', () => {
  assert.equal(withReportContract('Task.', { reportsDir: null, reportName: 'x.md' }), 'Task.');
  assert.equal(reportNote({}), '');
});
