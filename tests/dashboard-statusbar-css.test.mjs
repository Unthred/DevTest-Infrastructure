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

// True when the media condition applies at a 1100px-wide viewport: it has a min-width, every min-width is <= 1100px
// and every max-width is >= 1100px. Other breakpoints such as min-width:1000px therefore count, as do compound queries.
function appliesAt1100(query) {
  const px = (re) => [...query.matchAll(re)].map((m) => Number(m[1]));
  const mins = px(/min-width:(\d+(?:\.\d+)?)px/g), maxs = px(/max-width:(\d+(?:\.\d+)?)px/g);
  return mins.length > 0 && mins.every((v) => v <= 1100) && maxs.every((v) => v >= 1100);
}
// Rough specificity of one selector as a comparable number (ids, then classes/attributes/pseudo-classes, then elements).
function specificity(sel) {
  const s = sel.replace(/::?[\w-]+\([^)]*\)/g, ':x');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const cls = (s.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) || []).length;
  const els = (s.replace(/\.[\w-]+|#[\w-]+|\[[^\]]*\]|::?[\w-]+/g, ' ').match(/(?:^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return ids * 1e6 + cls * 1e3 + els;
}
// A selector targets the status bar when its last compound selector names the .statusbar class.
const targetsStatusbar = (sel) => /(?:^|[\s>+~])(?:[a-z][\w-]*)?(?:[.#][\w-]+)*\.statusbar(?:[.#:][\w-]+|\[[^\]]*\])*$/i.test(sel.trim());

// The flex-wrap declarations of rules targeting .statusbar at 1100px and wider: selector lists and more specific
// selectors (html .statusbar) included, with their specificity, in source order.
function desktopWrapRules(text) {
  const rules = [];
  for (const block of mediaBlocks(text, appliesAt1100)) {
    const inner = block.slice(block.indexOf('{') + 1, -1);
    for (const m of inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const specs = m[1].split(',').filter(targetsStatusbar).map(specificity);
      if (!specs.length) continue;
      for (const d of m[2].matchAll(/flex-wrap:([^;}]+)/g)) rules.push({ value: d[1].replace(/\s*!important$/, ''), important: /!important/.test(d[1]), spec: Math.max(...specs) });
    }
  }
  return rules;
}
// Winner by importance, then specificity, then source order; the winner is returned last.
function desktopWrapValues(text) {
  const rules = desktopWrapRules(text);
  if (!rules.length) return [];
  const rank = (r) => (r.important ? 1e12 : 0) + r.spec;
  const best = Math.max(...rules.map(rank));
  const winner = rules.filter((r) => rank(r) === best).at(-1);
  return rules.filter((r) => r !== winner).map((r) => r.value).concat(winner.value);
}

test('desktop status bar wraps at 1100px and wider, and nothing later overrides it', () => {
  const values = desktopWrapValues(css);
  assert.ok(values.length, 'no .statusbar flex-wrap rule at min-width:1100px');
  assert.equal(values.at(-1), 'wrap', `last desktop flex-wrap is ${values.at(-1)}`);
});

test('whitespace around the declaration does not matter', () => {
  assert.deepEqual(desktopWrapValues(normalise('@media(min-width:1100px){ .statusbar { flex-wrap : wrap } }')), ['wrap']);
});

test('agent item summary keeps a minimum height, taller on a phone', () => {
  const rules = [...css.matchAll(/\.agent-item summary\{[^}]*\}/g)].map(m => m[0]);
  assert.ok(rules.some(r => /min-height:28px/.test(r)), 'a desktop minimum height');
  assert.match(mediaBlock('max-width:639px'), /\.agent-item summary\{[^}]*min-height:44px/);
});

test('the agent item comment does not claim a single desktop row', () => {
  assert.doesNotMatch(rawCss, /stays on one row at desktop/);
});

test('guard detects regressions in mutated copies of the real CSS (negative cases)', () => {
  const same = rawCss + '\n@media(min-width:1100px){.statusbar{flex-wrap:nowrap}}';
  const compound = rawCss + '\n@media (min-width:1100px) and (max-width:1900px){.statusbar{ flex-wrap: nowrap }}';
  const adjacent = rawCss.replace('.statusbar{flex-wrap:wrap;gap:var(--sp2) var(--sp3)}', (m) => m + '\n  .statusbar{flex-wrap:nowrap}');
  const adjacentCompound = rawCss.replace('(min-width:1100px){.statusbar{gap:var(--sp2)}', (m) => m + '\n.statusbar{flex-wrap:nowrap}');
  assert.notEqual(adjacent, rawCss, 'mutation did not apply');
  assert.notEqual(adjacentCompound, rawCss, 'mutation did not apply');
  const removed = rawCss.replace('.statusbar{flex-wrap:wrap;gap:var(--sp2) var(--sp3)}', '.statusbar{gap:var(--sp2) var(--sp3)}');
  assert.notEqual(removed, rawCss, 'mutation did not apply');
  assert.equal(desktopWrapValues(css).at(-1), 'wrap');
  for (const mutated of [same, compound, adjacent, adjacentCompound]) assert.equal(desktopWrapValues(normalise(mutated)).at(-1), 'nowrap');
  assert.equal(desktopWrapValues(normalise(removed)).length, 0);
  assert.throws(() => mediaBlock('min-width:1'));
});

test('guard also catches selector lists, specific selectors and other breakpoints at 1100px', () => {
  const wrap = '@media(min-width:1100px){.statusbar{flex-wrap:wrap}}';
  const last = (extra) => desktopWrapValues(normalise(wrap + extra)).at(-1);
  assert.equal(last(''), 'wrap');
  assert.equal(last('@media(min-width:1100px){.x,.statusbar{flex-wrap:nowrap}}'), 'nowrap');
  assert.equal(last('@media(min-width:1100px){html .statusbar{flex-wrap:nowrap}}'), 'nowrap');
  assert.equal(last('@media(min-width:1000px){.statusbar{flex-wrap:nowrap}}'), 'nowrap');
  assert.equal(last('@media(min-width:1000px) and (max-width:1200px){div.statusbar:hover{flex-wrap:nowrap}}'), 'nowrap');
  assert.equal(last('@media(min-width:1100px){.statusbar{flex-wrap:nowrap!important}}'), 'nowrap');
  // Positive: rules that cannot apply at 1100px, or target other elements, are not overrides.
  assert.equal(last('@media(min-width:1200px){.statusbar{flex-wrap:nowrap}}'), 'wrap');
  assert.equal(last('@media(min-width:900px) and (max-width:1000px){.statusbar{flex-wrap:nowrap}}'), 'wrap');
  assert.equal(last('@media(min-width:1100px){.statusbar-x,.other{flex-wrap:nowrap}}'), 'wrap');
  assert.equal(last('@media(min-width:1100px){.statusbar .child{flex-wrap:nowrap}}'), 'wrap');
  // A later, less specific rule does not beat an earlier, more specific one.
  assert.equal(desktopWrapValues(normalise('@media(min-width:1100px){html .statusbar{flex-wrap:wrap}.statusbar{flex-wrap:nowrap}}')).at(-1), 'wrap');
});
