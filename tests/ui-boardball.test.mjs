// Issue #1317: the pure module of what a ball and a lane look like (families, letter, accessible name, lane text), the icon store with an
// injected fetch, and the contrast of the four family colours measured from the stylesheet in both themes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FAMILIES, familyOf, familyClass, agentIdOf, ballLetter, ballShape, iconPathOk, accessibleName, agentAndModel, laneModelText, laneTextPlan, LANE_TEXT }
  from '../supervisor/ui/boardball.mjs';
import { IconStore } from '../supervisor/ui/boardicons.mjs';
import { LAYOUT } from '../supervisor/ui/boardlayout.mjs';

const agent = (id, extra = {}) => ({ id, display_name: id, icon: null, ...extra });
const lane = (agentId, model) => ({ id: `${agentId}/${model ?? 'default'}`, agent: agentId, model, job_types: ['implement'] });
const data = () => ({ agents: [agent('claude', { icon: '/api/v1/agent-icon/claude' }), agent('codex')],
  lanes: [lane('claude', 'sonnet'), lane('claude', 'opus'), lane('codex', null)], waiting: [], running: [], landed: [] });
const review1244 = { job_id: '6ff7be3f', lane_id: 'claude/opus', job_type: 'review', number: 1244 };
const implement1307 = { job_id: 'aaaa1307', lane_id: 'claude/sonnet', job_type: 'implement', number: 1307 };
const codex1166 = { job_id: 'db849b9f', lane_id: 'codex/default', job_type: 'implement', number: 1166 };

test('the eight job types fall into the four families, and an Inbox job is housekeeping', () => {
  const expected = { implement: 'new', continue: 'new', split: 'new', fix: 'fixing', 'ci-fix': 'fixing', cifix: 'fixing', review: 'review', 'interim-review': 'review',
    rebase: 'housekeeping', inbox: 'housekeeping' };
  for (const [type, family] of Object.entries(expected)) assert.equal(familyOf(type), family, type);
  assert.deepEqual(FAMILIES.map(family => family.id), ['new', 'fixing', 'review', 'housekeeping']);
  assert.equal(familyClass('review'), 'family-review');
});

test('an unknown, empty or missing job type is housekeeping', () => {
  for (const type of ['mystery', '', undefined, null, 42]) assert.equal(familyOf(type), 'housekeeping');
});

test('the review job 6ff7be3f is review, the implement job on issue 1307 is new work', () => {
  assert.equal(familyOf(review1244.job_type), 'review');
  assert.equal(familyOf(implement1307.job_type), 'new');
});

test('accessible name: job type, issue or pull request number, agent, model', () => {
  assert.equal(accessibleName(review1244, data()), 'review, pull request 1244, claude, opus');
  assert.equal(accessibleName(implement1307, data()), 'implement, issue 1307, claude, sonnet');
  assert.equal(accessibleName(codex1166, data()), 'implement, issue 1166, codex, default model');
});

test('accessible name of a waiting ball: tied to an agent, tied to none, no number', () => {
  const tied = { place: 1, job_type: 'implement', number: 1313, tied_agent: 'claude' };
  assert.equal(accessibleName(tied, data()), 'implement, issue 1313, claude, no model yet');
  assert.equal(accessibleName({ ...tied, tied_agent: null, job_type: 'review', number: null }, data()), 'review, no number, no agent yet, no model yet');
  assert.equal(agentAndModel(tied, data()), 'claude, no model yet');
});

test('the letter is the first letter of the display name: codex gives c', () => {
  assert.equal(ballLetter(data(), 'codex'), 'c');
  assert.equal(ballLetter(data(), 'claude'), 'c');
});

test('boundary: an empty display name, a null agent and an agent the model does not list', () => {
  const d = data();
  d.agents.push(agent('blank', { display_name: '   ' }), agent('empty', { display_name: '' }));
  assert.equal(ballLetter(d, 'blank'), '');
  assert.equal(ballLetter(d, 'empty'), '');
  assert.equal(ballLetter(d, null), '');
  assert.equal(ballLetter(d, undefined), '');
  assert.equal(ballLetter(d, 'ghost'), 'g');
  assert.equal(ballLetter({ ...d, agents: [agent('x', { display_name: '😀smile' })] }, 'x'), '😀');
});

test('shape: the icon only when its address is known, else a disc with the letter; no agent gives a disc with no letter', () => {
  const href = 'data:image/svg+xml;base64,AAAA';
  assert.deepEqual(ballShape(data(), 'claude', href), { icon: href, letter: 'c' });
  assert.deepEqual(ballShape(data(), 'codex', null), { icon: null, letter: 'c' });
  assert.deepEqual(ballShape(data(), null, href), { icon: null, letter: '' });
});

test('agent of a ball: the agent of its lane, else the tied agent, else none', () => {
  assert.equal(agentIdOf(review1244, data()), 'claude');
  assert.equal(agentIdOf({ tied_agent: 'codex' }, data()), 'codex');
  assert.equal(agentIdOf({ tied_agent: null }, data()), null);
  assert.equal(agentIdOf({}, data()), null);
});

test('only addresses under the agent icon route are used', () => {
  assert.equal(iconPathOk('/api/v1/agent-icon/claude'), true);
  for (const bad of [null, undefined, '', 'https://example.org/x.svg', '//example.org/api/v1/agent-icon/x', '/api/v1/agent-icon/', '/api/v1/agent-icon/../x',
    '/api/v1/agent-icon/a/b', '/other/claude', 42]) assert.equal(iconPathOk(bad), false, String(bad));
});

test('lane text: a null model reads default model, a name stays as it is', () => {
  assert.equal(laneModelText(null), 'default model');
  assert.equal(laneModelText(''), 'default model');
  assert.equal(laneModelText('opus'), 'opus');
});

const { laneTop: top, laneBottom: bottom } = LAYOUT;
const middle = (top + bottom) / 2;
test('lane text with no balls stays at the foot, reading upward from it', () => {
  const plan = laneTextPlan('opus', [], top, bottom);
  assert.equal(plan.half, 'foot');
  assert.equal(plan.startY, bottom - LANE_TEXT.foot);
  assert.equal(plan.text, 'opus');
});

test('lane text with one ball: the half the ball is not in', () => {
  assert.equal(laneTextPlan('opus', [bottom - 20], top, bottom).half, 'head');
  assert.equal(laneTextPlan('opus', [top + 20], top, bottom).half, 'foot');
  const head = laneTextPlan('opus', [bottom - 20], top, bottom);
  assert.ok(head.startY <= middle - LANE_TEXT.ballRadius, 'the text starts clear of a ball just under the middle');
  const foot = laneTextPlan('opus', [middle - 1], top, bottom);
  assert.equal(foot.half, 'foot');
});

test('lane text with two running balls in one lane stays at the foot', () => {
  const plan = laneTextPlan('opus', [top + 20, bottom - 20], top, bottom);
  assert.equal(plan.half, 'foot');
  assert.equal(plan.startY, bottom - LANE_TEXT.foot);
});

test('a long model name is shortened to the room it has and never overruns the lane', () => {
  const long = 'a-very-long-model-name-that-cannot-fit-in-a-lane-at-all';
  for (const balls of [[], [top + 20], [bottom - 20], [top + 20, bottom - 20]]) {
    const plan = laneTextPlan(long, balls, top, bottom);
    assert.ok(plan.text.length * LANE_TEXT.charWidth <= bottom - top, `${balls.length} balls`);
    assert.ok(plan.text.endsWith('…'));
  }
});

test('codex implement job db849b9f on a lane with a null model: default model, and no icon so the letter c', () => {
  const d = data();
  const found = d.lanes.find(candidate => candidate.id === codex1166.lane_id);
  assert.equal(laneTextPlan(found.model, [], top, bottom).text, 'default model');
  assert.deepEqual(ballShape(d, agentIdOf(codex1166, d), null), { icon: null, letter: 'c' });
});

// The icon store, with the network and the image check replaced.
const svgResponse = (status = 200, type = 'image/svg+xml') => ({ ok: status === 200, status, headers: { get: () => type }, arrayBuffer: async () => new TextEncoder().encode('<svg/>').buffer });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('an icon is requested once per agent, whatever the number of model changes', async () => {
  const asked = [];
  const store = new IconStore(() => {}, { fetchFn: async path => { asked.push(path); return svgResponse(); }, probe: async () => true });
  const agents = data().agents;
  store.request(agents);
  store.request(agents);
  store.request(agents);
  await settle();
  assert.deepEqual(asked, ['/api/v1/agent-icon/claude']);
  assert.match(store.href('claude'), /^data:image\/svg\+xml;base64,/);
  assert.equal(store.href('codex'), null);
});

test('an icon that answers 404, is not an svg, throws or fails to decode leaves the disc', async () => {
  for (const [name, deps] of [
    ['404', { fetchFn: async () => svgResponse(404) }],
    ['wrong type', { fetchFn: async () => svgResponse(200, 'text/html') }],
    ['network error', { fetchFn: async () => { throw new Error('down'); } }],
    ['does not decode', { fetchFn: async () => svgResponse(), probe: async () => false }],
  ]) {
    let redraws = 0;
    const store = new IconStore(() => { redraws += 1; }, { probe: async () => true, ...deps });
    store.request(data().agents);
    await settle();
    assert.equal(store.href('claude'), null, name);
    assert.equal(redraws, 0, name);
  }
});

test('a closed store neither requests nor redraws', async () => {
  let asked = 0, redraws = 0;
  const store = new IconStore(() => { redraws += 1; }, { fetchFn: async () => { asked += 1; return svgResponse(); }, probe: async () => true });
  store.close();
  store.request(data().agents);
  await settle();
  assert.deepEqual([asked, redraws], [0, 0]);
});

test('a path outside the icon route is never requested', async () => {
  let asked = 0;
  const store = new IconStore(() => {}, { fetchFn: async () => { asked += 1; return svgResponse(); }, probe: async () => true });
  store.request([agent('x', { icon: 'https://example.org/x.svg' }), agent('y', { icon: null })]);
  await settle();
  assert.equal(asked, 0);
});

// Contrast: the four colours are read from board.css and the surfaces from app.css, so the figures cannot drift from the files.
const channel = value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const board = fs.readFileSync(new URL('../supervisor/ui/board.css', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../supervisor/ui/app.css', import.meta.url), 'utf8');
const variable = (css, name) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
const darkApp = app.slice(app.indexOf('[data-theme="dark"]'));

test('every family colour is at least 3 to 1 against the board background in both themes, and the letter 4.5 to 1 against its disc', () => {
  const surfaces = { light: variable(app, 'surface'), dark: variable(darkApp, 'surface') };
  const darkBoard = board.slice(board.indexOf('[data-theme="dark"]'));
  const letter = variable(board, 'on-ball');
  assert.ok(surfaces.light && surfaces.dark && letter);
  for (const family of FAMILIES) {
    const light = variable(board, `family-${family.id}`);
    const dark = variable(darkBoard, `family-${family.id}`) ?? light;
    assert.ok(light, family.id);
    assert.ok(contrast(light, surfaces.light) >= 3, `${family.id} light ${contrast(light, surfaces.light).toFixed(2)}`);
    assert.ok(contrast(dark, surfaces.dark) >= 3, `${family.id} dark ${contrast(dark, surfaces.dark).toFixed(2)}`);
    assert.ok(contrast(letter, light) >= 4.5 && contrast(letter, dark) >= 4.5, `${family.id} letter`);
  }
});

test('the four family colours are different from one another', () => {
  const colours = FAMILIES.map(family => variable(board, `family-${family.id}`));
  assert.equal(new Set(colours).size, 4);
});
