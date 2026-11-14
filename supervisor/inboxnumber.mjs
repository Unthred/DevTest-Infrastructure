// Issue #1414: the running number of an Inbox card ("C142"). Foreman gives each item the next number once, when it first records it;
// the counter lives in <inbox>/status/number.json, is written atomically under a lock, and a number is never given twice. A number the
// overseer's foreman_propose already reserved (foreman-mcp/inbox-reserve.mjs) is adopted, so the reply it got stays true. The 32 character
// id stays the key everywhere; the number is for people.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { highestNumber, releaseReservation, reservedNumber } from '../foreman-mcp/inbox-reserve.mjs';

const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 3000;
const counterFile = inboxDir => path.join(inboxDir, 'status', 'number.json');
const lockFile = inboxDir => path.join(inboxDir, 'status', 'number.lock');
export const hasNumber = status => Number.isSafeInteger(status?.number) && status.number > 0;

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// One writer at a time across processes: an exclusive lock file, stale after 10 s, waited for up to 3 s.
function withCounterLock(inboxDir, fn) {
  const lock = lockFile(inboxDir);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { return fn(); } finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch { /* already removed */ } }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock); } catch { /* released meanwhile */ }
      if (Date.now() > deadline) throw new Error('the inbox number counter is busy; try again');
      sleep(10);
    }
  }
}

function writeCounter(inboxDir, last) {
  const file = counterFile(inboxDir);
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, JSON.stringify({ last }) + '\n', { mode: 0o644, flag: 'wx' });
  fs.renameSync(temp, file);
}

// Numbers already given to other items, so a reserved number that clashes (a stale reader) is never adopted twice.
function takenNumbers(inboxDir) {
  const status = path.join(inboxDir, 'status');
  const taken = new Set();
  let names = [];
  try { names = fs.readdirSync(status); } catch { return taken; }
  for (const name of names.filter(n => /^[a-f0-9]{32}\.json$/.test(n))) {
    try { const number = JSON.parse(fs.readFileSync(path.join(status, name), 'utf8')).number; if (hasNumber({ number })) taken.add(number); } catch { /* damaged file */ }
  }
  return taken;
}

// The number for the item `id`: the one foreman_propose reserved for it, else the next after the highest in use.
export function assignNumber(inboxDir, id) {
  return withCounterLock(inboxDir, () => {
    const reserved = reservedNumber(inboxDir, id);
    const adopt = reserved !== null && !takenNumbers(inboxDir).has(reserved);
    const number = adopt ? reserved : highestNumber(inboxDir) + 1;
    writeCounter(inboxDir, Math.max(number, highestNumber(inboxDir)));
    if (reserved !== null) releaseReservation(inboxDir, reserved);
    return number;
  });
}

// Items recorded before numbers existed, oldest first (created time, then id so the order is the same on every run).
export const unnumberedOldestFirst = statuses => statuses.filter(s => !hasNumber(s))
  .sort((a, b) => (a.createdAt ?? a.updatedAt ?? 0) - (b.createdAt ?? b.updatedAt ?? 0) || String(a.id).localeCompare(String(b.id)));
