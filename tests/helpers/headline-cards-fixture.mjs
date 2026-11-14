// Issue #1453: a throwaway supervisor state holding the real example of the summary cards, read by the real dashboard handler and the real
// headline view (history timeline file included). Shared by tests/headline-cards-browser.mjs and the unit test that proves the example.
// At 14 Nov 2026 12:18 UTC: first review approval 41.2% (28 of 68 approved first time, 7 more rejected for the description only) against
// 34.1% (15 of 44) the 24 hours before; rejects 84 against 92; best 24 hours 84.9% (45 of 53), 6 to 7 Nov.
import fs from 'node:fs';
import path from 'node:path';
import { appendTimeline } from '../../supervisor/history.mjs';

export const NOW = Date.parse('2026-11-14T12:18:00Z');
const HOUR = 3600000;
const at = hoursAgo => NOW - hoursAgo * HOUR;
const sha = n => String(n).padStart(8, '0').repeat(5).slice(0, 40);

export const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] } } });

export function seedState(root) {
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const verdicts = {};
  const timeline = [];
  const jobs = [];
  const verdict = (n, v, hoursAgo, head = sha(n)) => { verdicts[`${n}:${head}`] = { verdict: v, reviewer: 'codex', at: at(hoursAgo), head, job: `j${n}` }; };
  // 28 approved first time and 33 rejected in the last 24 hours
  for (let i = 0; i < 61; i += 1) {  verdict(1000 + i, i < 28 ? 'PASS' : 'CHANGES', 2 + (i % 20)); }
  // 7 whose first review was an archived CHANGES, then a description round, then a PASS: counted as rejected, with the description note
  for (let i = 0; i < 7; i += 1) {
    const n = 1100 + i;
    verdict(n, 'PASS', 1, sha(n + 5000));
    timeline.push({ id: `verdict:${n}:${sha(n)}`, at: at(2 + i), kind: 'verdict', pr: n, head: sha(n), verdict: 'CHANGES', reviewer: 'codex' });
    jobs.push({ id: `d${i}`.padEnd(32, '0'), provider: 'codex', kind: 'review', status: 'completed', createdAt: at(2), updatedAt: at(1.5), postcondition: { kind: 'description_edited', pr: n, baseHead: sha(n) } });
  }
  // the 24 hours before: 15 approved and 29 rejected
  for (let i = 0; i < 44; i += 1) { verdict(2000 + i, i < 15 ? 'PASS' : 'CHANGES', 26 + (i % 20)); }
  // later rounds: a first review long ago, then a CHANGES in the last 24 hours (44, to make 84 rejects) or the 24 hours before (63, to make 92)
  for (let i = 0; i < 107; i += 1) {
    const n = 3000 + i;
    timeline.push({ id: `verdict:${n}:${sha(n)}`, at: at(100), kind: 'verdict', pr: n, head: sha(n), verdict: 'PASS', reviewer: 'codex' });
    verdict(n, 'CHANGES', i < 44 ? 3 + (i % 20) : 27 + (i % 20), sha(n + 7000));
  }
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, pulls: [], issues: [] }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ verdicts, jobs: {} }));
  for (const j of jobs) fs.writeFileSync(path.join(root, 'jobs', `${j.id}.json`), JSON.stringify(j));
  appendTimeline(root, timeline);
  const best = { rate: 84.9, approved: 45, reviewed: 53, start: '2026-11-06T09:00:00Z', end: '2026-11-07T09:00:00Z' };
  fs.writeFileSync(path.join(root, 'dashboard', 'best-day.json'), JSON.stringify({ version: 1, built: true, updatedAt: NOW - 60000, records: { approval: best, merges: null }, verdicts: [], merges: [] }));
}
