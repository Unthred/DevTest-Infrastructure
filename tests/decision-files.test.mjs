// Issue #1229: each decision proposal is its own file under docs/decisions. Drives the real validator script, the real approval step and
// the real Needs you card builder. Git fixtures use git init, never a linked worktree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { approvalsFrom } from '../supervisor/decisions.mjs';
import { parseDecisionFiles, renderIndex, nextNumber, decisionFileViolations } from '../supervisor/decisionfiles.mjs';
import { readDecisionDir, approveDecisionFile, writeIndex } from '../supervisor/decisionfilesio.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { withDecisionCards } from '../supervisor/decisioncards.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY = '# Decision register\n\n## D-001 — one\n- Status: homeowner-approved\n\n## D-002 — two\n- Status: homeowner-approved\n';
const proposal = (title, extra = {}) => `# ${title}\n- Status: ${extra.status || 'agent-proposal'}\n- Date: 2026-11-12\n- Source: issue #${extra.issue || 1}\n- Decision: Do the thing.\n- Rationale: Because.\n- Rejected: Nothing.\n- Superseded-by: none\n${extra.number ? `- Number: ${extra.number}\n` : ''}`;
const QUEUE = '1164-queue-control';
const OTHER = '1200-other-thing';
const link = id => `https://github.com/o/r/pull/9#issuecomment-${id}`;
const owner = (body, id = 77) => ({ login: 'Unthred', body, url: link(id), id });

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  fs.mkdirSync(path.join(dir, 'docs/decisions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/DECISIONS.md'), LEGACY);
  const put = (name, text) => { fs.mkdirSync(path.join(dir, 'docs/decisions'), { recursive: true }); fs.writeFileSync(path.join(dir, 'docs/decisions', `${name}.md`), text); };
  const commit = msg => { g('add', '.'); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
  return { dir, g, put, commit };
}
const validate = (r, base, head, comments) => {
  const args = [path.join(ROOT, 'tools/ci/validate-decision-status.mjs'), base, head];
  if (comments) { const f = path.join(r.dir, 'approvals.json'); fs.writeFileSync(f, JSON.stringify(comments)); args.push(f); }
  return spawnSync('node', args, { cwd: r.dir, encoding: 'utf8', env: { ...process.env, REPO_OWNER: 'Unthred' } });
};

test('two proposals on separate branches merge without conflict and keep their names', t => {
  const r = repo(t);
  r.commit('base');
  r.g('checkout', '-q', '-b', 'a');
  r.put(QUEUE, proposal('Queue control', { issue: 1164 }));
  r.commit('a');
  r.g('checkout', '-q', 'main');
  r.g('checkout', '-q', '-b', 'b');
  r.put(OTHER, proposal('Other thing', { issue: 1200 }));
  r.commit('b');
  r.g('checkout', '-q', 'main');
  r.g('merge', '-q', '--no-edit', 'a');
  r.g('merge', '-q', '--no-edit', 'b');   // a shared register would conflict here
  assert.deepEqual([...readDecisionDir(r.dir).keys()], [`docs/decisions/${QUEUE}.md`, `docs/decisions/${OTHER}.md`]);
});

test('real case: the 1164 queue-control proposal keeps its name when a second proposal is merged first', t => {
  const r = repo(t);
  const base = r.commit('base');
  r.g('checkout', '-q', '-b', 'queue');
  r.put(QUEUE, proposal('Queue control', { issue: 1164 }));
  const head = r.commit('queue proposal');
  r.g('checkout', '-q', 'main');
  r.put(OTHER, proposal('Other thing', { issue: 1200 }));
  r.commit('other merged first');
  r.g('checkout', '-q', 'queue');
  r.g('rebase', 'main');   // no conflict, no renumbering
  assert.match(fs.readFileSync(path.join(r.dir, `docs/decisions/${QUEUE}.md`), 'utf8'), /^# Queue control/);
  assert.equal(validate(r, 'main', 'queue').status, 0);
  assert.equal(r.g('rev-parse', 'queue') === head, false, 'the rebase moved the head');
  assert.ok(base);
  // the name the homeowner approves by is the same before and after the other proposal landed
  const names = parseDecisionFiles(readDecisionDir(r.dir)).map(p => p.name);
  assert.deepEqual(names, [QUEUE, OTHER]);
});

test('approval assigns the next number once, is idempotent, and the index regenerates identically', t => {
  const r = repo(t);
  r.put(QUEUE, proposal('Queue control', { issue: 1164 }));
  r.put(OTHER, proposal('Other thing', { issue: 1200 }));
  writeIndex(r.dir);
  const before = fs.readFileSync(path.join(r.dir, 'docs/decisions/INDEX.md'), 'utf8');
  assert.equal(before, renderIndex(parseDecisionFiles(readDecisionDir(r.dir))), 'proposals are not in the index');
  assert.ok(!before.includes(QUEUE));
  const approvals = approvalsFrom([owner(`homeowner-approval: ${OTHER}`), owner(`homeowner-approval: ${QUEUE}`, 78)], 'Unthred');
  const first = approveDecisionFile(r.dir, OTHER, approvals);
  assert.deepEqual([first.number, first.changed], ['D-003', true]);
  const text = fs.readFileSync(path.join(r.dir, `docs/decisions/${OTHER}.md`), 'utf8');
  assert.match(text, /^- Status: homeowner-approved$/m);
  assert.match(text, /^- Number: D-003$/m);
  assert.ok(text.includes(link(77)), 'the approval link is recorded in the Source');
  const again = approveDecisionFile(r.dir, OTHER, approvals);
  assert.deepEqual([again.number, again.changed], ['D-003', false]);
  assert.equal(fs.readFileSync(path.join(r.dir, `docs/decisions/${OTHER}.md`), 'utf8'), text);
  assert.equal(approveDecisionFile(r.dir, QUEUE, approvals).number, 'D-004', 'a second approval takes the next number');
  const index = fs.readFileSync(path.join(r.dir, 'docs/decisions/INDEX.md'), 'utf8');
  assert.match(index, /\| D-003 \| \[1200-other-thing\]/);
  assert.match(index, /\| D-004 \| \[1164-queue-control\]/);
  writeIndex(r.dir);
  assert.equal(fs.readFileSync(path.join(r.dir, 'docs/decisions/INDEX.md'), 'utf8'), index, 'regenerating changes nothing');
});

test('approval is refused without the repository owner\'s recorded approval', t => {
  const r = repo(t);
  r.put(QUEUE, proposal('Queue control'));
  assert.throws(() => approveDecisionFile(r.dir, QUEUE, new Map()), /no recorded homeowner approval/);
  const stranger = approvalsFrom([{ ...owner(`homeowner-approval: ${QUEUE}`), login: 'someone' }], 'Unthred');
  assert.throws(() => approveDecisionFile(r.dir, QUEUE, stranger), /no recorded homeowner approval/);
  assert.match(fs.readFileSync(path.join(r.dir, `docs/decisions/${QUEUE}.md`), 'utf8'), /Status: agent-proposal/);
});

test('the real validator: a proposal passes; approval without a recorded approval fails; with one it passes', t => {
  const r = repo(t);
  const base = r.commit('base');
  r.put(QUEUE, proposal('Queue control', { issue: 1164 }));
  const prop = r.commit('proposal');
  assert.equal(validate(r, base, prop).status, 0);
  r.put(QUEUE, proposal('Queue control', { issue: 1164, status: 'homeowner-approved', number: 'D-003' }).replace('issue #1164', `issue #1164; approved at ${link(77)}`));
  const appr = r.commit('self-approved');
  const bad = validate(r, prop, appr);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /1164-queue-control changes status agent-proposal -> homeowner-approved without a verifiable homeowner approval/);
  assert.equal(validate(r, prop, appr, [owner(`homeowner-approval: ${QUEUE}`)]).status, 0);
  assert.equal(validate(r, prop, appr, [owner(`homeowner-approval: ${QUEUE}`, 99)]).status, 1, 'the Source must link that comment');
});

test('the real validator refuses a number on a proposal, a new entry in the frozen register, and a deleted file', t => {
  const r = repo(t);
  const base = r.commit('base');
  r.put(QUEUE, proposal('Queue control', { number: 'D-003' }));
  const numbered = r.commit('numbered proposal');
  assert.match(validate(r, base, numbered).stderr, /only an approved decision has a Number/);
  r.g('reset', '-q', '--hard', base);
  fs.appendFileSync(path.join(r.dir, 'docs/DECISIONS.md'), '\n## D-003 — new\n- Status: agent-proposal\n');
  const legacy = r.commit('legacy entry');
  assert.match(validate(r, base, legacy).stderr, /D-003 is added to the frozen docs\/DECISIONS\.md/);
  r.g('reset', '-q', '--hard', base);
  r.put(QUEUE, proposal('Queue control'));
  const added = r.commit('add');
  fs.rmSync(path.join(r.dir, `docs/decisions/${QUEUE}.md`));
  const removed = r.commit('remove');
  assert.match(validate(r, added, removed).stderr, /was removed/);
});

test('duplicate numbers and unreadable file names are findings', () => {
  const a = new Map([[`docs/decisions/${QUEUE}.md`, proposal('A', { status: 'homeowner-approved', number: 'D-003' })], [`docs/decisions/${OTHER}.md`, proposal('B', { status: 'homeowner-approved', number: 'D-003' })], ['docs/decisions/Bad Name.md', proposal('C')]]);
  const bad = decisionFileViolations(new Map(), a, approvalsFrom([owner(`homeowner-approval: ${QUEUE}, ${OTHER}`)], 'Unthred')).join('\n');
  assert.match(bad, /D-003 is used by/);
  assert.match(bad, /the name must be <issue number>-<short-slug>\.md/);
  assert.equal(nextNumber(LEGACY, parseDecisionFiles(a)), 'D-004');
});

test('Needs you: the real card builder names the file, never a number, and the name survives another proposal landing', async t => {
  const r = repo(t);
  r.commit('base');
  r.g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  r.g('checkout', '-q', '-b', 'queue');
  r.put(QUEUE, proposal('Queue control', { issue: 1164 }));
  const head = r.commit('proposal');
  const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: r.dir, worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } };
  const pr = { number: 1230, title: 'pr', headRefName: 'claude/issue-1164-a', headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [], labels: [] };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const now = 1_800_000_000_000;
  const view = pulls => buildView({ config: cfg, root, jobs: [], events: [], state: {}, register: LEGACY, cache: { tick: { at: now - 60000, status: 'ok', error: null, lastOkAt: now - 60000 }, pulls, issues: [] }, snapshots: [], now });
  const items = async pulls => (await view(pulls)).panels.needsYou.filter(a => a.id.startsWith('decision-proposal-'));
  const [item] = await items([pr]);
  assert.equal(item.id, `decision-proposal-${QUEUE}-1230`);
  assert.match(item.text, /1164-queue-control/);
  assert.match(item.text, /docs\/decisions\/1164-queue-control\.md/);
  assert.match(item.decision, /homeowner-approval: 1164-queue-control/);
  assert.doesNotMatch(`${item.text} ${item.decision}`, /D-\d{3}/, 'no number that can change');
  const withCard = withDecisionCards({ panels: { needsYou: [item] } }, cfg, {}).panels.needsYou[0].card;
  assert.equal(withCard.type, 'decision-proposal');
  assert.match(withCard.reason, /1164-queue-control/);
  // another proposal lands on main first: the card for this one is unchanged
  r.g('checkout', '-q', 'main');
  r.put(OTHER, proposal('Other thing', { issue: 1200 }));
  r.commit('other');
  r.g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const [after] = await items([pr]);
  assert.equal(after.id, item.id);
  assert.equal(after.decision, item.decision);
  // main already has it: no card; a draft PR: no card
  r.g('merge', '-q', '--no-edit', 'queue');
  r.g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.deepEqual(await items([pr]), []);
});
