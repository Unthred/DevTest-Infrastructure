// Issue #996: one pull request's review refusal is that PR's own hold reason; it must not become the lane-wide reason shown on other PRs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Team } from '../supervisor/team.mjs';

const fresh = () => { const t = Object.create(Team.prototype); t.held = {}; t.heldPr = {}; t.heldLane = {}; return t; };

test('a per-PR review refusal is kept for that PR and for the pooled list, but not in the lane-wide reason', () => {
  const t = fresh();
  t.hold('claude', 'review', 'review refused: the writer of this head is unknown', 994);
  assert.equal(t.heldPr['claude:review:994'], 'review refused: the writer of this head is unknown');
  assert.match(t.held.claude.review, /writer of this head is unknown/, 'the pooled record still lists it');
  assert.equal(t.heldLane.claude?.review, undefined, 'another PR in the lane is not labelled with it');
});

test('a hold that is not about one PR is the lane-wide reason', () => {
  const t = fresh();
  t.hold('claude', 'review', 'review refused: unknown writer', 994);
  t.hold('claude', 'review', 'out of allowance');
  assert.equal(t.heldLane.claude.review, 'out of allowance');
});

test('the dashboard falls back to the lane-wide reason only', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../supervisor/dashboard.mjs', import.meta.url), 'utf8');
  assert.match(src, /team\.heldLane\?\.\[reviewer\]\?\.review/);
  assert.doesNotMatch(src, /team\.held\[reviewer\]\.review/);
});
