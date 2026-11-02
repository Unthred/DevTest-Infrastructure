// Issue #351: the only accepted evidence of who wrote a head is a harness-written session log naming the exact head.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findHeadWriter } from '../supervisor/writerevidence.mjs';

const HEAD = 'e270645' + 'a'.repeat(33), BRANCH = 'claude/issue-341-x';
const use = (id, command, model = 'claude-opus-5-5', gitBranch = BRANCH) => ({ type: 'assistant', sessionId: 'sess-1234567', gitBranch, message: { role: 'assistant', model, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const res = (id, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
function home(t, rows, raw = null) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'wev-')); t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  const d = path.join(h, '.claude', 'projects', '-p'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'abcdef12-0000.jsonl'), raw ?? rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return h;
}
const find = (h, over = {}) => findHeadWriter({ head: HEAD, branch: BRANCH, home: h, now: Date.now(), ...over });

test('a git commit whose output names the exact head, issued by a recorded model, is evidence', t => {
  const h = home(t, [use('a', 'git commit -m x'), res('a', `[${BRANCH} e270645] x\n 1 file changed`)]);
  assert.deepEqual(find(h), { provider: 'claude', models: ['claude-opus-5-5'], sessions: ['sess-123'] });
});
test('a push range ending in the head counts; two models are both reported', t => {
  const h = home(t, [use('a', 'git push origin HEAD', 'claude-opus-5-5'), res('a', `   1111111..e270645  ${BRANCH} -> ${BRANCH}`), use('b', 'git commit --amend', 'claude-sonnet-5-5'), res('b', `[${BRANCH} ${HEAD.slice(0, 12)}] y`)]);
  assert.deepEqual(find(h).models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
});
test('no evidence: a different head, a different branch, a command that is not a git write, a claim only in text, a torn log', t => {
  const cases = {
    otherHead: [use('a', 'git commit -m x'), res('a', `[${BRANCH} 1234567] x`)],
    otherBranch: [use('a', 'git commit -m x', 'claude-opus-5-5', 'main'), res('a', `[main e270645] x`)],
    notGitWrite: [use('a', 'echo e270645'), res('a', 'e270645')],
    assistantClaim: [{ type: 'assistant', sessionId: 's', gitBranch: BRANCH, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `I committed e270645 on ${BRANCH}` }] } }],
    orphanResult: [res('zzz', `[${BRANCH} e270645] x`)],
    embedded: [use('a', 'git commit -m x'), res('a', '[b ae270645b] x')],
  };
  for (const [name, rows] of Object.entries(cases)) assert.equal(find(home(t, rows)), null, name);
  assert.equal(find(home(t, null, 'not json e270645\n{"type":')), null, 'torn');
  assert.equal(find(home(t, [])), null, 'empty');
  assert.equal(findHeadWriter({ head: 'e270645', branch: BRANCH, home: home(t, []) }), null, 'short head refused');
});
test('a log older than two weeks is ignored', t => {
  const h = home(t, [use('a', 'git commit -m x'), res('a', `[${BRANCH} e270645] x`)]);
  assert.equal(find(h, { now: Date.now() + 15 * 86400000 }), null);
});
