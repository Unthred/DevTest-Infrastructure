// Issue #1409: review follow-up text can never make the dependency parser hold the batch issue.
// Through the real follow-up writer (Team.batchFollowUps) with a fake GitHub adapter, then the real dependency parser on the body written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Team } from '../supervisor/team.mjs';
import { appendToBatch, makeFindingSafe, rejectedSink } from '../supervisor/followups.mjs';
import { parseDependsOn } from '../foreman-mcp/dependency-parser.mjs';

// Real finding from issue #1143, review of PR #1245.
const REAL = "The invalid case 'a body the dependency parser refuses' is tested with a hand-written string, bodyFault('Depends on: not-an-issue'), so it can drift from what the parser really reads.";
const PLAIN = 'The helper has no test for an empty list.';

function writer(existing = null) {
  const calls = { created: [], updated: [] };
  let issue = existing && { number: 50, body: existing };
  const gh = {
    listPulls: async () => [],
    listPullFiles: async () => ['supervisor/a.mjs'],
    findOpenIssueByMarker: async (marker, skip = []) => (issue && !skip.includes(issue.number) && issue.body.includes(marker) ? { ...issue } : null),
    createIssue: async (title, body) => { calls.created.push(body); issue = { number: 50, body }; return 50; },
    updateIssueBody: async (n, body) => { calls.updated.push(body); issue.body = body; }
  };
  const team = Object.create(Team.prototype);
  team.gh = gh;
  team.s = { jobs: {} };
  let n = 0;
  const run = async (items, report = {}) => {
    n++;
    await team.batchFollowUps(`job${n}`, { pr: 9, head: `h${n}` }, items.map(text => ({ kind: 'follow-up', text })), report);
    return { body: issue.body, report };
  };
  return { run, calls };
}
const clean = body => { const p = parseDependsOn(body); return !p.line && !p.malformed && !p.numbers.length; };

test('valid: the real #1143 finding is appended with the phrase in a code span and the parser reads nothing', async () => {
  const { run } = writer();
  assert.equal(clean(`- ${REAL}`), false, 'the unprotected finding is the bug');
  const { body, report } = await run([REAL]);
  assert.ok(body.includes("bodyFault('`Depends on:` not-an-issue')"), body);
  assert.ok(clean(body));
  assert.equal(report.followUpsRejected, undefined);
});

test('valid: a later review is appended to the existing batch with the same result', async () => {
  const { run, calls } = writer();
  await run([PLAIN]);
  const { body } = await run([REAL]);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.updated.length, 1);
  assert.ok(body.includes(PLAIN) && body.includes('`Depends on:`'));
  assert.ok(clean(body));
});

test('boundary: capitals, the phrase twice on a line, without a colon, and already in a code span', async () => {
  const { run } = writer();
  const items = ['DEPENDS ON: #5 is quoted here', 'it says Depends on: #1 and again depends on : #2 on one line', 'a bare Depends on without colon', 'already `Depends on: #7` quoted'];
  const { body } = await run(items);
  assert.ok(clean(body), body);
  assert.ok(body.includes('`DEPENDS ON:` #5'));
  assert.ok(body.includes('`Depends on:` #1 and again `depends on :` #2'));
  assert.ok(body.includes('a bare `Depends on` without'));
  assert.ok(body.includes('already `Depends on: #7` quoted'), 'a span already there is not wrapped twice');
});

test('boundary: a stray backtick that breaks the first fix is neutralised on the named line', () => {
  const r = makeFindingSafe('odd ` Depends on: #4 here');
  assert.ok(r.text, JSON.stringify(r));
  assert.ok(clean(`- ${r.text}`));
});

test('valid: a finding without the phrase is appended exactly as before', async () => {
  const { run } = writer();
  const { body } = await run([PLAIN, 'Second finding, with `code` and "quotes".']);
  assert.ok(body.includes(`\n- ${PLAIN}\n- Second finding, with \`code\` and "quotes".\n`));
});

test('invalid: a finding the parser still faults after the retry is not appended and is returned with its reason', () => {
  const stubborn = text => (text.includes('STUCK') ? { malformed: 'forced', line: 'STUCK' } : null);
  const out = appendToBatch('head', { job: 'j', pr: 1, head: 'h', items: ['STUCK finding', PLAIN] }, stubborn);
  assert.equal(out.added, 1);
  assert.ok(!out.body.includes('STUCK'));
  assert.ok(out.body.includes(PLAIN));
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].text, 'STUCK finding');
  assert.match(out.rejected[0].reason, /still read it as a prerequisite line/);
});

test('invalid: a body the parser would hold is never written, and every finding is reported', () => {
  const holds = text => (text.includes('PLAIN-ISH') ? null : null) || (text.includes('devtest-review-followup') ? { malformed: 'forced', line: 'x' } : null);
  const out = appendToBatch('head', { job: 'j', pr: 1, head: 'h', items: [PLAIN] }, holds);
  assert.equal(out.body, 'head');
  assert.equal(out.added, 0);
  assert.equal(out.rejected.length, 1);
});

test('valid: a batch already held by an older appended line is repaired and later plain findings are still appended', async () => {
  const marker = '<!-- devtest-followup-batch v1 area=supervisor -->';
  const held = `${marker}\nBatch.\n- bodyFault('Depends on: not-an-issue')\n`;
  assert.equal(clean(held), false, 'the starting body is held');
  const { run } = writer(held);
  const { body, report } = await run([PLAIN]);
  assert.ok(body.includes(PLAIN), body);
  assert.ok(clean(body), body);
  assert.equal(report.followUpsRejected, undefined);
});


test('valid: a held older line that also quotes a file name in backticks is repaired and a plain finding is appended', async () => {
  const marker = '<!-- devtest-followup-batch v1 area=supervisor -->';
  const held = `${marker}\nBatch.\n- In \`supervisor/x.mjs\` the test uses bodyFault('Depends on: not-an-issue')\n`;
  assert.equal(clean(held), false, 'the starting body is held');
  const { run } = writer(held);
  const { body, report } = await run([PLAIN]);
  assert.ok(body.includes(PLAIN), body);
  assert.ok(clean(body), body);
  assert.equal(report.followUpsRejected, undefined);
});

test('invalid: a body still held after the one retry is not written and the finding reaches the tick report through the writer', async () => {
  const marker = '<!-- devtest-followup-batch v1 area=supervisor -->';
  // Three real declarations: the retry neutralises only the line the parser names, so two remain and the parser still holds the body.
  const held = `${marker}\nBatch.\nDepends on: #1\nDepends on: #2\nDepends on: #3\n`;
  const { run, calls } = writer(held);
  const { body, report } = await run([PLAIN]);
  assert.equal(body, held);
  assert.equal(calls.updated.length, 0);
  assert.equal(report.followUpsRejected.length, 1);
  assert.equal(report.followUpsRejected[0].text, PLAIN);
  assert.match(report.followUpsRejected[0].reason, /held by the dependency parser/);
});

test('invalid: the rejected sink puts a finding with its reason in the tick report', () => {
  const report = {};
  rejectedSink(report, 'job1', { pr: 9 }, t => t)([{ text: 'x', reason: 'because' }]);
  assert.deepEqual(report.followUpsRejected, [{ job: 'job1', pr: 9, reason: 'because', text: 'x' }]);
  rejectedSink(null, 'job1', { pr: 9 }, t => t)([{ text: 'x', reason: 'because' }]);
});
