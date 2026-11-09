// What the rollback script says it did with the version directory the failed attempt created (issue #1120).
// The script prints one `cleanup: ...` line; this keeps it short and safe to store in the install record and the latch reason.
export function cleanupFrom(stdout) {
  const line = String(stdout || '').split('\n').find(l => l.startsWith('cleanup: '));
  return line ? line.slice('cleanup: '.length).trim().slice(0, 120) : null;
}

export function withCleanup(note, result) {
  return result?.cleanup ? `${note}; ${result.cleanup}` : note;
}

// The note shared by the install record, the upgrade log and the latch: why it rolled back, then what was cleaned up.
export function rollbackNote(reason, result) {
  const failed = `${reason}; ROLLBACK FAILED (${result.reason}), manual repair needed`;
  return withCleanup(result.ok ? reason : failed, result);
}

export function rollbackInstall(to, note, result) {
  return {
    result: result.ok ? 'rolled_back' : 'rollback_failed',
    sha: to,
    reason: note.slice(0, 200),
    ...(result.cleanup ? { cleanup: result.cleanup } : {})
  };
}
