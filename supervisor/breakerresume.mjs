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
// With consume: false a valid request's file stays until discardBreakerResumeRequests, so the caller can save its state first and a failed
// save does not lose the click (issue #737). A malformed file is always dropped.
export function takeBreakerResumeRequests(root, { consume = true } = {}) {
  let names = [];
  try { names = fs.readdirSync(resumeDir(root)).filter(n => n.endsWith('.json')).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const out = [];
  for (const n of names) {
    const f = path.join(resumeDir(root), n);
    let ok = false;
    try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); if (v && typeof v.scope === 'string' && Number.isFinite(v.at)) { out.push({ scope: v.scope, at: v.at, file: f }); ok = true; } } catch { /* malformed: dropped */ }
    if (consume || !ok) try { fs.unlinkSync(f); } catch { /* already taken */ }
  }
  return out;
}
export function discardBreakerResumeRequests(reqs) {
  for (const r of reqs) try { fs.unlinkSync(r.file); } catch { /* already taken */ }
}
