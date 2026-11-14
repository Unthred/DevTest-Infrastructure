// Issue #1372: an Inbox refusal for credential-shaped or masked text names the field, the rule and the line, and never quotes the text.
// Every fixture is built at run time; the real validateItem, scan and the real MCP propose path are used, never a copy of the rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as inbox from '../supervisor/inbox.mjs';
import { reasonCodeOf } from '../supervisor/api/inbox-reasons.mjs';
import { SECRET_RULES, MASK_ADVICE } from '../supervisor/inbox-refusal.mjs';
import { MASK_RULES } from '../supervisor/redact.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { createInbox, checkProposal } from '../foreman-mcp/inbox.mjs';
import { RULE_NAMES } from '../foreman-mcp/refusal-reason.mjs';
import { RULES as MCP_RULES } from '../foreman-mcp/redact.mjs';
const hex = n => crypto.randomBytes(n).toString('hex');
const TOKEN = 'gh' + 'p_' + hex(12);
const GOOD = { kind: 'prompt', title: 'Tidy the docs index', prompt: 'Fix the broken link in docs/README.md.' };
const DRAFT = { kind: 'issue_draft', title: 'Add a retry note', body: 'The probe should say how long it waits.' };
function makeInbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-refusal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'items'));
  fs.mkdirSync(path.join(dir, 'status'));
  return dir;
}
const propose = (dir, args) => createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}), inbox: createInbox({ dir }) }).call('foreman_propose', args);

// ---- issue #1372: a refusal names the field, the rule and the line, and never quotes the text
// The two bodies refused on 13 Nov 2026, rebuilt at run time so this file holds no matching text.
const PASS_WORD = 'pa' + 'ss', COLOUR_WORD = 'tok' + 'ens';
const successLine = `Every repeated file succeeds, so the run says ${PASS_WORD}: everywhere`;
const colourLine = `The stylesheet names these colours as ${COLOUR_WORD}: crimson and teal`;
const runOf = (text, n = 6) => { const out = []; for (let i = 0; i + n <= text.length; i++) out.push(text.slice(i, i + n)); return out; };
const quotesNone = (reason, matched) => runOf(matched).every(r => !reason.includes(r));
test('#1372: a word then separator match names the field, the rule and the line, with a rewording sentence', () => {
  for (const [line, matched] of [[successLine, `${PASS_WORD}: everywhere`], [colourLine, `${COLOUR_WORD}: crimson`]]) {
    const r = inbox.validateItem({ ...DRAFT, body: `First line.\nSecond line.\n${line}\nFourth line.` });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^body contains secret-shaped text: rule "word then separator" matched on line 3\. \S/);
    assert.ok(/\.$/.test(r.reason), 'ends with one sentence');
    assert.ok(quotesNone(r.reason, matched), 'no run of the matched text');
    assert.equal(reasonCodeOf(r.reason, { state: 'refused', kind: 'issue_draft' }), 'secret_shaped');
  }
});
test('#1372: boundaries: a match on line 1 and on the last line report the right line; two matching rules report the first', () => {
  const other = `${COLOUR_WORD}: ${'x'.repeat(8)}`;
  assert.match(inbox.validateItem({ ...DRAFT, body: `${successLine}\nplain\nplain` }).reason, /line 1\./);
  assert.match(inbox.validateItem({ ...DRAFT, body: `plain\r\nplain\r\nplain\r\n${successLine}` }).reason, /line 4\./);
  const first = inbox.validateItem({ ...DRAFT, body: `plain\n${other}\n${TOKEN}` }).reason;
  assert.match(first, /rule "service key prefix" matched on line 3\./, 'list order wins over text order, on the line where its match starts');
});
test('#1372: a real looking private key block is refused naming its rule and line, and the reason holds none of it', () => {
  const block = ['-----BEGIN RSA PRIVATE ' + 'KEY-----', hex(24), '-----END RSA PRIVATE ' + 'KEY-----'].join('\n');
  const r = inbox.validateItem({ ...DRAFT, body: `Intro line.\n${block}` });
  assert.match(r.reason, /rule "private key block" matched on line 2\./);
  assert.ok(quotesNone(r.reason, block), 'no run of six characters of the block');
  assert.ok(!/BEGIN|-----/.test(r.reason));
});
test('#1372: masked text names the masking rule and the line; the redactor stays the one source', () => {
  const mail = 'dev' + '@example.org', digest = 'sha' + '256:' + hex(32);
  const m = inbox.validateItem({ ...GOOD, prompt: `Fine.\nFine.\nSet the e-mail to ${mail} now.` });
  assert.match(m.reason, /^prompt contains text the dashboard would mask: rule "e-mail address" matched on line 3\. \S/);
  assert.ok(quotesNone(m.reason, `Set the e-mail to ${mail} now.`.replace('Set the e-mail to ', '')));
  assert.equal(reasonCodeOf(m.reason, { state: 'refused', kind: 'prompt' }), 'masked_text');
  const d = inbox.validateItem({ ...GOOD, prompt: `Pin ${'x'.repeat(8)} to ${digest} now.` });
  assert.match(d.reason, /would mask: rule "[a-z -]+" matched on line 1\./);
  assert.ok(quotesNone(d.reason, digest));
  assert.equal(inbox.validateItem({ ...GOOD, prompt: 'An ordinary line.\nAnother ordinary line.' }).ok, true, 'an ordinary body is accepted');
});
test('#1372: the real propose path and scan record the new reason, and the table keeps the code', async t => {
  const dir = makeInbox(t);
  const r = JSON.parse((await propose(dir, { ...DRAFT, body: `Intro.\nMore.\n${successLine}` })).text);
  inbox.scan(dir, 1000);
  const s = inbox.statusOf(dir, r.id);
  assert.equal(s.state, 'refused');
  assert.match(s.reason, /rule "word then separator" matched on line 3\./);
  assert.equal(reasonCodeOf(s.reason, { state: s.state, kind: 'issue_draft' }), 'secret_shaped');
});
test('#1372: every credential rule and every masking rule has a name and a rewording sentence', () => {
  for (const rule of SECRET_RULES) { assert.ok(rule.name && /^[a-z -]+$/.test(rule.name), rule.name); assert.match(rule.advice, /^[A-Z].*\.$/); }
  assert.equal(new Set(SECRET_RULES.map(r => r.name)).size, SECRET_RULES.length);
  for (const rule of MASK_RULES) { assert.ok(rule.name, 'a masking rule is named'); assert.ok(MASK_ADVICE[rule.name], `${rule.name} has advice`); }
  assert.equal(new Set(MASK_RULES.map(r => r.name)).size, MASK_RULES.length);
});
// ---- the submit-time check of foreman_propose gives the same kind of reason (it has its own redactor and never imports supervisor/)
const SUBMIT_CASES = [
  ['private key block', '-----BEGIN PRIV' + 'ATE KEY-----'],
  ['service key prefix', 'gh' + 'p_' + hex(12)],
  ['cloud key prefix', 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'],
  ['bearer scheme', 'Bear' + 'er ' + hex(8), 'x'],
  ['address with password', 'ht' + 'tp://alice:' + hex(4) + '@host.example'],
  ['word then separator', 'the colour tok' + 'en: crimson'],
  ['word then separator', 'reset the pass' + 'word: required'],
  ['word then separator', 'run it with --tok' + 'en ' + hex(8)],
];
test('#1372: the submit-time check names the field, the rule and the line, and quotes none of the text', () => {
  for (const [rule, text, ...skipWord] of SUBMIT_CASES) {
    const r = checkProposal({ ...DRAFT, body: `One.\nTwo.\nSee ${text} here.` });
    assert.equal(r.ok, false, rule);
    assert.match(r.error, new RegExp(`^body contains secret-shaped text: rule "${rule}" matched on line 3\\. \\S.*\\.$`), rule);
    assert.ok(quotesNone(r.error, skipWord.length ? text.slice(7) : text), `${rule}: no run of the matched text`);   // the scheme word is the rule's own name
    assert.equal(reasonCodeOf(r.error, { state: 'refused', kind: 'issue_draft' }), 'secret_shaped');
  }
});
test('#1372: the submit-time rule names are ones the Inbox uses, and each has a sentence', () => {
  const known = new Set(SECRET_RULES.map(r => r.name));
  assert.equal(RULE_NAMES.length, MCP_RULES.length);
  for (const r of RULE_NAMES) { assert.ok(known.has(r.name), r.name); assert.match(r.advice, /^[A-Z].*\.$/); }
});
test('#1372: foreman_propose itself refuses a submit-time match naming the rule and the line', async t => {
  const dir = makeInbox(t);
  const r = await propose(dir, { ...DRAFT, body: `A.\nB.\nthe colour tok${'en'}: crimson` });
  assert.equal(r.isError, true);
  assert.match(r.text, /rule \\"word then separator\\" matched on line 3\./);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'items')), [], 'nothing was written');
});
test('#1380: the advice for the flag form of the last rule covers a space after the flag', () => {
  const flag = checkProposal({ ...DRAFT, body: 'run it with --tok' + 'en ' + hex(8) });
  assert.match(flag.error, /colon, equals sign or space comes right after that flag\.$/);
  const word = checkProposal({ ...DRAFT, body: 'the colour tok' + 'en: crimson' });
  assert.match(word.error, /colon or equals sign comes right after that word\.$/);
});
