// Issue #623: what one job did and how it ended, as a bounded, redacted record for the read-only Foreman MCP tools (D-030).
// The MCP account cannot read the state root, so the dashboard serves this from its existing GET handler (one narrow route,
// /api/jobs/<id>/outcome.json). It only reads: the job record, the event names, the end of the transcript and the dispatcher's
// entry for the job. It calls no model, takes no lock and writes nothing.
import { gbpAmount } from './money.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.mjs';
import { shownCause } from './restartcause.mjs';
import { readTranscript, validJobId } from './transcript.mjs';
import { readTeamState } from './dashdata.mjs';

export const LOG_TAIL_ENTRIES = 25;       // transcript entries returned
export const LOG_ENTRY_CHARS = 300;       // characters kept of each one
export const EVENTS_KEPT = 15;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;  // the transcript is read from this offset, never whole

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// Issue #1423: a restart shows who or what did it.
const eventName = e => ({ at: e.at, kind: e.kind.slice(0, 64), ...(e.kind === 'recovered' ? { cause: shownCause(e.detail?.cause) } : {}) });
const readEventNames = (root, id) => {
  let text; try { text = fs.readFileSync(path.join(root, 'events', `${id}.jsonl`), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n').slice(-200)) { try { const e = JSON.parse(line); if (e && Number.isFinite(e.at) && typeof e.kind === 'string') out.push(eventName(e)); } catch { /* damaged line */ } }
  return out.filter(e => e.kind !== 'checkpoint').slice(-EVENTS_KEPT);   // checkpoints are frequent and say nothing about the end
};
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// The id must be the full 32 hex characters; the caller resolves a short id from the view. Returns null when there is no such job.
export function jobOutcome(root, id) {
  if (!validJobId(id)) return null;
  const job = readJson(path.join(root, 'jobs', `${id}.json`));
  if (!job || typeof job !== 'object') return null;
  const entry = readTeamState(root).jobs?.[id] || {};
  const size = (() => { try { return fs.statSync(path.join(root, 'transcripts', `${id}.jsonl`)).size; } catch { return 0; } })();
  const entries = readTranscript(root, id, { offset: Math.max(0, size - TRANSCRIPT_TAIL_BYTES) }).entries;
  const tools = {}; let pushCommands = 0, lastAssistant = null;
  for (const e of entries) {
    if (e.kind === 'tool_call') { const n = String(e.tool || 'tool').slice(0, 32); tools[n] = (tools[n] || 0) + 1; if (/\bgit\b[^\n]*\bpush\b/.test(String(e.text || e.detail || ''))) pushCommands++; }
    if (e.kind === 'assistant' && e.text) lastAssistant = e.text;
  }
  const reason = job.incompleteReason || null, cp = job.checkpoint || null;
  const startHead = entry.head || null, nowHead = cp?.head || null;
  return {
    id, kind: job.kind || 'job', issue: job.issue ?? null, pr: entry.pr ?? null, branch: redact(job.branch || '', 100), agent: entry.agent ?? job.provider ?? null, model: job.model || null,
    asked: redact(job.scope || '', 400),   // the scope line the job was created with, what it was asked to do
    status: job.status, attempts: job.attempts || 0, lastEvent: redact(job.lastEvent || '', 64), startedAt: iso(job.createdAt), endedAt: ['completed', 'failed', 'blocked', 'stopped'].includes(job.status) ? iso(job.updatedAt) : null,
    postcondition: { kind: job.postcondition?.kind ?? null, met: job.postcondition ? (job.status === 'completed' && !reason) : null, notMetBecause: reason ? { cause: redact(reason.cause || '', 64), detail: redact(reason.detail || '', 400), attempt: reason.attempt ?? null } : null },
    did: { transcriptEntriesRead: entries.length, transcriptAvailable: size > 0, toolCalls: tools, lastAssistantMessage: lastAssistant ? redact(lastAssistant, 600) : null },
    // Evidence about pushed work, stated as evidence: the record has no remote check. A local commit that was never pushed shows as headMovedLocally with no push command.
    pushed: { headAtStart: startHead ? String(startHead).slice(0, 12) : null, lastCheckpointHead: nowHead ? String(nowHead).slice(0, 12) : null, headMovedLocally: startHead && nowHead ? startHead !== nowHead : null, uncommittedFiles: Array.isArray(cp?.status) ? cp.status.length : null, pushCommandsInLog: pushCommands,
      note: 'Evidence only: Foreman does not check the remote here. Compare with the pull request head (foreman_why_blocked).' },
    cost: { tokens: job.usage ? (job.usage.inputTokens || 0) + (job.usage.outputTokens || 0) : null, gbpEquivalent: gbpAmount(job.usage?.costUsdEstimate) },
    events: readEventNames(root, id).map(e => ({ at: iso(e.at), kind: e.kind, ...(e.cause ? { cause: e.cause } : {}) })),
    logTail: entries.slice(-LOG_TAIL_ENTRIES).map(e => ({ seq: e.seq, kind: e.kind, text: redact(`${e.tool ? e.tool + ': ' : ''}${e.text || e.detail || ''}`, LOG_ENTRY_CHARS) })),
  };
}

// Every result Foreman threw away (a review refused at ingestion, a review that ended with no verdict, a job that failed after spending),
// from the circuit breaker's own waste record: why, and what it cost. Newest first, at most `limit`.
export function discarded(state, limit = 50) {
  const rows = Object.values(state?.breaker?.waste || {}).filter(w => w && typeof w === 'object')
    .sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
  const all = Object.values(state?.breaker?.waste || {});
  const sum = k => all.reduce((n, w) => n + (Number.isFinite(w[k]) ? w[k] : 0), 0);
  return {
    count: all.length, shown: rows.length, totalTokens: sum('tokens'), totalCostGbpEquivalent: gbpAmount(sum('cost')),
    note: 'Waste on file for the last 7 days (at most 1000 records). Cost is a usage equivalent, not a charge.',
    items: rows.map(w => ({ job: String(w.job || '').slice(0, 32), at: iso(w.at), type: redact(w.type || '', 24), cause: redact(w.cause || '', 120), agent: w.agent ?? null, model: redact(w.model || '', 60) || null, pr: w.pr ?? null, issue: w.issue ?? null, tokens: w.tokens ?? 0, costGbpEquivalent: gbpAmount(w.cost) ?? 0 })),
  };
}
