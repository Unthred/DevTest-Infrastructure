// Issue #855: done is installed and verified. An issue may list checks that need the running system under a "## Live checks" heading:
//   - GET /api/view.json -> 200
//   - POST /mark-read -> 403 contains "refused"
// Only the homeowner's issue text is read (the caller passes it only then). A path is relative to the dashboard base URL and may not carry a
// scheme, host or "..". Foreman runs the checks after the install that contains the change; all pass = verified, any failure = a follow-up
// issue with the evidence attached. Stages: merged, installed (the installed commit contains the merge), verified (checks passed on it).
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.mjs';

export const MAX_CHECKS = 10;
const LINE = /^\s*[-*]\s*`?(GET|HEAD|POST)\s+(\/[A-Za-z0-9._~\/%?=&:@+-]{0,200})`?\s*(?:->|→)\s*(\d{3})(?:\s+contains\s+"([^"\n]{1,100})")?\s*$/;
export function parseLiveChecks(body) {
  const text = String(body ?? '').replace(/\r/g, ''), m = /^#{1,6}\s*live checks\b.*$/im.exec(text);
  if (!m) return [];
  const after = text.slice(m.index + m[0].length), next = /^#{1,6}\s/m.exec(after);
  const out = [];
  for (const line of (next ? after.slice(0, next.index) : after).split('\n')) {
    const c = LINE.exec(line);
    if (!c || c[2].includes('..') || c[2].startsWith('//')) continue;
    const status = Number(c[3]);
    if (status < 100 || status > 599) continue;
    out.push({ method: c[1], path: c[2], status, ...(c[4] ? { contains: c[4] } : {}) });
    if (out.length >= MAX_CHECKS) break;
  }
  return out;
}

// fetchImpl(url, {method, redirect, signal}) -> Response-like { status, text() }. Never throws: a network failure is a failed check.
export async function runLiveChecks(checks, { baseUrl, fetchImpl = fetch, timeoutMs = 8000 }) {
  const results = [];
  for (const c of checks) {
    const r = { ...c, ok: false, actual: null, evidence: '' };
    try {
      const res = await fetchImpl(new URL(c.path, baseUrl).href, { method: c.method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      r.actual = res.status;
      const body = c.contains && c.method !== 'HEAD' ? String(await res.text()).slice(0, 20000) : '';
      r.ok = res.status === c.status && (!c.contains || body.includes(c.contains));
      r.evidence = r.ok ? 'passed' : res.status !== c.status ? `expected status ${c.status}, got ${res.status}` : `status ${res.status} but the body did not contain "${c.contains}"`;
    } catch (error) { r.evidence = `no answer: ${String(error?.name || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40)}`; }
    results.push(r);
  }
  return results;
}
export const allPassed = results => results.length > 0 && results.every(r => r.ok);

export const stageOf = ({ merged, installed, verified }) => verified ? 'verified' : installed ? 'installed' : merged ? 'merged' : 'open';

export function followUpIssue({ issue, pr, sha, results, marker }) {
  const rows = results.map(r => `- ${r.ok ? 'passed' : 'FAILED'}: \`${r.method} ${r.path}\` expected ${r.status}${r.contains ? ` containing "${r.contains}"` : ''}; ${r.evidence}${r.actual != null ? ` (status ${r.actual})` : ''}`);
  return { title: `Live check failed after install: #${issue}`.slice(0, 200), body: redact(`${marker}\nThe live checks listed in #${issue} (PR #${pr}) failed on the installed version \`${String(sha).slice(0, 12)}\`. #${issue} is not verified. Fix it and the checks run again after the next install.\n\nEvidence:\n${rows.join('\n')}`, 4000) };
}

// ---- state: <root>/team/verification.json  { [issue]: { pr, sha, state: 'verified'|'failed', at, followUp? } }
export const stateFile = root => path.join(root, 'team', 'verification.json');
export function readVerification(root) {
  try { const s = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; } catch { return {}; }
}
export function writeVerification(root, s) {
  fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true });
  const temp = `${stateFile(root)}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(s, null, 1) + '\n', { mode: 0o600 }); fs.renameSync(temp, stateFile(root));
}

// One verification pass (called from the team tick). For every pull request in a completed install (upgrade record `verified`, meaning the
// live tick on the new version was fine) whose closed issue lists live checks, run them on the installed version once. Dependencies are
// injected so the pass is testable without GitHub or a network. Returns { verified: [issue], failed: [{issue, followUp}], noChecks: [issue], skipped? }.
export async function verifyPass({ root, installedSha, records, getPull, getIssue, ownerText, baseUrl, fetchImpl, createIssue, findIssueByMarker, now = Date.now() }) {
  const out = { verified: [], failed: [], noChecks: [] };
  if (!/^[0-9a-f]{40}$/.test(String(installedSha || ''))) return { ...out, skipped: 'no installed version is known' };
  if (!baseUrl) return { ...out, skipped: 'no dashboard URL (self_upgrade.public_dashboard_url) to run live checks against' };
  const state = readVerification(root);
  const prs = [...new Set(records.filter(r => r.result === 'verified' && Array.isArray(r.prs)).flatMap(r => r.prs).filter(Number.isSafeInteger))];
  state.prs ||= {};
  for (const pr of prs) {
    if (state.prs[pr]) continue;   // every issue it closes was verified or lists no checks: nothing to ask GitHub again
    let issues, retry = false;
    try { const p = await getPull(pr); issues = [...new Set((p?.closingIssuesReferences || []).map(x => x?.number).filter(Number.isSafeInteger))]; } catch { continue; }
    for (const issue of issues) {
      const rec = state[issue];
      if (rec && rec.pr === pr && (rec.state === 'verified' || (rec.state === 'failed' && rec.sha === installedSha))) { if (rec.state === 'failed') retry = true; continue; }
      let body; try { body = await ownerText(issue, await getIssue(issue)); } catch { retry = true; continue; }
      const checks = parseLiveChecks(body);
      if (!checks.length) { out.noChecks.push(issue); continue; }
      const results = await runLiveChecks(checks, { baseUrl, fetchImpl });
      if (allPassed(results)) { state[issue] = { pr, sha: installedSha, state: 'verified', at: now }; out.verified.push(issue); }
      else {
        const marker = `<!-- devtest-live-check-failed v1 issue=${issue} sha=${installedSha} -->`;
        const f = followUpIssue({ issue, pr, sha: installedSha, results, marker });
        const existing = await findIssueByMarker(marker);
        const followUp = existing?.number ?? existing ?? await createIssue(f.title, f.body);
        state[issue] = { pr, sha: installedSha, state: 'failed', at: now, followUp: Number.isSafeInteger(followUp) ? followUp : followUp?.number ?? null };
        out.failed.push({ issue, followUp: state[issue].followUp });
      }
      if (state[issue].state === 'failed') retry = true;
      writeVerification(root, state);
    }
    if (!retry) { state.prs[pr] = true; writeVerification(root, state); }
  }
  return out;
}
