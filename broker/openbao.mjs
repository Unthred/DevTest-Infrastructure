// OpenBao backend (host side only). Reads through a scoped identity whose token is read from an owner-only FILE, never from
// argv or the container environment. The token and secret values never appear in an error, a log line or a result summary.
import fs from 'node:fs';

export class BrokerError extends Error {
  constructor(message, code = 3) { super(message); this.name = 'BrokerError'; this.exitCode = code; }
}

const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const safeSecretPath = (p) => typeof p === 'string' && p.length <= 200 && p.split('/').length <= 6 && p.split('/').every(s => segment.test(s));

export function checkAddress(raw) {
  let u; try { u = new URL(raw); } catch { throw new BrokerError('OpenBao address is not a URL'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new BrokerError('OpenBao address must be a bare origin');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new BrokerError('OpenBao address must be https, or http on loopback only');
  return u.origin;
}

// The token file must be a regular, non-symlinked file, owned by this user, unreadable to group and others.
export function readTokenFile(file, uid = process.getuid()) {
  const st = typeof file === 'string' && fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st) throw new BrokerError('OpenBao token file is missing');
  if (!st.isFile() || st.isSymbolicLink()) throw new BrokerError('OpenBao token file must be a regular file');
  if (st.uid !== uid || (st.mode & 0o077) !== 0) throw new BrokerError('OpenBao token file must be owned by this user with mode 0600 or tighter');
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!value || /\s/.test(value) || value.length > 512) throw new BrokerError('OpenBao token file does not hold a single token');
  return value;
}

export function createOpenBaoBackend({ address, tokenFile, mount = 'kv', fetchImpl = fetch, timeoutMs = 5000, uid }) {
  const origin = checkAddress(address);
  if (!segment.test(mount)) throw new BrokerError('invalid KV mount name');
  let token;
  const call = async (method, apiPath, body) => {
    token ??= readTokenFile(tokenFile, uid);
    let response;
    try {
      response = await fetchImpl(`${origin}/v1/${apiPath}`, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'X-Vault-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new BrokerError('OpenBao is unreachable'); }
    if (response.status === 403) throw new BrokerError('OpenBao refused the identity (403)');
    if (response.status === 404) throw new BrokerError('secret not found in OpenBao (404)');
    if (!response.ok) throw new BrokerError(`OpenBao returned HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new BrokerError('OpenBao returned an unreadable response'); }
  };
  return {
    kind: 'openbao',
    // Least privilege is checked, not assumed: an identity that can write or delete the path is refused.
    async assertReadOnly(secretPath) {
      const full = `${mount}/data/${secretPath}`;
      const caps = (await call('POST', 'sys/capabilities-self', { paths: [full] }))?.data?.[full] ?? [];
      if (!Array.isArray(caps)) throw new BrokerError('the identity cannot read this secret path');
      if (caps.includes('root') || ['create', 'update', 'delete', 'sudo'].some(c => caps.includes(c))) throw new BrokerError('the identity can modify this path; a read-only identity is required');
      if (!caps.includes('read')) throw new BrokerError('the identity cannot read this secret path');
    },
    async read(secretPath) {
      if (!safeSecretPath(secretPath)) throw new BrokerError('invalid secret path');
      const json = await call('GET', `${mount}/data/${secretPath}`);
      const values = json?.data?.data;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new BrokerError('secret has no data');
      return { values, leaseId: typeof json.lease_id === 'string' && json.lease_id ? json.lease_id : null };
    },
    async revoke(leaseId) { await call('PUT', 'sys/leases/revoke', { lease_id: leaseId }); }
  };
}

// Reachability and seal state need no credentials (sys/health is unauthenticated). Used by `doctor`.
export async function checkHealth({ address, fetchImpl = fetch, timeoutMs = 3000 }) {
  const origin = checkAddress(address);
  try {
    const r = await fetchImpl(`${origin}/v1/sys/health?standbyok=true&sealedcode=200&uninitcode=200`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    return { reachable: true, initialized: !!j.initialized, sealed: !!j.sealed, version: typeof j.version === 'string' ? j.version : null };
  } catch { return { reachable: false, initialized: false, sealed: null, version: null }; }
}
