// Issue #1322: realDeps turns the installer's stdout "flaky tests:" block (exit 0) into a flaky result with the test names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realDeps } from '../supervisor/upgrade.mjs';

const FROM = 'a'.repeat(40), TO = 'b'.repeat(40);

test('issue #1322: realDeps reads the installer\'s "flaky tests:" stdout on exit 0 and returns it with ok: true', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfup-fl-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'versions', FROM), { recursive: true }); fs.symlinkSync(`versions/${FROM}`, path.join(dir, 'current'));
  const mk = out => realDeps({ root: dir, config: { repo_path: dir }, gh: {}, listActive: async () => [], verdictFor: () => null, run: (cmd, args) => {
    if (cmd === 'git' && args.includes('show')) return { status: 0, stdout: '#!/bin/bash\n', stderr: '' };
    if (cmd === 'git') return { status: 0, stdout: 'https://example.invalid/r.git\n', stderr: '' };
    return { status: 0, stdout: out, stderr: '' }; } });
  const r = await mk('flaky tests: alpha works; beta works\n--- excerpt ---\nnot ok 2 - alpha works\n').preChecks(TO);
  assert.equal(r.ok, true); assert.deepEqual(r.flaky.tests, ['alpha works', 'beta works']); assert.match(r.flaky.excerpt, /not ok 2/);
  assert.deepEqual(await mk('').preChecks(TO), { ok: true });
});

// Issue #1370: through the real upgrade step. A fake installer reports the flaky test names; nothing writes the flaky state by hand.
test('issue #1370: the upgrade step records the flaky test of 13 Nov 2026 14:40 UTC and adds one follow-up entry; a repeat only counts', async t => {
  const { SelfUpgrade } = await import('../supervisor/upgrade.mjs');
  const { flakyRecorder, readFlaky } = await import('../supervisor/flakytests.mjs');
  const NAME = 'install: keeps launcher.env at 0640 and sets the other modes when the caller runs under umask 077';
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'selfup-fl2-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: () => Date.parse('2026-11-13T14:40:00Z') }, edits = { created: 0, updated: 0 };
  let issue = null;
  const gh = { listPulls: async () => [], findOpenIssueByMarker: async (m, skip = []) => (issue && !skip.includes(issue.number) && issue.body.includes(m) ? { ...issue } : null),
    createIssue: async (title, body) => { edits.created++; issue = { number: 91, body }; return 91; }, updateIssueBody: async (n, body) => { edits.updated++; issue.body = body; } };
  const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const deps = { config: { agents: { claude: { branch_prefix: 'claude/' }, codex: { branch_prefix: 'codex/' } } }, independenceApproved: () => true, installed: () => FROM, fetchMain: () => TO, isAncestor: () => true,
    changedFiles: () => ['supervisor/team.mjs'], mainCommits: () => [{ sha: 'c'.repeat(40), pr: 7, head: 'd'.repeat(40) }],
    mergedPull: async () => ({ state: 'MERGED', headRefName: 'claude/issue-9-x', headRefOid: 'd'.repeat(40), statusCheckRollup: green }),
    verdict: () => ({ verdict: 'PASS', reviewer: 'codex' }), activeJobs: async () => 0, alert: async () => {},
    preChecks: async () => ({ ok: true, flaky: { kind: 'tests', tests: [NAME], excerpt: `not ok 3 - ${NAME}\n  location: 'tests/install-modes.test.mjs:41:1'` } }),
    upgrade: async () => ({ ok: true }), dryRunTick: async () => ({ ok: true }), rollback: async () => ({ ok: true }),
    recordFlaky: flakyRecorder({ root: path.join(dir, 'root'), gh, clock }) };
  const step = async () => { fs.rmSync(path.join(dir, 'root/team/self-upgrade.json'), { force: true }); return new SelfUpgrade({ root: path.join(dir, 'root'), deps, clock, minGapMs: 0 }).step(); };
  const first = await step(); assert.equal(first, 'upgraded', JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'root/team/self-upgrade.json'), 'utf8')).refusal));
  let [r] = Object.values(readFlaky(path.join(dir, 'root')).tests);
  assert.deepEqual([r.name, r.file, r.count, r.stage, r.followup], [NAME, 'tests/install-modes.test.mjs', 1, 'pre-check', 91]);
  assert.deepEqual(edits, { created: 1, updated: 0 });
  assert.equal(await step(), 'upgraded');
  [r] = Object.values(readFlaky(path.join(dir, 'root')).tests);
  assert.equal(r.count, 2);
  assert.deepEqual(edits, { created: 1, updated: 0 });
});
