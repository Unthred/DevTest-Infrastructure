// Access proof and cooldown for the dashboard's writes (issue #434). Node built-ins only.
// The proof is a random secret kept in the state root (mode 0600) and put in each write form as a hidden field. The server compares it in
// constant time. It does not depend on any header the client chooses, so a forged Origin without the secret is refused. A refused request is
// never logged with the secret. The cooldown per (write, agent) is kept in the state root, so it survives a dashboard restart.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson } from './core.mjs';
import { dashDir } from './dashdata.mjs';

export const PROBE_COOLDOWN_MS = 5 * 60000;
export const MARK_READ_COOLDOWN_MS = 5000;   // Mark as read is cheap, so its cooldown is short
export const INBOX_COOLDOWN_MS = 1000;   // one decision a second: a double-click cannot decide two cards
const tokenFile = root => path.join(dashDir(root), 'write-token');
const cooldownFile = root => path.join(dashDir(root), 'write-cooldown.json');

export function writeToken(root) {
  try { const t = fs.readFileSync(tokenFile(root), 'utf8').trim(); if (/^[a-f0-9]{64}$/.test(t)) return t; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(dashDir(root), { recursive: true, mode: 0o700 });
  const fresh = crypto.randomBytes(32).toString("hex"), temp = `${tokenFile(root)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, fresh + '\n', { mode: 0o600, flag: 'wx' });
  try { fs.linkSync(temp, tokenFile(root)); } catch (error) { if (error.code !== 'EEXIST') throw error; } finally { fs.unlinkSync(temp); }
  return fs.readFileSync(tokenFile(root), 'utf8').trim();   // whichever writer won the race
}
export function proofValid(root, given) {
  if (typeof given !== 'string' || !given) return false;
  const h = s => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(given), h(writeToken(root)));
}
// Add the hidden proof field to every write form of a rendered page.
export const withProof = (html, root) => html.replace(/(<form method="post"[^>]*>)/g, `$1<input type="hidden" name="proof" value="${writeToken(root)}">`);

function readCooldowns(root) {
  try { const v = JSON.parse(fs.readFileSync(cooldownFile(root), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}; throw error; }
}
// Reserve the slot synchronously (before any await) so two simultaneous requests cannot both pass. Returns { ok:true } or { ok:false, retryAt }.
export function reserveCooldown(root, key, now, ms = PROBE_COOLDOWN_MS) {
  const all = readCooldowns(root), last = all[key];
  if (Number.isFinite(last) && now - last < ms && now >= last) return { ok: false, retryAt: last + ms };
  atomicJson(cooldownFile(root), { ...all, [key]: now });
  return { ok: true };
}
// A request that ran nothing and spent nothing gives its slot back.
export function releaseCooldown(root, key, now) {
  const all = readCooldowns(root); if (all[key] !== now) return;
  delete all[key]; atomicJson(cooldownFile(root), all);
}

