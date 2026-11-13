// Issue #867: a homeowner command (reopen, accept-split, request-review) that timed out waiting for the tick lock leaves one small request
// file; the next tick, which owns the state under the tick lock, applies it. One file per request, so a command and a tick never race.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson } from './core.mjs';
import { markDone } from './afterinstall.mjs';

export const QUEUED_COMMANDS = ['reopen', 'accept-split', 'request-review', 'after-install-done'];
const queueDir = root => path.join(root, 'homeowner-requests');

export function queueHomeownerRequest(root, command, args, at) {
  if (!QUEUED_COMMANDS.includes(command)) throw new Error(`cannot queue ${command}`);
  fs.mkdirSync(queueDir(root), { recursive: true, mode: 0o700 });
  atomicJson(path.join(queueDir(root), `${at}-${crypto.randomBytes(4).toString('hex')}.json`), { command, args: args.map(String), at });
}
// Valid requests are returned oldest first with their file; the caller discards each file once it has dealt with it. A malformed file is dropped.
export function takeHomeownerRequests(root) {
  let names = [];
  try { names = fs.readdirSync(queueDir(root)).filter(n => n.endsWith('.json')).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const out = [];
  for (const n of names) {
    const file = path.join(queueDir(root), n);
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (v && QUEUED_COMMANDS.includes(v.command) && Array.isArray(v.args) && v.args.every(x => typeof x === 'string') && Number.isFinite(v.at)) { out.push({ command: v.command, args: v.args, at: v.at, file }); continue; }
    } catch { /* malformed: dropped */ }
    try { fs.unlinkSync(file); } catch { /* already taken */ }
  }
  return out;
}
// The commands a person runs from a Needs you item, applied under the tick lock. Issue #1177 adds the end of an After install item.
export async function homeownerCommand(team, cmd, n) {
  if (cmd === 'accept-split') return { issue: n, filed: await team.acceptSplit(n) };
  markDone(team.s, n);
  team.save();
  return { pr: n, done: true };
}
export const discardHomeownerRequest = r => { try { fs.unlinkSync(r.file); } catch { /* already taken */ } };
