// Issue #1020: every failed job ends with one honest cause from a fixed list, a one line detail and the tokens it cost. The cause is derived
// only from what the dispatcher already holds when the job ends (the job record, its event names, the refusal code, the host readings at
// that moment and the earlier failures); no model is called and nothing here changes a job. Pure functions plus two small readers.
import fs from 'node:fs';
import { redact } from './redact.mjs';

export const FAIL_CAUSES = Object.freeze({
  environment: 'environment (disk, memory, swap, network)',
  wedged: 'wedged (no activity)',
  deterministic: 'deterministic (the same failure repeats)',
  review_disagreement: 'review disagreement (fix limit)',
  prerequisite_open: 'prerequisite open',
  identity_evidence: 'identity or evidence',
  foreman_bug: 'Foreman bug',
  provider_limit: 'provider limit',
  homeowner_decision: 'homeowner decision needed',
  unclassified: 'unclassified (no listed cause fits the evidence)',   // honest fallback: a guess would hide the failure type
});
export const CAUSE_KEYS = Object.keys(FAIL_CAUSES);
export const POSTMORTEM_JOBS = 3;                 // this many jobs of one cause ...
export const POSTMORTEM_WINDOW_MS = 3600000;      // ... inside this window draft a post-mortem
export const REPEAT_WINDOW_MS = 24 * 3600000;     // an earlier failure of the same subject and stop counts as a repeat inside this window
export const DISK_LOW_MB = 512;
export const MEM_LOW_MB = 256;
export const SWAP_HIGH_PCT = 90;
const KEEP_MS = 14 * 24 * 3600000, KEEP_MAX = 2000, DAY_MS = 86400000;

const DISK_TEXT = /\bENOSPC\b|no space left|disk (?:is )?full|quota exceeded|read-only file system|\bEDQUOT\b/i;
const MEM_TEXT = /\bENOMEM\b|out of memory|\bOOM\b|oom-kill|cannot allocate memory|killed by the kernel/i;
const NET_TEXT = /\bECONNRESET\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|\bENETUNREACH\b|network is unreachable|temporary failure in name resolution/i;
const PREREQ_TEXT = /prerequisite|blocked by #\d+|depends on #\d+|waits? for #\d+|is not (?:done|closed) yet|not yet (?:merged|closed|implemented)/i;
const HOMEOWNER_TEXT = /homeowner (?:decision|approval|must|needs|has to)|needs the homeowner|decision needed|awaiting the homeowner/i;
const IDENTITY_TEXT = /writer record|no writer|writer evidence|identity (?:check|mismatch|missing|not)|credentials?\b|not logged in|login (?:failed|required)|unauthori[sz]ed|\b401\b|\b403\b/i;
const FIXLIMIT_TEXT = /fix limit|fix rounds|max_fix_attempts|still rejected/i;

const num = v => (Number.isFinite(v) && v >= 0 ? v : 0);
const clip = (s, n) => redact(String(s ?? '').replace(/\s+/g, ' ').trim(), n);

// Host readings now (disk free on the state root, memory available, swap used). Every field may be null when it cannot be read.
export function readHost(root, { meminfo = '/proc/meminfo' } = {}) {
  const out = { diskFreeMb: null, memAvailMb: null, swapUsedPct: null };
  try { const s = fs.statfsSync(root); out.diskFreeMb = Math.round(Number(s.bavail) * Number(s.bsize) / 1048576); } catch { /* unreadable */ }
  try {
    const kb = {}; for (const line of fs.readFileSync(meminfo, 'utf8').split('\n')) { const m = /^(\w+):\s+(\d+)/.exec(line); if (m) kb[m[1]] = Number(m[2]); }
    if (Number.isFinite(kb.MemAvailable)) out.memAvailMb = Math.round(kb.MemAvailable / 1024);
    if (kb.SwapTotal > 0 && Number.isFinite(kb.SwapFree)) out.swapUsedPct = Math.round(100 * (kb.SwapTotal - kb.SwapFree) / kb.SwapTotal);
  } catch { /* unreadable */ }
  return out;
}

// Names of the job's recorded events (never their content).
export function readEventKinds(root, id) {
  let text; try { text = fs.readFileSync(`${root}/events/${id}.jsonl`, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n').slice(-200)) { try { const e = JSON.parse(line); if (e && typeof e.kind === 'string') out.push(e.kind.slice(0, 64)); } catch { /* damaged line */ } }
  return out;
}

// The raw stop reason used to decide whether a failure repeats.
export const stopKey = job => String(job?.incompleteReason?.cause || job?.lastEvent || job?.status || 'unknown').slice(0, 48);

// Decide the cause. Order matters: first what the job itself says it died of (error text), then a deliberate stop with a stated reason, then
// the host readings taken when it ended, then the failure's shape (wedge, repeat). Returns { cause, detail }.
//   job: supervisor record; entry: Foreman's record; events: event names; host: readHost(); refusal: stable refusal code;
//   repeats: earlier failures of the same subject with the same stop; fixLimitReached: the PR's fix rounds are used up;
//   openPrerequisites: issue numbers still open that this job's issue lists as prerequisites.
export function classifyFailure({ job, entry = {}, events = [], host = null, refusal = null, repeats = 0, fixLimitReached = false, openPrerequisites = [] } = {}) {
  const reason = job?.incompleteReason || {};
  const text = `${reason.detail || ''} ${reason.cause || ''} ${job?.stopReason || ''} ${job?.lastError || ''}`;
  const last = String(job?.lastEvent || '');
  const kinds = new Set([last]);   // only the event that ended the job: earlier events (retried network errors, one-off limits) did not end it
  const out = (cause, detail) => ({ cause, detail: clip(detail, 160) });

  if (DISK_TEXT.test(text)) return out('environment', `disk full: ${reason.detail || text}`);
  if (MEM_TEXT.test(text)) return out('environment', `out of memory: ${reason.detail || text}`);
  if (NET_TEXT.test(text) || kinds.has('network_error')) return out('environment', `network: ${reason.detail || last}`);

  if (['usage_limit', 'transient_rate_limit', 'rate_limit'].some(k => kinds.has(k)) || (num(job?.usageLimitHits) > 0 && last === 'retry_exhausted')) return out('provider_limit', `the provider's allowance stopped it (${last || 'usage_limit'})`);
  const wedgeKind = ['idle_timeout', 'stalled', 'wedged', 'liveness_timeout'].some(k => kinds.has(k));
  if (openPrerequisites.length && !wedgeKind) return out('prerequisite_open', `stopped because ${openPrerequisites.map(n => `#${n}`).join(', ')} ${openPrerequisites.length > 1 ? 'are' : 'is'} still open`);
  if (PREREQ_TEXT.test(text)) return out('prerequisite_open', `stopped on an open prerequisite: ${reason.detail || text}`);
  if (kinds.has('approval_required') || HOMEOWNER_TEXT.test(text)) return out('homeowner_decision', `needs the homeowner: ${reason.detail || last}`);
  if (kinds.has('auth_error') || ['no-verdict-file', 'unreadable-verdict-file', 'invalid-ticket', 'wrong-pr', 'wrong-head'].includes(refusal) || (reason.cause === 'postcondition_not_met' && IDENTITY_TEXT.test(reason.detail || ''))) {
    return out('identity_evidence', refusal ? `the result was refused: ${refusal}` : `identity or evidence missing: ${reason.detail || last}`);
  }
  if ((fixLimitReached && ['fix', 'cifix'].includes(entry.kind || job?.kind)) || FIXLIMIT_TEXT.test(reason.detail || '')) return out('review_disagreement', 'the fix rounds for this pull request are used up and the review still rejects it');

  if (host) {
    if (Number.isFinite(host.diskFreeMb) && host.diskFreeMb < DISK_LOW_MB) return out('environment', `disk nearly full: ${host.diskFreeMb} MB free when the job ended`);
    if (Number.isFinite(host.memAvailMb) && host.memAvailMb < MEM_LOW_MB) return out('environment', `memory exhausted: ${host.memAvailMb} MB available when the job ended`);
    if (Number.isFinite(host.swapUsedPct) && host.swapUsedPct >= SWAP_HIGH_PCT && Number.isFinite(host.memAvailMb) && host.memAvailMb < 4 * MEM_LOW_MB) return out('environment', `swap ${host.swapUsedPct}% used when the job ended`);
  }

  if (kinds.has('idle_timeout') || kinds.has('stalled') || kinds.has('wedged') || kinds.has('liveness_timeout')) return out('wedged', 'no activity within the liveness limit');
  if ((reason.cause === 'postcondition_not_met' && String(reason.detail || '').startsWith('validator fault:')) || [...kinds].some(k => k.startsWith('postcondition_exception')) || kinds.has('checkpoint_failed') || kinds.has('preflight_failed')) {
    return out('foreman_bug', `Foreman's own check or setup failed: ${reason.detail || last}`);
  }
  if (last === 'context_too_large' || kinds.has('context_limit')) return out('deterministic', 'the issue overflows the context; a restart would fail the same way');
  if (repeats > 0) return out('deterministic', `the same stop (${stopKey(job)}) happened ${repeats} time${repeats > 1 ? 's' : ''} before on this item`);
  return out('unclassified', reason.detail || `ended ${job?.status || 'failed'} (${last || 'no event'})`);
}

// ---- the record: state.failCauses = { records: { <jobId>: rec }, drafted: { <jobId>: at } } ----
export const emptyFailCauses = () => ({ records: {}, drafted: {} });
export function normalizeFailCauses(s) { s ||= {}; s.records ||= {}; s.drafted ||= {}; return s; }

export function failureRecord({ id, entry = {}, job, cls }) {
  const usage = job?.usage || {};
  return {
    job: String(id), at: Number.isFinite(job?.updatedAt) ? job.updatedAt : 0, type: String(entry.kind || job?.kind || 'job').slice(0, 24),
    cause: cls.cause, detail: cls.detail, stop: stopKey(job), agent: entry.agent ?? null, pr: entry.pr ?? null, issue: entry.issue ?? null,
    inputTokens: num(usage.inputTokens), outputTokens: num(usage.outputTokens), tokens: num(usage.inputTokens) + num(usage.outputTokens), cost: num(usage.costUsdEstimate),
  };
}
export function recordFailure(s, rec, now) {
  normalizeFailCauses(s);
  if (!rec || s.records[rec.job]) return false;
  s.records[rec.job] = rec;
  for (const r of Object.values(s.records)) if (now - r.at > KEEP_MS) { delete s.records[r.job]; delete s.drafted[r.job]; }
  const over = Object.values(s.records).sort((a, b) => a.at - b.at).slice(0, Math.max(0, Object.keys(s.records).length - KEEP_MAX));
  for (const r of over) { delete s.records[r.job]; delete s.drafted[r.job]; }
  return true;
}
// Earlier failures of the same subject (pull request, else issue) with the same stop, inside the repeat window.
export function repeatsOf(s, { pr = null, issue = null, stop, at, id }) {
  if (pr == null && issue == null) return 0;
  return Object.values(normalizeFailCauses(s).records).filter(r => r.job !== id && r.stop === stop && (pr != null ? r.pr === pr : r.pr == null && r.issue === issue) && r.at <= at && at - r.at <= REPEAT_WINDOW_MS).length;
}

const round2 = n => Math.round(n * 100) / 100;
const iso = ms => new Date(ms).toISOString();
const items = list => ({ prs: [...new Set(list.map(r => r.pr).filter(n => n != null))].sort((a, b) => a - b), issues: [...new Set(list.map(r => r.issue).filter(n => n != null))].sort((a, b) => a - b) });
function groupBy(list) {
  const m = new Map();
  for (const r of list) { const e = m.get(r.cause) || []; e.push(r); m.set(r.cause, e); }
  return [...m].map(([cause, rs]) => ({ cause, label: FAIL_CAUSES[cause] || cause, jobs: rs.length, tokens: rs.reduce((n, r) => n + r.tokens, 0), cost: round2(rs.reduce((n, r) => n + r.cost, 0)), ...items(rs), first: iso(Math.min(...rs.map(r => r.at))), last: iso(Math.max(...rs.map(r => r.at))) }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || b.jobs - a.jobs || a.cause.localeCompare(b.cause));
}
// Figures per cause: the last 24 hours ("day"), the last 7 days ("week") and each UTC day, ordered by waste (cost, then tokens).
export function summarize(s, { now = Date.now(), days = 7 } = {}) {
  const all = Object.values(normalizeFailCauses(s).records).filter(r => Number.isFinite(r.at));
  const span = Math.min(14, Math.max(1, Math.trunc(Number(days)) || 7));
  const within = ms => all.filter(r => r.at >= now - ms && r.at <= now + 60000);
  const byDay = new Map();
  for (const r of within(span * DAY_MS)) { const d = iso(r.at).slice(0, 10); (byDay.get(d) || byDay.set(d, []).get(d)).push(r); }
  return {
    generatedAt: iso(now), causes: CAUSE_KEYS,
    day: groupBy(within(DAY_MS)), week: groupBy(within(7 * DAY_MS)),
    byDay: [...byDay].sort((a, b) => b[0].localeCompare(a[0])).map(([day, rs]) => ({ day, causes: groupBy(rs) })),
    note: 'A cause is derived from the job events, exit state and host readings at the time the job ended; no model is asked. Cost is the provider CLI usage estimate, not a charge.',
  };
}

// Clusters that need a post-mortem: POSTMORTEM_JOBS or more not-yet-drafted failures of one cause that all fall inside the window.
export function postmortemsDue(s, { now = Date.now(), minJobs = POSTMORTEM_JOBS, windowMs = POSTMORTEM_WINDOW_MS } = {}) {
  normalizeFailCauses(s);
  const fresh = Object.values(s.records).filter(r => !s.drafted[r.job]).sort((a, b) => a.at - b.at);
  const out = [];
  for (const cause of CAUSE_KEYS) {
    const list = fresh.filter(r => r.cause === cause);
    // the earliest run of `minJobs` or more inside one window, then every following failure still in that window
    for (let i = 0; i + minJobs <= list.length; i++) {
      if (list[i + minJobs - 1].at - list[i].at > windowMs) continue;
      const group = list.filter(r => r.at >= list[i].at && r.at - list[i].at <= windowMs);
      out.push({ cause, records: group });
      break;
    }
  }
  return out;
}
export function postmortemItem({ cause, records }) {
  const f = groupBy(records)[0], at = records.map(r => r.at);
  const refs = [...f.prs.map(n => `PR #${n}`), ...f.issues.map(n => `issue #${n}`)];
  const lines = records.slice(0, 10).map(r => `- ${r.type} on ${r.pr != null ? `PR #${r.pr}` : r.issue != null ? `issue #${r.issue}` : 'no item'}: ${r.detail}`);
  return {
    kind: 'issue_draft',
    title: `Post-mortem: ${records.length} jobs failed with cause "${FAIL_CAUSES[cause] || cause}"`.slice(0, 200),
    body: [`Foreman recorded ${records.length} failed jobs with the cause "${FAIL_CAUSES[cause] || cause}" inside one hour.`, '',
      `- Cause: ${FAIL_CAUSES[cause] || cause}`, `- Items involved: ${refs.join(', ') || 'none recorded'}`, `- Tokens spent: ${f.tokens}`, `- Cost (usage equivalent, not a charge): $${f.cost.toFixed(2)}`,
      `- First failure: ${iso(Math.min(...at))}`, `- Last failure: ${iso(Math.max(...at))}`, '', 'Failures:', ...lines, '', 'Find why this cause repeated and what stops it.'].join('\n').slice(0, 7900),
    why: 'Three or more jobs failed with the same cause inside an hour.',
  };
}
export function markDrafted(s, records, now) { normalizeFailCauses(s); for (const r of records) s.drafted[r.job] = now; }
