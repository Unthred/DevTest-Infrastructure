// Issue #1154 requirement 6: an Inbox job must not wait on queue state. This measures how long a job waited between checks, from the
// timestamps of its transcript, so Foreman can flag a job that spent most of its cap polling. Reads the transcript tail only.
import fs from 'node:fs';
import { readTranscript, transcriptFile, validJobId } from './transcript.mjs';

const TAIL_BYTES = 2 * 1024 * 1024;
export const POLLING_SHARE = 0.5;
const SHELL_TOOLS = new Set(['Bash', 'shell']);   // Claude and Codex name their command tool differently
const WAITING_COMMAND = /\b(?:sleep|until|while)\b/;

// A call that waits: a Monitor call, or a shell command that sleeps or loops. One definition for every provider.
export function isWaitingCall(e) {
  if (e?.kind !== 'tool_call') return false;
  if (e.tool === 'Monitor') return true;
  return SHELL_TOOLS.has(e.tool) && WAITING_COMMAND.test(e.detail || e.text || '');
}

// Wall time spent waiting: from each waiting call to the next transcript entry. A loop that sleeps many times counts for as long as it
// ran, not once, and a Monitor call counts too.
export function waitedMs(entries) {
  let total = 0;
  for (let i = 0; i < entries.length - 1; i++) {
    if (!isWaitingCall(entries[i])) continue;
    const gap = Number(entries[i + 1].at) - Number(entries[i].at);
    if (Number.isFinite(gap) && gap > 0) total += gap;
  }
  return total;
}

export function pollingOf({ root, jobId, capMs }) {
  if (!validJobId(jobId) || !(capMs > 0)) return null;
  let size = 0;
  try { size = fs.statSync(transcriptFile(root, jobId)).size; } catch { return null; }
  const { entries } = readTranscript(root, jobId, { offset: Math.max(0, size - TAIL_BYTES) });
  const waited = waitedMs(entries);
  return waited >= capMs * POLLING_SHARE ? { sleptMs: Math.round(waited), capMs } : null;
}

export const pollingNote = p => `Polling: about ${Math.round(p.sleptMs / 60000)} of the ${Math.round(p.capMs / 60000)}-minute cap was spent waiting between checks. An Inbox job must not wait on queue state; report and finish instead.`;
