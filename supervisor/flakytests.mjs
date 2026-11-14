// Issue #1370: one record per unreliable test, keyed by test file and test name. The installer (issue #1322) names the tests that failed
// in the full run and passed alone; the upgrade step hands those names here. The decisions (merge a report into the records, which
// tests are repeat offenders, which records expire) are pure functions; flakyRecorder carries them out against the state file and
// the follow-up issue of the tests area.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redact } from './redact.mjs';
import { batchMarker } from './followups.mjs';

const DAY = 86400000;
export const REPEAT_COUNT = 3;
export const REPEAT_WINDOW_MS = 7 * DAY;
export const DROP_AFTER_MS = 14 * DAY;
const KEPT = 50, SEEN_KEPT = 10, NAME_MAX = 200, EXCERPT_MAX = 400;
export const TESTS_AREA = 'tests';
export const STATE_FILE = 'flaky-tests.json';

// "Depends on:" anywhere in a line is read as a prerequisite declaration (foreman-mcp/dependency-parser.mjs), so a test name or an
// error that holds those words must not keep the colon in the follow-up issue.
export const defang = text => String(text).replace(/(depends[ \t]+on\**[ \t]*):/gi, '$1 -');
const clean = (text, max) => defang(redact(String(text ?? ''), max).replace(/\s+/g, ' ').trim());

export const keyOf = (file, name) => crypto.createHash('sha256').update(`${file}\n${name}`).digest('hex').slice(0, 16);

// The test file is not on the installer's stdout line, only in the excerpt's "location:" line that follows the failing test.
export function fileFromExcerpt(excerpt, name) {
  const text = String(excerpt || ''), at = text.indexOf(`- ${name}`);
  const m = /location: '?([^\s:']+\.test\.mjs)/.exec(at < 0 ? text : text.slice(at));
  return m ? m[1].replace(/^.*\/(tests\/)/, '$1') : null;
}

export const emptyState = () => ({ tests: {} });

// Records whose last sighting is older than 14 days are dropped.
export function prune(state, now) {
  const tests = {};
  for (const [k, r] of Object.entries(state?.tests || {})) if (now - r.last < DROP_AFTER_MS) tests[k] = r;
  return { tests };
}

const seenInWindow = (r, now) => r.seen.filter(t => now - t < REPEAT_WINDOW_MS).length;

// Merges one flaky report. Returns the new state, the keys seen for the first time and the names skipped (with the reason).
export function applyReport(stateIn, { tests, excerpt, stage, files }, now) {
  const state = prune(stateIn, now), fresh = [], skipped = [];
  const names = (Array.isArray(tests) ? tests : []).map(n => String(n ?? '').trim()).filter(Boolean);
  if (!names.length) return { state, fresh, skipped: ['the flaky result named no test'] };
  for (const raw of names) {
    const name = clean(raw, NAME_MAX), file = clean(files?.[raw] || fileFromExcerpt(excerpt, raw) || 'unknown', NAME_MAX), key = keyOf(file, name);
    const old = state.tests[key];
    state.tests[key] = { key, file, name, first: old?.first ?? now, last: now, count: (old?.count ?? 0) + 1, seen: [...(old?.seen || []), now].slice(-SEEN_KEPT),
      stage, excerpt: clean(excerpt, EXCERPT_MAX), followup: old?.followup ?? null };
    state.tests[key].raised = !!old?.raised || seenInWindow(state.tests[key], now) >= REPEAT_COUNT;
    if (!old) fresh.push(key);
  }
  const keep = Object.values(state.tests).sort((a, b) => b.last - a.last).slice(0, KEPT);
  return { state: { tests: Object.fromEntries(keep.map(r => [r.key, r])) }, fresh, skipped };
}

// What the dashboard and the MCP show: live records only, most recent first.
export function flakyList(state, now) {
  return Object.values(prune(state, now).tests).sort((a, b) => b.last - a.last).map(r => ({
    file: r.file, name: r.name, count: r.count, countInWeek: seenInWindow(r, now), firstSeen: new Date(r.first).toISOString(), lastSeen: new Date(r.last).toISOString(),
    stage: r.stage, repeated: !!r.raised, followUpIssue: r.followup, excerpt: r.excerpt }));
}

// One Needs you item per test seen three times within 7 days (noted on the record when it happens); it ends when the record is dropped.
export function flakyFaults(state, now) {
  return Object.values(prune(state, now).tests).filter(r => r.raised).map(r => ({
    id: `flaky-test-${r.key}`, class: 'fault', ref: null, severity: 'action', since: r.first,
    text: redact(`Test "${r.name}" (${r.file}) was unreliable ${r.count} times and is likely to stop an install. `
      + `${r.followup ? `It is listed in follow-up issue #${r.followup}.` : 'It has no follow-up issue yet.'}`, 400),
    action: r.followup ? `Have issue #${r.followup} implemented so the test is repaired.` : 'Ask for the test to be repaired.' }));
}

export const readFlaky = root => { try { return JSON.parse(fs.readFileSync(path.join(root, 'team', STATE_FILE), 'utf8')) || emptyState(); } catch { return emptyState(); } };
function writeFlaky(root, state) {
  const dir = path.join(root, 'team'), file = path.join(dir, STATE_FILE), tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const testMarker = key => `<!-- devtest-flaky-test v1 key=${key} -->`;
export const entryText = r => `${testMarker(r.key)}\n- Unreliable test \`${r.name.replace(/`/g, "'")}\` in ${r.file}: seen ${r.count} time${r.count === 1 ? '' : 's'} (${r.stage}). Last error: ${r.excerpt || 'none recorded'}`;
const newBody = entry => `${batchMarker(TESTS_AREA)}\nTests that failed in an install run and passed when run alone. Foreman lists each test once and keeps its count in its own state; `
  + `one implementer run repairs the list.\n\n${entry}\n`;

// Adds one entry to the open follow-up issue of the tests area (the batch marker the review follow-ups use), or opens it.
// An issue that a pull request already implements is frozen: its body is not changed.
export async function addToFollowUp(gh, record) {
  let prs = [];
  try { prs = (await gh.listPulls?.()) || []; } catch { /* no pull request list: no batch is treated as frozen */ }
  const skip = [];
  const entry = entryText(record);
  let open = null;
  while (gh.findOpenIssueByMarker && (open = await gh.findOpenIssueByMarker(batchMarker(TESTS_AREA), skip))) {
    const re = new RegExp(`/issue-${open.number}(\\D|$)`);
    if (!prs.some(p => re.test(p.headRefName || ''))) break;
    skip.push(open.number); open = null;
  }
  if (!open) return gh.createIssue(`Review follow-ups: ${TESTS_AREA}`, newBody(entry));
  if (!open.body.includes(testMarker(record.key))) await gh.updateIssueBody(open.number, `${open.body.replace(/\s+$/, '')}\n\n${entry}\n`);
  return open.number;
}

// The upgrade step's recorder. Never throws: a failure to write the follow-up must not change the install decision.
export function flakyRecorder({ root, gh, clock = { now: () => Date.now() }, log = line => console.error(line) }) {
  return async function recordFlaky({ flaky, stage }) {
    const now = clock.now();
    const merged = applyReport(readFlaky(root), { ...flaky, stage }, now);
    for (const why of merged.skipped) log(`flaky tests: nothing recorded: ${why}`);
    let state = merged.state;
    try { writeFlaky(root, state); } catch (error) { log(`flaky tests: state not saved: ${redact(error.message, 120)}`); return state; }
    for (const r of Object.values(state.tests).filter(x => x.last === now && x.followup == null)) {
      try {
        const issue = await addToFollowUp(gh, r);
        state = { tests: { ...state.tests, [r.key]: { ...state.tests[r.key], followup: Number.isSafeInteger(issue) ? issue : issue?.number ?? null } } };
        writeFlaky(root, state);
      } catch (error) { log(`flaky tests: follow-up entry for "${r.name}" not written: ${redact(error.message, 120)}`); }
    }
    return state;
  };
}
