// Issue #1410: Foreman wakes itself. A pass that merged a pull request, ingested a verdict or report, finished a description round or
// changed a parked state made more work startable, so it asks for one more pass (reason `follow-up`) instead of waiting for the schedule.
// The ordinary one-flag model then runs exactly one more pass. A pass that changed nothing asks for none, and at most MAX_FOLLOW_UP_CHAIN
// follow-up passes are requested in a row without a job starting or ending, so the chain cannot loop.
import fs from 'node:fs';
import path from 'node:path';
import { requestWake } from './wake.mjs';

export const FOLLOW_UP = 'follow-up';
export const MAX_FOLLOW_UP_CHAIN = 3;
const NON_JOBS = new Set(['merge', 'inbox']);

// Pure: why this pass made more work startable (empty when it changed nothing).
export function changesOf(report) {
  const why = [];
  if ((report?.planned || []).some(r => r.type === 'merge' && r.outcome === 'launched')) why.push('merged a pull request');
  if ((report?.ingested || []).length) why.push('ingested a verdict or report');
  if ((report?.notified || []).some(n => n.descriptionRound)) why.push('finished a description round');
  if ((report?.parkedChanged || []).length) why.push('changed a parked state');
  return why;
}
// Pure: a job started (a launched planned action that is not a merge or inbox item) or ended (something was ingested).
export const jobMoved = report => (report?.ingested || []).length > 0 || (report?.planned || []).some(r => r.outcome === 'launched' && !NON_JOBS.has(r.type));

// Pure decision: whether to ask for a follow-up pass, and the chain length that follows.
export function decideFollowUp({ changes, moved, chain }) {
  const base = moved ? 0 : chain;
  if (!changes.length) return { request: false, chain: 0, why: 'the pass changed nothing' };
  if (base >= MAX_FOLLOW_UP_CHAIN) return { request: false, chain: base, why: `${MAX_FOLLOW_UP_CHAIN} follow-up passes ran in a row without a job starting or ending` };
  return { request: true, chain: base + 1, why: changes.join(', ') };
}

const chainFile = root => path.join(root, 'team', 'follow-up-chain.json');
const readChain = root => { try { const n = JSON.parse(fs.readFileSync(chainFile(root), 'utf8')).count; return Number.isSafeInteger(n) && n > 0 ? n : 0; } catch { return 0; } };
function writeChain(root, count) {
  fs.mkdirSync(path.dirname(chainFile(root)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(chainFile(root), JSON.stringify({ count }), { mode: 0o600 });
}

// Called once at the end of a pass. Best effort: a failure only loses the speed-up, the schedule is the fallback.
export function requestOwnFollowUp({ root, report, cap, spawnPass, log = line => console.error(line) }) {
  try {
    const decision = decideFollowUp({ changes: changesOf(report), moved: jobMoved(report), chain: readChain(root) });
    writeChain(root, decision.chain);
    if (!decision.request) {
      if (decision.chain > 0) log(`ai-supervisor: no follow-up pass: ${decision.why}`);
      return { requested: false, why: decision.why };
    }
    return { ...requestWake({ root, reason: FOLLOW_UP, cap, spawnPass }), why: decision.why };
  } catch (error) {
    log(`ai-supervisor: follow-up pass not requested: ${error?.name || 'Error'}`);
    return { requested: false, why: 'the follow-up request failed' };
  }
}
