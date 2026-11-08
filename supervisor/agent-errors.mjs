// Issue #1084: every error inside an agent job, including the ones the job recovered from, built from the job's stored transcript
// AFTER the job ends (nothing about how agents run changes). Issue #1038 records why a whole job failed; this records the failed
// tool calls inside jobs so a method that keeps failing shows up as a repeat. One small file per job under <root>/agent-errors/,
// redacted before it is written, deleted after the retention period. The Foreman MCP tool reads it through the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { readTranscript, redactText, validJobId, secretValues } from './transcript.mjs';
import { redact } from './redact.mjs';

export const RETENTION_DAYS = 30;
const DAY_MS = 86400000;
export const MAX_ERRORS_PER_JOB = 40;
export const EXCERPT_MAX = 200;
export const METHOD_MAX = 160;
const LOOKAHEAD_CALLS = 5;        // a later success counts as the recovery only within this many calls of the failure
// Fixed list, local to this record. Issue #1038 (the job-level cause list) is not merged yet, so its causes cannot be imported; when it
// is, map permission_refused, timeout, rate_limit and auth onto it. The rest are specific to a failed step.
export const ERROR_TYPES = ['permission_refused', 'timeout', 'rate_limit', 'auth', 'network', 'command_not_found', 'file_not_found', 'syntax_error', 'command_failed', 'tool_error'];

export const errorsDir = root => path.join(root, 'agent-errors');
const fileOf = (root, id) => path.join(errorsDir(root), `${id}.json`);

// Order matters: the first match wins.
const TYPE_RULES = [
  ['tool_error', /InputValidationError|input validation|invalid (?:tool )?(?:input|parameters?|arguments?)|missing required parameter/i],
  ['permission_refused', /permission[^.\n]{0,60}(?:denied|refused)|permission (?:denied|to use)|was denied|not allowed|requires? (?:approval|permission)|was blocked|refused by|doesn'?t want to (?:proceed|take this action)|operation not permitted|EACCES|EPERM/i],
  ['timeout', /timed out|time out|timeout (?:error|exceeded|expired|after|of)|deadline exceeded|ETIMEDOUT/i],
  ['rate_limit', /rate.?limit|too many requests|\b429\b/i],
  ['auth', /\b40[13]\b|unauthori[sz]ed|authentication|bad credentials|not logged in/i],
  ['network', /could not resolve|connection (?:refused|reset|closed)|ECONN|ENOTFOUND|network is unreachable|TLS|certificate/i],
  ['command_not_found', /command not found|not found in PATH|executable file not found|: not found$/im],
  ['file_not_found', /no such file or directory|ENOENT|does not exist|file not found|not a git repository/i],
  ['syntax_error', /syntax error|unexpected token|parse error|invalid (?:json|syntax)|unterminated/i],
];
export function classifyError(text, { exit = null } = {}) {
  const t = String(text ?? '');
  for (const [type, re] of TYPE_RULES) if (re.test(t)) return type;
  if (exit != null && exit !== 0) return 'command_failed';
  return /\bexit(?: code)?[: ]+[1-9]\d*\b/i.test(t) ? 'command_failed' : 'tool_error';
}
const exitOf = text => { const m = /^\s*(?:exit(?: code)?[: ]+)(\d+)/i.exec(String(text ?? '')); return m ? Number(m[1]) : null; };

// Codex stores a shell call as `/bin/bash -lc "<command>"`: the real command is inside, so look at that.
const unwrapShell = s => {
  const m = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(s);
  return m ? (m[1] === '"' ? m[2].replace(/\\(["\\$`])/g, '$1') : m[2]) : s;
};
// The same failing method on different paths, ids and numbers must group together: replace what varies with placeholders.
// Quoted text first (it may hold spaces), then URLs, then each word: a path, a long hex or alphanumeric id, a number.
export function normalizeMethod(tool, text) {
  let s = unwrapShell(String(text ?? '').replace(/\s+/g, ' ').trim());
  s = s.replace(/"(?:[^"\\]|\\.){0,300}"|'[^']{0,300}'/g, '<str>')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>');
  s = s.split(' ').map(w => {
    const flag = /^(--?[A-Za-z][\w-]*)=(.+)$/.exec(w);
    if (flag) return `${flag[1]}=${placeholder(flag[2])}`;
    return placeholder(w);
  }).join(' ').replace(/(?:<str> ?){2,}/g, '<str> ').trim();
  return `${String(tool || 'tool').slice(0, 40)}: ${s}`.slice(0, METHOD_MAX);
}
function placeholder(w) {
  if (/^-/.test(w) || /^<[a-z]+>$/.test(w)) return w;                       // a flag, or a placeholder already
  if (/\//.test(w) || w.startsWith('~') || /^[\w@-]+(?:\.[\w@-]+)*\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(w)) return '<path>';   // a.test.mjs, foo.d.ts
  if (/^#?\d[\d.,:]*[a-z]?$/.test(w)) return '<n>';                          // 42, 1.2.3, 10,20p
  if (/^[0-9a-f]{7,64}$/i.test(w) && /\d/.test(w)) return '<id>';
  if (/^[A-Za-z0-9_-]{24,}$/.test(w)) return '<id>';
  const hex = /^(.*[-_])([0-9a-f]{6,})$/i.exec(w);   // job-a1b2c3: keep the word, drop the id
  if (hex && /\d/.test(hex[2])) return `${hex[1]}<id>`;
  const tail = /^(.*[^\d])(\d+)$/.exec(w);   // issue-1084, pr42: keep the word, drop the number
  return tail && tail[1].length >= 2 ? `${tail[1]}<n>` : w;
}
// The command a shell method runs, ignoring a leading `cd <dir> &&`.
const headOf = method => (/^[^:]*:\s*(?:cd \S+ (?:&&|;) )*(\S+)/.exec(method) || [])[1] || '';
const SHELL_TOOLS = new Set(['Bash', 'shell']);

const excerptOf = (text, secrets) => {
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  const pick = lines.find(l => !/^(?:exit(?: code)?[: ]+\d+)$/i.test(l)) || lines[0] || '';
  return redact(redactText(pick, secrets), EXCERPT_MAX);
};

// Entries are in sequence order. A result belongs to the call with its id; an older transcript without ids pairs it with the most
// recent call still waiting. Codex file_change, web_search and MCP calls have no result entry, so they are never failures here.
// A failure is "recovered" when, within a few results, the same tool (and for a shell, the same command) succeeds with a different
// method; the same method succeeding is a retry (recoveredWithSameMethod) and names no replacement.
// Tokens lost are the tokens reported between the failure and the recovery; null when the provider reported none in that span
// (Codex reports usage only at the end of a turn), so unknown is never counted as zero.
export function extractErrors(entries, { secrets = [] } = {}) {
  const byId = new Map(), loose = [], done = [];
  let tokenPrefix = 0;   // cumulative tokens when each result arrived
  for (const e of entries) {
    if (e.kind === 'usage' && e.tokens) tokenPrefix += (e.tokens.in || 0) + (e.tokens.out || 0);
    else if (e.kind === 'tool_call') {
      const c = { tool: String(e.tool || 'tool'), method: normalizeMethod(e.tool, e.text || e.detail || ''), seq: e.seq, at: e.at };
      if (e.callId) byId.set(e.callId, c); else loose.push(c);
    } else if (e.kind === 'tool_result') {
      const c = e.callId ? byId.get(e.callId) : loose.pop();
      if (!c || c.done) continue;
      Object.assign(c, { done: true, failed: e.error === true, text: e.text || '', tokensAt: tokenPrefix, resultAt: e.at });
      done.push(c);
    }
  }
  const failedBefore = new Map(), errors = [];
  let total = 0;
  done.forEach((c, i) => {
    if (!c.failed) return;
    const exit = exitOf(c.text), type = classifyError(c.text, { exit });
    const repeat = failedBefore.has(c.method); failedBefore.set(c.method, (failedBefore.get(c.method) || 0) + 1);
    let next = null;
    for (let k = i + 1; k < done.length && k <= i + LOOKAHEAD_CALLS; k++) {
      const d = done[k];
      if (d.failed || d.tool !== c.tool) continue;
      if (SHELL_TOOLS.has(c.tool) && d.method !== c.method && headOf(d.method) !== headOf(c.method)) continue;
      next = d; break;
    }
    const same = !!next && next.method === c.method, end = next || done[i + 1] || null;
    const lost = end ? end.tokensAt - c.tokensAt : 0;
    total++;
    if (errors.length < MAX_ERRORS_PER_JOB) errors.push({
      at: c.resultAt ?? c.at ?? null, tool: c.tool.slice(0, 40), method: c.method, type, excerpt: excerptOf(c.text, secrets), repeat,
      recovered: !!next, recoveredBy: next && !same ? next.method : null, recoveredWithSameMethod: same,
      tokensLost: end && lost > 0 ? lost : null,
    });
  });
  errors.dropped = total - errors.length;
  return errors;
}

// A job that ends again after a resume is recorded again: the record is rebuilt from the whole transcript. Never throws; a failure
// here must not disturb the dispatcher. A job with no stored transcript writes nothing (no transcript is not "no errors").
export async function recordJobErrors({ root, jobs, id, entry = {}, now = Date.now(), retentionDays = RETENTION_DAYS, secrets = secretValues() }) {
  try {
    if (!root || !validJobId(id)) return null;
    pruneAgentErrors(root, now, retentionDays);
    const read = readTranscript(root, id);
    if (read.missing) return null;
    const job = (await jobs?.get?.(id)) || {};
    const errors = extractErrors(read.entries, { secrets });
    const rec = { v: 1, at: now, job: id, kind: String(job.kind || entry.kind || 'job').slice(0, 24), agent: String(entry.agent || job.provider || '').slice(0, 40) || null,
      model: job.model ? redact(job.model, 60) : null, issue: job.issue ?? entry.issue ?? null, pr: entry.pr ?? null, dropped: errors.dropped || 0, errors };
    fs.mkdirSync(errorsDir(root), { recursive: true, mode: 0o700 });
    const tmp = `${fileOf(root, id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 }); fs.renameSync(tmp, fileOf(root, id));
    return rec;
  } catch { return null; }
}

// Removes records older than the retention period (by the time they were written). Returns the job ids removed.
export function pruneAgentErrors(root, now = Date.now(), retentionDays = RETENTION_DAYS) {
  const removed = [];
  let names; try { names = fs.readdirSync(errorsDir(root)); } catch { return removed; }
  for (const name of names) {
    const m = /^([a-f0-9]{32})\.json$/.exec(name); if (!m) continue;
    const file = path.join(errorsDir(root), name);
    try {
      let at; try { at = JSON.parse(fs.readFileSync(file, 'utf8')).at; } catch { /* unreadable: use the file time */ }
      if (!Number.isFinite(at)) at = fs.statSync(file).mtimeMs;
      if (now - at > retentionDays * DAY_MS) { fs.unlinkSync(file); removed.push(m[1]); }
    } catch { /* gone already */ }
  }
  return removed;
}

function readRecords(root, since) {
  let names; try { names = fs.readdirSync(errorsDir(root)); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    try { const r = JSON.parse(fs.readFileSync(path.join(errorsDir(root), name), 'utf8')); if (r && Array.isArray(r.errors) && Number.isFinite(r.at) && r.at >= since) out.push(r); } catch { /* damaged: skipped */ }
  }
  return out;
}

// Errors grouped by normalised method and type, with counts, jobs, agents and tokens lost. Filters: days, kind, agent.
export function agentErrorGroups(root, { now = Date.now(), days = 7, kind = null, agent = null, limit = 30 } = {}) {
  const span = Math.min(RETENTION_DAYS, Math.max(1, Math.trunc(Number(days)) || 7)), since = now - span * DAY_MS;
  const groups = new Map(); let total = 0, tokens = 0, recovered = 0, unknown = 0;
  for (const r of readRecords(root, since)) {
    if (kind && r.kind !== kind) continue;
    if (agent && r.agent !== agent) continue;
    for (const e of r.errors) {
      const key = `${e.type}\u0000${e.method}`;
      const g = groups.get(key) || { method: e.method, type: e.type, count: 0, repeats: 0, recovered: 0, jobs: new Set(), agents: new Set(), tokensLost: 0, recoveredBy: new Map(), tokensUnknown: 0, excerpt: e.excerpt };
      g.count++; g.tokensLost += e.tokensLost || 0; if (e.tokensLost == null) { g.tokensUnknown++; unknown++; } g.jobs.add(r.job.slice(0, 8)); if (r.agent) g.agents.add(r.agent);
      if (e.repeat) g.repeats++;
      if (e.recovered) { g.recovered++; if (e.recoveredBy) g.recoveredBy.set(e.recoveredBy, (g.recoveredBy.get(e.recoveredBy) || 0) + 1); }
      groups.set(key, g); total++; tokens += e.tokensLost || 0; if (e.recovered) recovered++;
    }
  }
  const rows = [...groups.values()].sort((a, b) => b.tokensLost - a.tokensLost || b.count - a.count).map(g => ({
    method: g.method, type: g.type, count: g.count, repeats: g.repeats, recovered: g.recovered, tokensLost: g.tokensLost, tokensUnknown: g.tokensUnknown, jobs: g.jobs.size, jobIds: [...g.jobs].slice(0, 5), agents: [...g.agents].sort(),
    recoveredBy: [...g.recoveredBy].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([method, n]) => ({ method, count: n })), exampleExcerpt: g.excerpt }));
  return { days: span, from: new Date(since).toISOString(), filters: { kind, agent }, errors: total, recovered, tokensLost: tokens, tokensUnknown: unknown, groupCount: rows.length, shown: Math.min(rows.length, limit), groups: rows.slice(0, limit),
    note: 'Built from job transcripts after each job ends. Tokens lost are approximate: the tokens used between the failure and the call that worked (or the next call); tokensUnknown counts errors where the provider reported none in that span (Codex reports usage once per turn), which are not counted as zero. A recovery is a later success of the same tool (for a shell, the same command) with a different method. Method text is normalised: paths, ids and numbers are placeholders.' };
}

// The two numbers team status shows: errors recorded in the last 24 hours and the tokens lost to them.
export function agentErrorTotals(root, now = Date.now()) {
  const g = agentErrorGroups(root, { now, days: 1, limit: 0 });
  return { errors: g.errors, tokensLost: g.tokensLost, tokensUnknown: g.tokensUnknown, recovered: g.recovered };
}
