// Static guard for the dashboard header CSS (issue #654). The browser smoke is Tower-only, so CI checks the rules it protects.
// This is a cheap guard, not a rendering check: it reads the source order of rules, not the computed style. The Tower
// browser smoke remains the authority on what actually wins in a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const rawCss = fs.readFileSync(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8');
// Comments removed and whitespace collapsed, so "flex-wrap: wrap" and "flex-wrap:wrap" are the same.
const normalise = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{}:;,])\s*/g, '$1');
const css = normalise(rawCss);

// Every block opened by an @media whose condition satisfies `matches`, so compound queries are included.
function mediaBlocks(text, matches) {
  const out = [], re = /@media([^{]*)\{/g;
  for (let m; (m = re.exec(text)); ) {
    if (!matches(m[1])) continue;
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) { out.push(text.slice(m.index, i + 1)); break; }
    }
  }
  return out;
}
function mediaBlock(query, text = css) {
  const out = mediaBlocks(text, (q) => q === `(${query})`);
  assert.ok(out.length, `missing @media(${query})`);
  return out.join('\n');
}

// The flex-wrap values a plain .statusbar rule takes at 1100px and wider, in source order. The last one wins;
// any @media whose query includes min-width:1100px counts, compound queries too.
function desktopWrapValues(text) {
  const values = [];
  for (const block of mediaBlocks(text, (q) => q.includes('min-width:1100px'))) {
    for (const m of block.matchAll(/(?:^|[{}])\.statusbar\{([^}]*)\}/g)) {
      for (const d of m[1].matchAll(/flex-wrap:([^;}]+)/g)) values.push(d[1]);
    }
  }
  return values;
}

test('desktop status bar wraps at 1100px and wider, and nothing later overrides it', () => {
  const values = desktopWrapValues(css);
  assert.ok(values.length, 'no .statusbar flex-wrap rule at min-width:1100px');
  assert.equal(values.at(-1), 'wrap', `last desktop flex-wrap is ${values.at(-1)}`);
});

test('whitespace around the declaration does not matter', () => {
  assert.deepEqual(desktopWrapValues(normalise('@media(min-width:1100px){ .statusbar { flex-wrap : wrap } }')), ['wrap']);
});

test('agent badge keeps a minimum height, taller on a phone', () => {
  const rule = css.match(/(?:^|\})\.agent-badge\{[^}]*\}/)?.[0] ?? '';
  assert.match(rule, /min-height:24px/);
  assert.match(mediaBlock('max-width:639px'), /\.agent-badge\{[^}]*min-height:44px/);
});

test('the agent-badge comment does not claim a single desktop row', () => {
  assert.doesNotMatch(rawCss, /stays on one row at desktop/);
});

test('guard detects regressions in mutated copies of the real CSS (negative cases)', () => {
  const same = rawCss + '\n@media(min-width:1100px){.statusbar{flex-wrap:nowrap}}';
  const compound = rawCss + '\n@media (min-width:1100px) and (max-width:1900px){.statusbar{ flex-wrap: nowrap }}';
  const removed = rawCss.replace('.statusbar{flex-wrap:wrap;gap:var(--sp2) var(--sp3)}', '.statusbar{gap:var(--sp2) var(--sp3)}');
  assert.notEqual(removed, rawCss, 'mutation did not apply');
  assert.equal(desktopWrapValues(css).at(-1), 'wrap');
  for (const mutated of [same, compound]) assert.equal(desktopWrapValues(normalise(mutated)).at(-1), 'nowrap');
  assert.equal(desktopWrapValues(normalise(removed)).length, 0);
  assert.throws(() => mediaBlock('min-width:1'));
});
