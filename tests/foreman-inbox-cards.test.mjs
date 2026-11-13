import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInbox } from '../foreman-mcp/inbox.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const hex = n => n.toString(16).padStart(32, 'a');
const STATES = ['pending', 'approved', 'running', 'done', 'failed', 'refused', 'rejected'];

function snapshot(dir) {
  const out = {};
  for (const sub of ['items', 'status']) {
    for (const name of fs.readdirSync(path.join(dir, sub)).sort()) {
      const file = path.join(dir, sub, name);
      out[`${sub}/${name}`] = [fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs];
    }
  }
  return out;
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'inbox-cards-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'items'));
  fs.mkdirSync(path.join(dir, 'status'));
  STATES.forEach((state, i) => {
    const id = hex(i + 1);
    const created = NOW - (i + 1) * 60000 * 10;
    fs.writeFileSync(path.join(dir, 'status', `${id}.json`), JSON.stringify({ id, state, kind: 'prompt', title: `Card ${state}`, createdAt: created }));
    fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify({ kind: 'prompt', title: `Card ${state}`, prompt: `First line of ${state}\nsecond line` }));
  });
  const idS = hex(99);
  fs.writeFileSync(path.join(dir, 'items', `${idS}.json`), JSON.stringify({ kind: 'issue_draft', title: "Owner's draft", body: 'text' }));
  fs.utimesSync(path.join(dir, 'items', `${idS}.json`), new Date(NOW - 5 * 60000), new Date(NOW - 5 * 60000));
  return dir;
}

const approvals = [{ id: 'retrycap-1', tier: 'decision', title: "Decision: don't retry", why: 'w', options: 'o' }];
const toolsFor = dir => createTools({
  source: { get: async () => ({ view: { panels: { approvals } }, ageMs: 0 }) },
  readHost: () => ({}),
  inbox: createInbox({ dir }),
  now: () => NOW,
});
const call = async (tools, args) => JSON.parse((await tools.call('foreman_inbox', args)).text);

test('foreman_inbox is registered with a schema and lists cards newest first', async t => {
  const tools = toolsFor(fixture(t));
  const def = tools.list().find(tool => tool.name === 'foreman_inbox');
  assert.ok(def);
  assert.deepEqual(def.inputSchema.properties.state.enum, ['submitted', 'pending', 'approved', 'running', 'done', 'failed', 'refused', 'rejected']);
  const result = await call(tools, { limit: 100 });
  const ages = result.cards.map(card => card.ageMinutes).filter(age => age !== null);
  assert.deepEqual(ages, [...ages].sort((a, b) => a - b));
  assert.equal(result.cards[0].state, 'submitted');
  assert.equal(result.cards[0].ageMinutes, 5);
  assert.equal(result.cards[0].proposedBy, 'overseer');
  const states = new Set(result.cards.map(card => card.state));
  for (const state of ['submitted', 'pending', 'approved', 'running', 'done', 'failed', 'rejected']) assert.ok(states.has(state), state);
  assert.ok(!states.has('refused'), 'refused is hidden unless asked for');
  const decision = result.cards.find(card => card.kind === 'decision');
  assert.equal(decision.proposedBy, 'system');
  assert.equal(result.cards.at(-1), decision, 'a card with no time sorts last');
  assert.equal(decision.title, "Decision: don't retry");
  const prompt = result.cards.find(card => card.state === 'done');
  assert.equal(prompt.firstLine, 'First line of done');
  assert.equal(prompt.id.length, 8);
});

test('foreman_inbox filters by state, shows refused on request and applies the limit', async t => {
  const tools = toolsFor(fixture(t));
  assert.deepEqual((await call(tools, { state: 'failed' })).cards.map(card => card.state), ['failed']);
  assert.deepEqual((await call(tools, { state: 'refused' })).cards.map(card => card.state), ['refused']);
  assert.deepEqual((await call(tools, { state: 'submitted' })).cards.map(card => card.title), ["Owner's draft"]);
  const limited = await call(tools, { limit: 3 });
  assert.equal(limited.cards.length, 3);
  assert.ok(limited.count > 3);
  assert.equal((await call(tools, {})).shown, Math.min(20, (await call(tools, {})).count));
  assert.equal((await tools.call('foreman_inbox', { state: 'bogus' })).isError, true);
  assert.equal((await tools.call('foreman_inbox', { limit: 0 })).isError, true);
});

test('foreman_inbox returns an apostrophe title unchanged and redacts secret-shaped text', async t => {
  const dir = fixture(t);
  const id = hex(200);
  const secret = ['gh', 'p_', 'A'.repeat(30)].join('');
  fs.writeFileSync(path.join(dir, 'status', `${id}.json`), JSON.stringify({ id, state: 'pending', kind: 'prompt', title: "Homeowner's Q4 'plan'", createdAt: NOW - 1000 }));
  fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify({ kind: 'prompt', title: "Homeowner's Q4 'plan'", prompt: `use ${secret} now` }));
  const result = await call(toolsFor(dir), {});
  const card = result.cards.find(c => c.id === id.slice(0, 8));
  assert.equal(card.title, "Homeowner's Q4 'plan'");
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.match(card.firstLine, /redacted/);
});

test('foreman_inbox writes nothing', async t => {
  const dir = fixture(t);
  const before = snapshot(dir);
  const tools = toolsFor(dir);
  await call(tools, {});
  await call(tools, { state: 'submitted' });
  assert.deepEqual(snapshot(dir), before);
});
