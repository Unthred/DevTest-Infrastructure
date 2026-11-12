// Issue #1160: the upgrade latch as a decision. Two parts: the text the Needs you card shows (why it was set, when, what would install next),
// and the approved clear_latch action. Clearing is a single recorded step under upgrade.lock, so it never races an install. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.mjs';

const SHA = /^[0-9a-f]{40}$/;
const sha7 = s => (SHA.test(s || '') ? s.slice(0, 7) : 'an unknown commit');
const STOP_DIR = '/mnt/cache/logs/agent-cleanup';   // where a homeowner stop record lives (docs/foreman-mcp.md, foreman_stop_record)
const PATH_IN_REASON = /(?<=^|[\s(\["'`])\/[A-Za-z0-9._\/-]+\.(?:md|txt)\b/;
const STOP_LINES = 3;

// The first lines of the stop record a homeowner pause names, or []. Only a file directly inside the stop directory, opened without following
// a link; anything else is simply not shown (the reason text is still on the card).
export function stopLines(reason, { dir = process.env.STOP_DIR || STOP_DIR, fsApi = fs } = {}) {
  const named = PATH_IN_REASON.exec(String(reason ?? ''))?.[0];
  if (!named || path.dirname(path.resolve(named)) !== path.resolve(dir)) return [];
  let fd;
  try {
    fd = fsApi.openSync(path.resolve(named), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fsApi.fstatSync(fd).isFile()) return [];
    const buf = Buffer.alloc(4096);
    const n = fsApi.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8').split('\n').map(l => l.trim()).filter(Boolean).slice(0, STOP_LINES).map(l => redact(l, 160));
  } catch { return []; } finally { if (fd !== undefined) try { fsApi.closeSync(fd); } catch { /* closed */ } }
}

const when = at => (Number.isFinite(at) ? new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'at an unrecorded time');

// What would install next once the latch is cleared: the commits main is ahead of the installed version.
function nextInstall(ver) {
  if (Number.isSafeInteger(ver?.behind) && ver.behind > 0) return `Clearing it lets the next tick consider installing main ${sha7(ver.main)}, ${ver.behind} commit${ver.behind === 1 ? '' : 's'} ahead of the installed ${sha7(ver.installed)}.`;
  if (ver?.behind === 0) return 'The installed version is already main; there is nothing to install.';
  return 'How far main is ahead of the installed version is not known yet.';
}

// Pure. `latch` is the parsed latch file ({at, from, to, reason}, or just {reason} when unreadable); `ver` is the dashboard's version reading;
// `stop` the first lines of a stop record. A rollback names both versions; a latch without them is a homeowner pause.
export function latchCardText(latch, ver = null, stop = []) {
  const why = String(latch?.reason || 'no reason recorded').slice(0, 200);
  const head = SHA.test(latch?.from || '') && SHA.test(latch?.to || '')
    ? `Automatic upgrades are paused: the upgrade from ${sha7(latch.from)} to ${sha7(latch.to)} was rolled back (failed check: ${why}), ${when(latch.at)}.`
    : `Automatic upgrades are paused by a homeowner pause, ${when(latch?.at)}: ${why}.`;
  const record = stop.length ? ` Stop record: ${stop.join(' | ')}` : '';
  return `${head}${record} ${nextInstall(ver)} Merged work is not installed until the latch is cleared.`;
}

// The dashboard's Needs you items for the latch: [] when none is set (a missing file); an unreadable file still shows a card.
export function latchAttention(root, ver) {
  let latch;
  try { latch = JSON.parse(fs.readFileSync(path.join(root, 'team', 'self-upgrade.latch'), 'utf8')); } catch (error) { latch = error.code === 'ENOENT' ? null : { reason: 'unreadable latch file' }; }
  if (!latch) return [];
  const text = redact(latchCardText(latch, ver, stopLines(latch.reason)), 700);
  return [{ id: 'upgrade-latched', text, ref: null, severity: 'action', action: 'Find out why the upgrade failed, then clear the latch so the next tick can try again.' }];
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };

// The approved action. Refuses (throws, so the item ends 'failed' with the reason and nothing changes) when no latch is set or an install is
// running; otherwise removes the latch and records who, when and why in upgrades.jsonl. `deps`: upgradeLock(root) -> unlock | null,
// handInstallHold(root) -> hold | null, now().
export function clearLatchApproved({ root, reason, by = 'homeowner' }, deps) {
  const dir = path.join(root, 'team'), latchFile = path.join(dir, 'self-upgrade.latch');
  const fail = text => { throw new Error(text); };
  const unlock = deps.upgradeLock(root);
  if (!unlock) fail('an install is running (upgrade.lock is held); the latch was not cleared, try again when it has finished');
  try {
    if (deps.handInstallHold(root)) fail('a hand-install is in progress; the latch was not cleared');
    if (!fs.existsSync(latchFile)) fail('no upgrade latch is set (it was already cleared); nothing to clear');
    const state = readJson(path.join(dir, 'self-upgrade.json')) || {};
    if (state.pending || state.dashboardPending) fail('an install is waiting for its verification; the latch was not cleared');
    const latch = readJson(latchFile) || { reason: 'unreadable latch' };
    fs.rmSync(latchFile, { force: true });
    const entry = { at: deps.now(), result: 'latch_cleared', from: SHA.test(latch.from || '') ? latch.from : null, to: SHA.test(latch.to || '') ? latch.to : null,
      by, why: redact(String(reason ?? ''), 300), was: redact(String(latch.reason ?? ''), 300) };
    fs.appendFileSync(path.join(dir, 'upgrades.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return `upgrade latch cleared (it was: ${entry.was || 'no reason recorded'}); the next tick may upgrade under the existing rules`;
  } finally { unlock(); }
}
