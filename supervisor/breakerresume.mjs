// Issue #626: the Resume button on the circuit breaker's card. The dashboard never edits Foreman's state: a click leaves one small request
// file, and the next tick (which owns the state file, under the tick lock) applies it. One file per click, so a click and a tick never race.
// Kept apart from dashwrite.mjs so the team module can import it without pulling in the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson } from './core.mjs';

export const BREAKER_RESUME_COOLDOWN_MS = 5000;
const resumeDir = root => path.join(root, 'dashboard', 'breaker-resume');

export function requestBreakerResume(root, scope, at) {
  fs.mkdirSync(resumeDir(root), { recursive: true, mode: 0o700 });
  atomicJson(path.join(resumeDir(root), `${at}-${crypto.randomBytes(4).toString('hex')}.json`), { scope, at });
}
export function takeBreakerResumeRequests(root) {
  let names = [];
  try { names = fs.readdirSync(resumeDir(root)).filter(n => n.endsWith('.json')).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const out = [];
  for (const n of names) {
    const f = path.join(resumeDir(root), n);
    try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); if (v && typeof v.scope === 'string' && Number.isFinite(v.at)) out.push({ scope: v.scope, at: v.at }); } catch { /* malformed: dropped */ }
    try { fs.unlinkSync(f); } catch { /* already taken */ }
  }
  return out;
}
