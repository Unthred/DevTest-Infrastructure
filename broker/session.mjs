// Authenticated session storage (Playwright storageState). A stored session is accepted only while it is unexpired, and only
// the parts that belong to an allow-listed domain are kept. Cookies are never exported to /out; this module returns the
// reduced state for a private mounted file and a metadata summary that holds no cookie names or values.
import { BrokerError } from './openbao.mjs';

const hostPattern = /^(?:\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const validDomain = (d) => typeof d === 'string' && d.length <= 253 && hostPattern.test(d);

// "example.test" and ".example.test" match example.test and its subdomains; "*.example.test" matches subdomains only.
export function domainAllowed(host, allowed) {
  const h = String(host).replace(/^\./, '').toLowerCase();
  return allowed.some((rule) => rule.startsWith('*.') ? h.endsWith(rule.slice(1)) && h.length > rule.length - 1 : h === rule || h.endsWith(`.${rule}`));
}

export function reduceSession(state, { domains, maxTtlSeconds, now = Date.now() }) {
  if (!Array.isArray(domains) || !domains.length || !domains.every(validDomain)) throw new BrokerError('a session needs a non-empty domain allow-list', 4);
  if (!Number.isSafeInteger(maxTtlSeconds) || maxTtlSeconds < 60 || maxTtlSeconds > 86400) throw new BrokerError('session max TTL must be 60..86400 seconds', 4);
  if (!state || typeof state !== 'object' || !Array.isArray(state.cookies ?? [])) throw new BrokerError('stored session is not a storage state', 4);
  const nowSec = Math.floor(now / 1000), ceiling = nowSec + maxTtlSeconds;
  const stats = { cookiesKept: 0, cookiesDropped: 0, originsKept: 0, originsDropped: 0, shortenedTo: null };
  const cookies = [];
  for (const c of state.cookies ?? []) {
    // A session cookie (no expiry) is not accepted: its lifetime would be unbounded.
    const ok = c && typeof c.name === 'string' && typeof c.value === 'string' && typeof c.domain === 'string' && Number.isFinite(c.expires) && c.expires > nowSec && domainAllowed(c.domain, domains);
    if (!ok) { stats.cookiesDropped++; continue; }
    cookies.push({ ...c, expires: Math.min(c.expires, ceiling) });
    stats.cookiesKept++;
  }
  const origins = [];
  for (const o of state.origins ?? []) {
    let host = null; try { host = new URL(o.origin).hostname; } catch { /* dropped */ }
    if (host && domainAllowed(host, domains)) { origins.push(o); stats.originsKept++; } else stats.originsDropped++;
  }
  if (!cookies.length && !origins.length) throw new BrokerError('stored session is expired or outside the domain allow-list', 4);
  const expires = cookies.length ? Math.min(...cookies.map(c => c.expires)) : ceiling;
  stats.shortenedTo = new Date(expires * 1000).toISOString();
  return { state: { cookies, origins }, expiresAt: expires, summary: stats };
}
