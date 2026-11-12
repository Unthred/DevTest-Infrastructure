// Issue #1121: every open issue is explained: agent, model, rule, rank and the specific wait; the empty case is a fault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { explainIssue, collectAssignments, idleRuleText } from '../supervisor/issueassign.mjs';
import { assignmentOf, faultViews } from '../foreman-mcp/assignmentview.mjs';

const agent = (name, extra = {}) => ({ name, canImplement: true, model: `${name}-model`, out: null, busy: false, hold: null, ...extra });
const base = (extra = {}) => ({ number: 7, zone: 'UTC', running: false, prText: null, exclusion: null, startedEarlier: false, capText: null, planned: null,
  owner: { agent: 'claude', rule: 'listed', rank: 2, of: 5 }, agents: [agent('claude'), agent('codex')], ...extra });

test('a ready issue with no planned start is not admitted, with agent, model, rule and rank', () => {
  const r = explainIssue(base());
  assert.equal(r.agent, 'claude'); assert.equal(r.model, 'claude-model'); assert.equal(r.rank, 2);
  assert.match(r.rule, /agents\.claude\.issues \(position 2 of 5\)/);
  assert.equal(r.wait.kind, 'not-admitted'); assert.equal(r.fault, null);
});

test('each wait kind is named', () => {
  const kind = extra => explainIssue(base(extra)).wait.kind;
  assert.equal(kind({ exclusion: { kind: 'prerequisite', text: 'blocked by #5' } }), 'dependency');
  assert.equal(kind({ exclusion: { kind: 'waiting_on', text: 'waiting on #5' } }), 'dependency');
  assert.equal(kind({ exclusion: { kind: 'label', text: 'needs the homeowner' } }), 'homeowner');
  assert.equal(kind({ running: true }), 'running');
  assert.equal(kind({ prText: 'PR #9 is open' }), 'pr-open');
  assert.equal(kind({ planned: { agent: 'claude' } }), 'next');
  assert.equal(kind({ capText: 'Paused new work: 6 open PRs (cap 6)' }), 'cap');
  assert.equal(kind({ agents: [agent('claude', { hold: 'an install is in progress' }), agent('codex')] }), 'held');
  assert.equal(kind({ agents: [agent('claude', { busy: true }), agent('codex')] }), 'busy');
});

test('a paused owner names the resume time; allowance and reserve are told apart', () => {
  const until = Date.UTC(2026, 10, 12, 7, 18);
  const w = out => explainIssue(base({ agents: [agent('claude', { out }), agent('codex', { out: { kind: 'allowance', text: 'is out', until: null } })] })).wait;
  const paused = w({ kind: 'agent-paused', text: 'is waiting for reset (weekly 99%)', until });
  assert.equal(paused.kind, 'agent-paused'); assert.equal(paused.until, until); assert.match(paused.text, /until Thu 07:18/);
  assert.equal(w({ kind: 'reserve', text: 'remaining capacity at or below the reserve', until }).kind, 'reserve');
  assert.equal(w({ kind: 'allowance', text: 'is at its usage limit', until }).kind, 'allowance');
});

test('an unlisted issue goes to the first agent with a free slot, by number order', () => {
  const unlisted = { agent: null, rule: 'unlisted', rank: 1, of: 3 };
  const r = explainIssue(base({ owner: unlisted, agents: [agent('claude', { busy: true }), agent('codex')] }));
  assert.equal(r.agent, 'codex'); assert.match(r.rule, /in no agent's issue list/); assert.equal(r.rank, 1);
  const none = explainIssue(base({ owner: unlisted, agents: [agent('claude', { out: { kind: 'agent-paused', text: 'is waiting for reset', until: 1 } }), agent('codex', { out: { kind: 'allowance', text: 'is out', until: null } })] }));
  assert.equal(none.agent, null); assert.equal(none.wait.kind, 'agent-paused'); assert.equal(none.fault, null);
});

test('empty case: no implementer and no reason is a fault, never silence', () => {
  const r = explainIssue(base({ owner: null, agents: [] }));
  assert.equal(r.agent, null); assert.equal(r.wait, null); assert.match(r.fault, /no implementer and no stated reason/);
  assert.deepEqual(faultViews({ assignments: [{ ...r, number: 8 }, explainIssue(base())] }).assignmentFaults, [{ issue: 8, fault: r.fault }]);
});

test('a reassigned plan says where it came from', () => {
  const r = explainIssue(base({ planned: { agent: 'codex', reassignedFrom: 'claude' } }));
  assert.equal(r.agent, 'codex'); assert.match(r.rule, /reassigned from claude/);
});

test('collectAssignments reads the team: list position, unlisted pool, exclusions, pause text', () => {
  const team = {
    agents: () => [['claude', { issues: [3] }], ['codex', { issues: [] }]], s: { unblock: { queued: { codex: [4] } }, implemented: {} },
    unlisted: () => [5, 6], delivered: new Set([9]), timeZone: 'UTC', held: {}, modes: { claude: { mode: 'waiting', reason: 'weekly 99%', until: 5 } },
    limitedOf: () => null, pauseText: () => null, modelFor: ({ agent }) => ({ model: `${agent}-m` }),
    exclusion: n => (n === 6 ? { kind: 'prerequisite', text: 'blocked by #1' } : null)
  };
  const issues = [3, 4, 5, 6, 9].map(number => ({ number, state: 'OPEN', headRefName: '', labels: [] }));
  const rows = collectAssignments(team, { cache: { issues, pulls: [] }, plan: [], states: { claude: { state: 'idle' }, codex: { state: 'idle' } }, activeJobs: [] });
  assert.deepEqual(rows.map(r => r.number), [3, 4, 5, 6]);   // delivered #9 is left out
  const by = n => rows.find(r => r.number === n);
  assert.equal(by(3).wait.kind, 'agent-paused'); assert.equal(by(4).rule.startsWith('queued for codex'), true);
  assert.equal(by(5).agent, 'codex'); assert.equal(by(6).wait.kind, 'dependency');
  assert.match(idleRuleText('claude', 1, rows), /#3 waits \(agent-paused\)/);
});

test('the idle reason names the rule, also when nothing is assigned', () => {
  const rows = [explainIssue(base({ owner: { agent: null, rule: 'unlisted', rank: 1, of: 1 }, agents: [agent('codex')] }))];
  assert.match(idleRuleText('claude', 0, rows), /unlisted issues go to the first agent with a free slot.*#7 to codex/);
  assert.match(idleRuleText('claude', 3, []), /agents\.claude\.issues lists 3 issues, 0 still open/);
});

test('the MCP read: an open issue without a record is a fault; a closed one is not', () => {
  assert.match(assignmentOf({ assignments: [] }, 5, { state: 'OPEN' }).fault, /no assignment record/);
  assert.equal(assignmentOf({ assignments: [] }, 5, { state: 'CLOSED' }), null);
  assert.equal(assignmentOf({ assignments: [explainIssue(base())] }, 7, { state: 'OPEN' }).agent, 'claude');
});

test('foreman_why_blocked and foreman_status carry the assignment and the faults', async () => {
  const { createTools } = await import('../foreman-mcp/tools.mjs');
  const ok = explainIssue(base());
  const fault = { ...explainIssue(base({ owner: null, agents: [] })), number: 8 };
  const view = { agents: [], issues: [{ number: 7, state: 'OPEN' }, { number: 8, state: 'OPEN' }, { number: 9, state: 'OPEN' }], assignments: [ok, fault], assignmentFaults: [{ issue: 8, fault: fault.fault }] };
  const tools = createTools({ source: { get: async () => ({ view, ageMs: 0 }) }, readHost: () => ({}) });
  const run = async (name, args) => JSON.parse((await tools.call(name, args)).text);
  const why = await run('foreman_why_blocked', { kind: 'issue', number: 7 });
  assert.equal(why.assignment.agent, 'claude'); assert.equal(why.assignment.wait.kind, 'not-admitted');
  assert.match((await run('foreman_why_blocked', { kind: 'issue', number: 8 })).assignment.fault, /no implementer/);
  assert.match((await run('foreman_why_blocked', { kind: 'issue', number: 9 })).assignment.fault, /no assignment record/);
  assert.equal((await run('foreman_status', {})).assignmentFaults[0].issue, 8);
});

// Issue #1171: `act.reassignedFrom || null` in collectAssignments: a name is kept, null and undefined both become null (no "reassigned" text).
test('collectAssignments: reassignedFrom present, null and undefined', () => {
  const team = { agents: () => [['claude', { issues: [3] }], ['codex', { issues: [] }]], s: { unblock: { queued: {} }, implemented: {} }, unlisted: () => [], delivered: new Set(),
    timeZone: 'UTC', held: {}, modes: {}, limitedOf: () => null, pauseText: () => null, modelFor: ({ agent }) => ({ model: `${agent}-m` }), exclusion: () => null };
  const rule = reassignedFrom => {
    const act = { type: 'implement', issue: 3, agent: 'codex', ...(reassignedFrom === 'absent' ? {} : { reassignedFrom }) };
    const rows = collectAssignments(team, { cache: { issues: [{ number: 3, state: 'OPEN', headRefName: '', labels: [] }], pulls: [] }, plan: [act], states: {}, activeJobs: [] });
    return rows[0].rule;
  };
  assert.match(rule('claude'), /reassigned from claude for allowance/);
  assert.doesNotMatch(rule(null), /reassigned/);
  assert.doesNotMatch(rule(undefined), /reassigned/);
  assert.doesNotMatch(rule('absent'), /reassigned/);
});
