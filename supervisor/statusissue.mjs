// Issue #358: Foreman publishes its live state to ONE pinned GitHub issue each tick, so the overseer can read it without the
// homeowner pasting reports. Model-free (GitHub API only). The body is built from an allowlist of already-redacted status
// fields and scrubbed again as a whole; it is rewritten only when the content changed. A failure here is recorded for the
// dashboard and never fails the tick.
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './core.mjs';
import { redact, redactAddresses } from './redact.mjs';

export const STATUS_MARKER = '<!-- foreman-status-issue -->';
export const STATUS_TITLE = 'Foreman status (live, pinned)';
export const isStatusIssue = i => String(i?.body || '').includes(STATUS_MARKER);
export const stateFile = root => path.join(root, 'team', 'status-issue.json');

// Free text from titles or reasons: secrets, addresses, hostnames, private paths and session ids removed; markup and mentions
// neutralised so a title can neither forge the marker nor notify anyone.
export function scrub(value, max = 300) {
  return redactAddresses(redact(value, max))
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/(^|[\s(=:'"`])\/(?:mnt|root|home|var|etc|tmp|usr|opt|srv|boot|run|proc|dev|Users)\b[^\s,;)'"`]*/g, '$1[path]')
    .replace(/\b[A-Za-z]:\\[^\s,;)'"`]*/g, '[path]')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:local|lan|home|internal|localdomain|home\.arpa|ts\.net)\b/gi, '[host]')
    .replace(/<!--|-->/g, '')
    .replace(/@(?=[A-Za-z0-9])/g, '@​')
    .replace(/[\r\n]+/g, ' ').trim();
}

const line = (...parts) => scrub(parts.filter(p => p != null && p !== '').join(' '));
const bullets = (items, none) => (items.length ? items.map(t => `- ${t}`) : [`- ${none}`]);

// The body without the time stamp: what the "unchanged" test compares.
export function renderContent(s) {
  const out = ['## Running jobs'];
  out.push(...bullets((s.agents || []).filter(a => a.state === 'running' && a.job).map(a => line(a.name + ':', a.job.name)), 'none'));
  out.push('', '## Queue');
  out.push(...bullets([...(s.next?.plan || []).map(p => line('next:', p.text)), ...(s.next?.waiting || []).map(w => line(w.text))], 'empty'));
  out.push('', '## Review order');
  out.push(...bullets((s.reviewOrder || []).map(r => line(r.text)), 'no pull request is waiting for a review'));
  out.push('', '## Open pull requests');
  out.push(...bullets((s.pulls || []).map(p => line(p.name, '-', p.status + ',', 'CI', p.ci + ',', p.verdict ? `${p.verdict.verdict}${p.verdict.current ? '' : ' (older commit)'}` : 'no verdict yet')), 'none open'));
  out.push('', '## Allowance by provider');
  out.push(...bullets((s.allowance || []).map(a => line(a.text)), 'no allowance data'));
  out.push('', '## Inbox');
  out.push(...bullets((s.needsYou || []).map(n => line(n.text)), 'nothing'));
  out.push('', `Installed version: ${scrub(s.installed || 'unknown', 12)}`);
  return out.join('\n');
}
export const renderBody = (s, now) => `${STATUS_MARKER}\n_Written by Foreman each tick when something changes. Do not edit, close or treat as work._\n\n${renderContent(s)}\n\nLast updated: ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC\n`;

const hashOf = text => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16) + ':' + text.length; };
function readState(root) { try { const s = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; } }
export const readStatusIssueState = readState;

// Never throws. Returns what happened: 'created' | 'updated' | 'unchanged' | 'failed'.
export async function publishStatusIssue({ root, gh, status, now = Date.now() }) {
  const prev = readState(root);
  const save = next => { try { fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true }); atomicJson(stateFile(root), next); } catch { /* best effort */ } };
  try {
    const s = typeof status === 'function' ? await status() : status;
    const body = renderBody(s, now), hash = hashOf(renderContent(s));
    let number = Number.isSafeInteger(prev.number) ? prev.number : null, result;
    if (!number) number = await gh.findIssueByMarker(STATUS_MARKER);   // restart: find the existing issue, never create a second
    if (!number) {
      number = await gh.createIssue(STATUS_TITLE, body); result = 'created';
      save({ number, hash, at: now, pinned: false, error: null });
    } else if (prev.number === number && prev.hash === hash) result = 'unchanged';   // hash is saved only after a successful body write, so an earlier error never forces a rewrite
    else { await gh.updateIssueBody(number, body); result = 'updated'; }
    let pinned = prev.number === number && prev.pinned === true, pinError = null;
    if (result === 'unchanged' && pinned && !prev.error) return result;
    if (!pinned) { try { await gh.pinIssue(number); pinned = true; } catch (e) { pinError = e?.message || 'pin failed'; } }
    save({ number, hash, at: now, pinned, error: pinError ? scrub(`could not pin the status issue: ${pinError}`) : null });
    return result;
  } catch (e) {
    save({ ...prev, error: scrub(`status issue not updated: ${e?.message || e}`), errorAt: now });
    return 'failed';
  }
}
