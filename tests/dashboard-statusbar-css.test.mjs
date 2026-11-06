// Static guard for the dashboard header CSS (issue #654). The browser smoke is Tower-only, so CI checks the rules it protects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8');

// Every block opened by @media(query){ joined, since a query can appear more than once.
function mediaBlock(query) {
  const open = `@media(${query}){`, out = [];
  for (let at = css.indexOf(open); at >= 0; at = css.indexOf(open, at + 1)) {
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) { out.push(css.slice(at, i + 1)); break; }
    }
  }
  assert.ok(out.length, `missing @media(${query})`);
  return out.join('\n');
}

test('desktop status bar wraps at 1100px and wider', () => {
  assert.match(mediaBlock('min-width:1100px'), /\.statusbar\{[^}]*flex-wrap:wrap/);
});

test('agent badge keeps a minimum height, taller on a phone', () => {
  const rule = css.match(/^\.agent-badge\{[^}]*\}/m)?.[0] ?? '';
  assert.match(rule, /min-height:24px/);
  assert.match(mediaBlock('max-width:639px'), /\.agent-badge\{[^}]*min-height:44px/);
});

test('the agent-badge comment does not claim a single desktop row', () => {
  assert.doesNotMatch(css, /stays on one row at desktop/);
});

test('guard detects a regression (negative case)', () => {
  assert.throws(() => assert.match('.statusbar{flex-wrap:nowrap}', /\.statusbar\{[^}]*flex-wrap:wrap/));
});
