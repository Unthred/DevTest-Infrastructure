// Issue #651 (follow-up to #591): independenceRefusal is the one check for decisions about an actual review. The only code allowed to
// call independentOf or writersOf directly is listed here, so a new direct call site fails this test until it is reviewed and added.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PERMITTED = {
  independentOf: ['independenceRefusal', 'strandsReviewer'],
  writersOf: ['independenceRefusal', 'strandsReviewer', 'unblockModels', 'writerUnknown', 'secondOpinionOwed'],
};

// Map every call of the two functions in a source text to the nearest enclosing top-level class method or function.
export function callSites(src) {
  const sites = [];
  let owner = '(module)';
  src.split('\n').forEach((line, i) => {
    const m = /^  (?:async )?([A-Za-z_$][\w$]*)\([^)]*\)\s*\{/.exec(line) || /^(?:export )?(?:async )?function ([\w$]+)/.exec(line) || /^(?:export )?const ([\w$]+)\s*=/.exec(line);
    if (m && !/^\s*(if|for|while|switch|return)\b/.test(line)) owner = m[1];
    const code = line.replace(/\/\/.*$/, '');
    for (const fn of Object.keys(PERMITTED)) {
      const re = new RegExp(`(?<![\\w$])${fn}\\s*\\(`, 'g');
      let x;
      while ((x = re.exec(code))) {
        // A definition (method shorthand or const arrow) is not a call.
        if (new RegExp(`^\\s{0,2}(?:export const )?${fn}\\s*(?:=|\\([^)]*\\)\\s*\\{)`).test(code) && code.indexOf(fn) === code.search(/\S/) + (code.trimStart().startsWith('export const ') ? 13 : 0)) continue;
        sites.push({ fn, owner, line: i + 1 });
      }
    }
  });
  return sites;
}

const files = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? (e.name === 'node_modules' ? [] : files(path.join(dir, e.name))) : /\.(mjs|js)$/.test(e.name) ? [path.join(dir, e.name)] : []);

test('issue #651: only the permitted methods call independentOf or writersOf directly', () => {
  const bad = [];
  for (const dir of ['supervisor', 'tools']) {
    if (!fs.existsSync(path.join(root, dir))) continue;
    for (const f of files(dir)) {
      for (const s of callSites(fs.readFileSync(path.join(root, f), 'utf8'))) {
        if (!PERMITTED[s.fn].includes(s.owner)) bad.push(`${f}:${s.line} ${s.owner} calls ${s.fn}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'new direct call sites need review: use independenceRefusal for decisions about an actual review, or extend PERMITTED with a reason');
});

test('issue #651: the scanner sees the known call sites and rejects an unlisted one', () => {
  const real = callSites(fs.readFileSync(path.join(root, 'supervisor/team.mjs'), 'utf8'));
  for (const [fn, owners] of Object.entries(PERMITTED)) {
    for (const o of owners) assert.ok(real.some(s => s.fn === fn && s.owner === o), `${o} should call ${fn}`);
  }
  const fake = callSites('export class T {\n  decideReview(pr) {\n    return independentOf({ provider: 1 }, this.writersOf(pr));\n  }\n}\n');
  assert.deepEqual(fake.map(s => [s.fn, s.owner]).sort(), [['independentOf', 'decideReview'], ['writersOf', 'decideReview']]);
  assert.ok(fake.every(s => !PERMITTED[s.fn].includes(s.owner)));
  // Definitions and comments are not calls.
  assert.deepEqual(callSites('export const independentOf = (a, b) => 1;\n  writersOf(pr) {\n    // independentOf(x) writersOf(y)\n  }\n'), []);
});
