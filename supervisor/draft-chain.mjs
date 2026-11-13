// Issue #1259: an issue draft that names earlier drafts (`after`) is posted only once they are issues, and its body then declares their numbers.
// Both functions are pure: the caller reads the statuses and carries out the result.
import { parseDependsOn } from './dependencies.mjs';

const label = (id, status) => `${String(status?.title || 'untitled').slice(0, 150)} (${id.slice(0, 8)})`;

// ids: full ids of the named drafts; statusOf(id) -> the status record or null. Returns one of
//   { action: 'post', numbers }  every named draft is posted
//   { action: 'wait', labels }   at least one is not decided yet (approved, pending, posting) and none has ended badly
//   { action: 'fail', reason }   one was rejected, refused or failed, or is no longer known
export function chainOutcome(ids, statusOf) {
  const numbers = [], waiting = [];
  for (const id of ids) {
    const status = statusOf(id);
    if (!status) return { action: 'fail', reason: `the named draft ${id.slice(0, 8)} is no longer known, so this draft was not posted` };
    if (['rejected', 'refused', 'failed'].includes(status.state)) return { action: 'fail', reason: `the named draft ${label(id, status)} was ${status.state}, so this draft was not posted` };
    if (status.state === 'done' && Number.isSafeInteger(status.issue) && status.issue > 0) numbers.push(status.issue);
    else waiting.push(label(id, status));
  }
  return waiting.length ? { action: 'wait', labels: waiting } : { action: 'post', numbers };
}

// Writes the numbers into the body's prerequisite declaration: into the line it already has, or one standalone line at the top. Numbers are not
// repeated. Returns the new body, or null when the result would not pass the dependency parser (the caller then fails the draft).
export function withPrerequisites(body, numbers) {
  const found = parseDependsOn(body);
  if (found.malformed) return null;
  const merged = [...new Set([...found.numbers, ...numbers])];
  const declaration = `Depends on: ${merged.map(n => `#${n}`).join(', ')}`;
  const lines = String(body).split('\n');
  const at = found.line ? lines.findIndex(line => line.trim() === found.line) : -1;
  const result = at >= 0 ? lines.map((line, index) => (index === at ? declaration : line)).join('\n') : `${declaration}\n\n${body}`;
  const check = parseDependsOn(result);
  return !check.malformed && merged.every(n => check.numbers.includes(n)) ? result : null;
}
