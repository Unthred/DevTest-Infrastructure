import test from 'node:test';
import assert from 'node:assert/strict';
import { COMBINATION_SEED, FIXTURE_STATES, seededStates } from './fixtures/planner-invariants/states.mjs';
import { assertPlanInvariants, createPlannerWorld, invariantViolations, validPlan } from './helpers/planner-invariants.mjs';

async function planState(t, state) {
  const world = createPlannerWorld(t, state);
  const plan = await world.team.plan();
  return {
    plan,
    team: world.team,
    pulls: world.pulls,
    issues: world.issues,
    breaker: { verdicts: world.team.s.verdicts, breaker: world.team.s.breaker, config: world.team.c },
    state,
    seed: state.seed,
  };
}

test('planner invariants hold for table fixtures and bounded seeded combinations', async t => {
  const states = [...FIXTURE_STATES, ...seededStates()];
  for (const state of states) {
    await t.test(state.name, async t => assertPlanInvariants(await planState(t, state)));
  }
});

test('planner invariant harness accepts a valid plan and boundary states', async t => {
  const empty = await planState(t, { name: 'empty', pulls: [], issues: [] });
  assertPlanInvariants(empty);
  const slotsFull = await planState(t, {
    name: 'slot-limits',
    pulls: [],
    issues: [
      { number: 1, title: 'Issue 1', state: 'OPEN', body: '', labels: [], agent: 'claude' },
      { number: 2, title: 'Issue 2', state: 'OPEN', body: '', labels: [], agent: 'codex' },
    ],
    activeJobs: [
      { id: 'active-claude', provider: 'claude', status: 'running' },
      { id: 'active-codex', provider: 'codex', status: 'running' },
    ],
    jobRecords: {
      'active-claude': { kind: 'implement', agent: 'claude', issue: 90 },
      'active-codex': { kind: 'implement', agent: 'codex', issue: 91 },
    },
  });
  assertPlanInvariants(slotsFull);
  assert.deepEqual(slotsFull.plan, []);
  assert.match(slotsFull.team.held.claude.implement, /implementer slot full/);
  assert.match(slotsFull.team.held.codex.implement, /implementer slot full/);
  assert.deepEqual(invariantViolations({ ...empty, plan: validPlan() }), []);
});

test('planner invariant harness catches each included invalid rule', () => {
  const head = 'a'.repeat(40);
  const pulls = [{ number: 10, headRefName: 'claude/issue-1-fixture', headRefOid: head, labels: [] }];
  const issues = [{ number: 1, labels: [] }];
  const base = { pulls, issues, breaker: { verdicts: {}, breaker: {}, config: { breaker: { enabled: true } } } };
  const cases = [
    ['merge-current-changes', {
      ...base,
      breaker: { ...base.breaker, verdicts: { [`10:${head}`]: { verdict: 'CHANGES' } } },
      plan: [{ type: 'merge', pr: 10 }],
      expected: 'merge-current-changes',
    }],
    ['breaker-halt', {
      ...base,
      breaker: { ...base.breaker, breaker: { halts: { stopped: { types: ['fix'], subjects: ['pr:10'] } } } },
      plan: [{ type: 'fix', pr: 10 }],
      expected: 'breaker-halt',
    }],
    ['parked', { ...base, issues: [{ number: 1, labels: ['parked'] }], plan: [{ type: 'fix', pr: 10 }], expected: 'parked' }],
    ['one-action-per-pr', { ...base, plan: [{ type: 'fix', pr: 10 }, { type: 'review', pr: 10 }], expected: 'one-action-per-pr' }],
  ];
  for (const [name, context] of cases) {
    assert.ok(invariantViolations(context).some(violation => violation.invariant === context.expected), name);
  }
});

test('seeded combination generation is deterministic', () => {
  assert.deepEqual(seededStates({ seed: COMBINATION_SEED, count: 8 }), seededStates({ seed: COMBINATION_SEED, count: 8 }));
});
