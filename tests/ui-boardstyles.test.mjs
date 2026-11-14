// Issue #1315: the list of board styles, the choice rule, the loading and saving of the choice, and the peg style against the shared rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLE_NAMES, chooseStyle, showSwitch, stepStyle, loadedInOrder } from '../supervisor/ui/boardstyles.mjs';
import { loadStyles, readChoice, saveChoice, STYLE_KEY } from '../supervisor/ui/boardswitch.mjs';
import * as peg from '../supervisor/ui/boardstyle-peg.mjs';
import { planChange } from '../supervisor/ui/boardmotion.mjs';
import { checkStyleRules, checkStyleReadsNoRandomOrClock, checkOtherKinds, boardWith } from './boardstyle-rules.mjs';

const quiet = () => {};

test('valid: the list is peg, marble, launch in that order and peg is the default', () => {
  assert.deepEqual([...STYLE_NAMES], ['peg', 'marble', 'launch']);
  assert.equal(chooseStyle(undefined, ['peg']), 'peg');
});

test('valid: a saved name whose style loaded is chosen', () => {
  assert.equal(chooseStyle('marble', ['peg', 'marble']), 'marble');
});

test('boundary: a saved name that is not in the list gives peg', () => {
  assert.equal(chooseStyle('plaid', ['peg', 'marble']), 'peg');
});

test('boundary: a saved name whose style did not load gives peg', () => {
  assert.equal(chooseStyle('launch', ['peg', 'marble']), 'peg');
});

test('invalid: a saved value that is not text gives peg', () => {
  for (const saved of [null, 7, {}, ['marble']]) assert.equal(chooseStyle(saved, ['peg', 'marble']), 'peg');
});

test('boundary: only peg loaded shows no switch; two shows it; a name outside the list does not count', () => {
  assert.equal(showSwitch(['peg']), false);
  assert.equal(showSwitch(['peg', 'plaid']), false);
  assert.equal(showSwitch(['peg', 'marble']), true);
  assert.deepEqual(loadedInOrder(['launch', 'plaid', 'peg']), ['peg', 'launch']);
});

test('valid: arrow keys step through the loaded styles and wrap; other keys do nothing', () => {
  const loaded = ['peg', 'marble', 'launch'];
  assert.equal(stepStyle(loaded, 'peg', 'ArrowRight'), 'marble');
  assert.equal(stepStyle(loaded, 'launch', 'ArrowDown'), 'peg');
  assert.equal(stepStyle(loaded, 'peg', 'ArrowLeft'), 'launch');
  assert.equal(stepStyle(['peg', 'launch'], 'peg', 'ArrowUp'), 'launch');
  assert.equal(stepStyle(loaded, 'peg', 'Enter'), null);
  assert.equal(stepStyle([], 'peg', 'ArrowRight'), null);
});

const fakeStyle = (name, extra = {}) => ({ name, label: name.toUpperCase(), draw: () => ({ defs: [], nodes: [] }), plan: () => ({ points: [], durationMs: 1 }), ...extra });

test('valid: styles that load are kept in list order and peg is always present', async () => {
  const warnings = [];
  const styles = await loadStyles({ importStyle: async name => fakeStyle(name), warn: line => warnings.push(line) });
  assert.deepEqual([...styles.keys()], ['peg', 'marble', 'launch']);
  assert.equal(styles.get('peg'), peg);
  assert.deepEqual(warnings, []);
});

test('invalid: a style that does not load is left out with one console line each, and peg stays', async () => {
  const warnings = [];
  const styles = await loadStyles({
    importStyle: async name => { if (name === 'marble') throw new Error('404'); return fakeStyle(name); },
    warn: line => warnings.push(line),
  });
  assert.deepEqual([...styles.keys()], ['peg', 'launch']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /marble/);
});

test('invalid: nothing loads, or a module has the wrong shape or name, gives peg alone', async () => {
  const warnings = [];
  const none = await loadStyles({ importStyle: async () => { throw new Error('404'); }, warn: line => warnings.push(line) });
  assert.deepEqual([...none.keys()], ['peg']);
  assert.equal(warnings.length, 2);
  const odd = await loadStyles({ importStyle: async name => (name === 'marble' ? { name: 'marble' } : fakeStyle('other')), warn: quiet });
  assert.deepEqual([...odd.keys()], ['peg']);
});

const memory = () => {
  const held = new Map();
  return { getItem: key => held.get(key) ?? null, setItem: (key, value) => held.set(key, value) };
};

test('valid: the choice is saved and read back', () => {
  const storage = memory();
  assert.equal(saveChoice(storage, 'marble'), true);
  assert.equal(storage.getItem(STYLE_KEY), 'marble');
  assert.equal(readChoice(storage), 'marble');
});

test('invalid: storage that throws on read gives no choice, and on write reports it was not kept', () => {
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } };
  assert.equal(readChoice(broken), null);
  assert.equal(saveChoice(broken, 'marble'), false);
  assert.equal(readChoice(null), null);
  assert.equal(saveChoice(null, 'marble'), false);
});

test('valid: the peg style has the shape of a style', () => {
  assert.equal(peg.name, 'peg');
  assert.equal(peg.label, 'Peg board');
  assert.equal(typeof peg.draw, 'function');
  assert.equal(typeof peg.plan, 'function');
});

test('valid: the peg style meets the shared path rules for one, two and six lanes', () => {
  checkStyleRules(peg);
  checkOtherKinds(peg);
});

test('valid: the peg style reads no random numbers and no clock', () => {
  checkStyleReadsNoRandomOrClock(peg);
});

// Review job 6ff7be3f on pull request 1244 (agent claude, model opus, verdict CHANGES) and the implement job on issue 1307
// (claude, sonnet) landing in To review, each planned twice through the real planChange.
const job = (id, laneId, number, type, box) => ({ job_id: id, lane_id: laneId, job_type: type, number, title: null, laps: 0,
  ended_at: '2026-11-13T08:45:00Z', box, tokens: 1, cost_pence: 1 });
const run = (id, laneId, number, type) => ({ job_id: id, lane_id: laneId, job_type: type, number, title: null, laps: 0, started_at: '2026-11-13T08:00:00Z', typical_seconds: 300 });
const lanes = [{ id: 'claude/sonnet', agent: 'claude', model: 'sonnet', job_types: ['implement'] }, { id: 'claude/opus', agent: 'claude', model: 'opus', job_types: ['review'] }];
const world = parts => ({ ...boardWith(2), lanes, ...parts });

test('valid: the two real landings are planned twice through the peg style with identical paths ending in their boxes', () => {
  const cases = [
    [run('6ff7be3f', 'claude/opus', 1244, 'review'), job('6ff7be3f', 'claude/opus', 1244, 'review', 'changes_asked'), 'changes_asked'],
    [run('aaaa1307', 'claude/sonnet', 1307, 'implement'), job('aaaa1307', 'claude/sonnet', 1307, 'implement', 'to_review'), 'to_review'],
  ];
  for (const [before, after, boxId] of cases) {
    const make = () => planChange(world({ running: [before], landed: [{ ...after, job_id: 'old', box: 'merged', number: 1 }] }), world({ landed: [after] }),
      { width: 1280, now: 0, style: peg }, quiet).travels.find(travel => travel.kind === 'land');
    const [one, two] = [make(), make()];
    assert.deepEqual(one, two);
    assert.ok(one.durationMs >= 1500 && one.durationMs <= 3000);
    assert.ok(one.points.length > 3, `${boxId} path has bounces`);
  }
});

test('boundary: an unknown box name lands in Done', () => {
  const before = world({ running: [run('aaaa1307', 'claude/sonnet', 1307, 'implement')], landed: [job('old', 'claude/opus', 1, 'review', 'merged')] });
  const after = world({ landed: [job('aaaa1307', 'claude/sonnet', 1307, 'implement', 'mystery_box'), before.landed[0]] });
  const [land] = planChange(before, after, { width: 1280, now: 0, style: peg }, quiet).travels;
  assert.equal(land.kind, 'land');
  assert.ok(land.points.at(-1).y > 0);
  const done = planChange(before, { ...after, landed: [{ ...after.landed[0], box: 'done' }, before.landed[0]] }, { width: 1280, now: 0, style: peg }, quiet).travels[0];
  assert.deepEqual(land.points.at(-1), done.points.at(-1));
});

test('valid: a style passed to planChange decides the path', () => {
  const before = world({ running: [run('aaaa1307', 'claude/sonnet', 1307, 'implement')] });
  const after = world({ landed: [job('aaaa1307', 'claude/sonnet', 1307, 'implement', 'to_review')] });
  const straight = { ...fakeStyle('straight'), plan: ({ from, to }) => ({ points: [from, to], durationMs: 1500 }) };
  const { travels } = planChange(before, after, { width: 1280, now: 0, style: straight }, quiet);
  assert.equal(travels[0].points.length, 2);
});

test('invalid: the shared rules fail a style that breaks them (random numbers, a land outside its box, too short)', () => {
  const planAs = change => ({ ...peg, name: 'broken', plan: input => ({ ...peg.plan(input), ...change(input) }) });
  assert.throws(() => checkStyleRules(planAs(() => ({ durationMs: 500 }))), /1.5 to 3 seconds/);
  assert.throws(() => checkStyleRules(planAs(input => ({ points: [input.from, { x: 0, y: 0 }] }))), /inside its box/);
  assert.throws(() => checkStyleRules(planAs(input => ({ points: [input.from, { x: -5, y: 10 }, input.to] }))), /stays on the board/);
  assert.throws(() => checkStyleRules(planAs(() => ({ durationMs: Math.random() * 100 + 1500 }))), /same path/);
  assert.throws(() => checkStyleReadsNoRandomOrClock({ ...peg, plan: () => ({ points: [], durationMs: Date.now() }) }), /clock read/);
});
