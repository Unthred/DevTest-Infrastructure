// Issue #1154 requirement 6: an Inbox job must not wait on queue state. This measures how long a job slept between checks, from the
// `sleep N` commands in its transcript, so Foreman can flag a job that spent most of its cap polling. Reads the transcript tail only.
import fs from 'node:fs';
import { readTranscript, transcriptFile, validJobId } from './transcript.mjs';

const TAIL_BYTES = 2 * 1024 * 1024;
const UNIT_MS = { '': 1000, s: 1000, m: 60000, h: 3600000 };
export const POLLING_SHARE = 0.5;

export function sleptMs(commandText) {
  let total = 0;
  for (const m of String(commandText).matchAll(/\bsleep\s+(\d+(?:\.\d+)?)([smh]?)\b/g)) total += Number(m[1]) * UNIT_MS[m[2]];
  return total;
}

export function pollingOf({ root, jobId, capMs }) {
  if (!validJobId(jobId) || !(capMs > 0)) return null;
  let size = 0;
  try { size = fs.statSync(transcriptFile(root, jobId)).size; } catch { return null; }
  const { entries } = readTranscript(root, jobId, { offset: Math.max(0, size - TAIL_BYTES) });
  let slept = 0;
  for (const e of entries) if (e.kind === 'tool_call' && e.tool === 'Bash') slept += sleptMs(e.detail || e.text || '');
  return slept >= capMs * POLLING_SHARE ? { sleptMs: Math.round(slept), capMs } : null;
}

export const pollingNote = p => `Polling: about ${Math.round(p.sleptMs / 60000)} of the ${Math.round(p.capMs / 60000)}-minute cap was spent sleeping between checks. An Inbox job must not wait on queue state; report and finish instead.`;
