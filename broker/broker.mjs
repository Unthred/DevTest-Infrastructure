// Host-side secret broker (issue #7, D-008). Resolves declared secrets from OpenBao (or the dry-run mock), writes each one to
// a private file on tmpfs, hands the runner only the file paths, then overwrites, deletes and revokes on every outcome.
// Delivery decision (OQ-1): read-only FILE bind mounts at /secrets/<name>. Never argv, never environment, never /out.
import fs from 'node:fs';
import path from 'node:path';
import { BrokerError, safeSecretPath } from './openbao.mjs';
import { reduceSession, validDomain } from './session.mjs';

const nameRe = /^[a-z][a-z0-9-]{0,31}$/;
export const DEFAULT_SECRET_ROOT = '/dev/shm/devtest-secrets';
// The recorded decision that confirms a production identity must be homeowner-approved in the decision register. A missing or
// unreadable register refuses, and an agent proposal (or an id that is not in the register) never counts.
export function decisionApproved(registerText, id) {
  if (typeof registerText !== 'string' || !/^D-\d{3}$/.test(id ?? '')) return false;
  const m = registerText.match(new RegExp(`^## ${id} [^\\n]*\\n((?:(?!^## ).*\\n?)*)`, 'm'));
  return !!m && /^- Status: homeowner-approved\s*$/m.test(m[1]);
}
export function readDecisionRegister(file = new URL('../docs/DECISIONS.md', import.meta.url)) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
export const secretRunDirectory = (root, id) => path.join(root, id);
export const secretFilePath = (root, id, name) => path.join(secretRunDirectory(root, id), name);
export const secretContainerPath = (name) => `/secrets/${name}`;

// Policy: which names exist, where they live in OpenBao, what they may be used for. It holds paths, never values.
export function validatePolicy(policy) {
  if (!policy || policy.schema_version !== 1 || typeof policy.secrets !== 'object' || Array.isArray(policy.secrets)) throw new BrokerError('policy must be schema_version 1 with a secrets map', 4);
  for (const [name, e] of Object.entries(policy.secrets)) {
    if (!nameRe.test(name)) throw new BrokerError(`policy: invalid secret name ${JSON.stringify(name)}`, 4);
    if (!safeSecretPath(e.path)) throw new BrokerError(`policy: ${name} has an invalid path`, 4);
    if (!['credential', 'session'].includes(e.kind)) throw new BrokerError(`policy: ${name} kind must be credential or session`, 4);
    if (!Array.isArray(e.domains) || !e.domains.length || !e.domains.every(validDomain)) throw new BrokerError(`policy: ${name} needs a domain allow-list`, 4);
    if (!Number.isSafeInteger(e.maxTtlSeconds) || e.maxTtlSeconds < 60 || e.maxTtlSeconds > 86400) throw new BrokerError(`policy: ${name} maxTtlSeconds must be 60..86400`, 4);
  }
  return policy;
}

// Live Home Assistant (or any entry marked production) is refused until a dedicated, least-privilege test identity has been
// confirmed. Confirmation is a recorded homeowner act (a dated decision), not something an agent can infer.
export function assertAllowed(policy, name, register = readDecisionRegister()) {
  const e = policy.secrets[name];
  if (!e) throw new BrokerError(`secret ${JSON.stringify(name)} is not declared in the policy`, 4);
  if (e.production) {
    const c = policy.productionIdentity;
    if (!c || c.confirmed !== true || typeof c.decision !== 'string' || !/^D-\d{3}$/.test(c.decision) || !/^devtest-/.test(e.identity ?? ''))
      throw new BrokerError(`secret ${name}: production login is refused until a dedicated least-privilege devtest- identity is confirmed by a recorded decision`, 4);
    if (!decisionApproved(register, c.decision))
      throw new BrokerError(`secret ${name}: production login is refused: ${c.decision} is not a homeowner-approved decision in the decision register`, 4);
  }
  return e;
}

// Every non-empty value is scanned, however short: a short credential is still a credential, and a false match fails closed.
// Session state is the exception: it holds non-secret flags ("1", "true") that would match nearly any output, so its values keep a floor.
const SESSION_FLOOR = 8;
const encodings = (v, floor = 1) => [v, Buffer.from(v).toString('base64'), encodeURIComponent(v), JSON.stringify(v).slice(1, -1)].filter(s => s.length >= floor);

export class SecretHandle {
  #values = []; #leases = []; #backend; #dir; #files;
  constructor({ backend, dir, files }) { this.#backend = backend; this.#dir = dir; this.#files = files; this.dryRun = backend.kind === 'mock'; this.expiresAt = null; this.cleaned = false; }
  get mounts() { return this.#files.map(f => ({ name: f.name, host: f.host, container: f.container })); }
  _add(name, values, lease, floor = 1) { this.#values.push(...values.filter(v => typeof v === 'string').map(v => [v, floor])); if (lease) this.#leases.push(lease); }
  toJSON() { return { dryRun: this.dryRun, secrets: this.#files.map(f => f.name), expiresAt: this.expiresAt, cleaned: this.cleaned }; }
  // Looks for every held value (raw, base64, URL- and JSON-escaped) in the given files/directories. Reports file and
  // secret count only. A compressed trace cannot be scanned this way, so traces are refused for secret runs.
  scan(roots) {
    const needles = this.#values.flatMap(([v, floor]) => encodings(v, floor).map(s => Buffer.from(s)));
    const findings = []; let scanned = 0;
    const visit = (p) => {
      const st = fs.lstatSync(p, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) return;
      if (st.isDirectory()) { for (const n of fs.readdirSync(p)) visit(path.join(p, n)); return; }
      if (!st.isFile()) return;
      scanned++;
      const data = fs.readFileSync(p);
      if (needles.some(n => data.includes(n))) findings.push(p);
    };
    for (const r of roots) visit(r);
    return { scanned, findings, clean: findings.length === 0 };
  }
  async cleanup() {
    const result = { filesRemoved: 0, leasesRevoked: 0, errors: [] };
    for (const f of this.#files) {
      try {
        const st = fs.lstatSync(f.host, { throwIfNoEntry: false });
        if (st?.isFile()) { fs.chmodSync(f.host, 0o600); const fd = fs.openSync(f.host, 'r+'); try { fs.writeSync(fd, Buffer.alloc(st.size)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
        if (st) fs.unlinkSync(f.host);
        result.filesRemoved++;
      } catch { result.errors.push(`could not remove ${f.name}`); }
    }
    try { fs.rmSync(this.#dir, { recursive: true, force: true }); } catch { result.errors.push('could not remove the secret directory'); }
    if (fs.existsSync(this.#dir)) result.errors.push('secret directory still present');
    for (const l of this.#leases.splice(0)) { try { await this.#backend.revoke(l); result.leasesRevoked++; } catch { result.errors.push('could not revoke a lease'); } }
    this.#values = [];
    this.cleaned = result.errors.length === 0;
    return result;
  }
}

// Resolves and writes the requested secrets. On any failure everything already written is removed before the error leaves.
export async function materialize({ policy, names, backend, runId, root = DEFAULT_SECRET_ROOT, uid = process.getuid(), gid = process.getgid(), now = Date.now(), trace = false, decisions = readDecisionRegister() }) {
  validatePolicy(policy);
  if (!/^[a-f0-9]{16,32}$/.test(runId ?? '')) throw new BrokerError('invalid run id', 4);
  if (!Array.isArray(names) || !names.length || names.length > 4 || new Set(names).size !== names.length) throw new BrokerError('request one to four unique secret names', 4);
  if (trace) throw new BrokerError('traces keep request bodies and cannot be scanned; they are refused on a run that holds secrets', 4);
  const entries = names.map(n => [n, assertAllowed(policy, n, decisions)]);   // every name checked before anything is read or written
  if (process.getuid() !== 0 && uid !== process.getuid()) throw new BrokerError('cannot give the container user ownership; run as root or use the same uid', 3);
  const dir = secretRunDirectory(root, runId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o077) !== 0) throw new BrokerError('secret root is unsafe', 3);
  try { fs.mkdirSync(dir, { mode: 0o700 }); }   // exclusive: an existing directory means a collision or a leftover and is refused
  catch { throw new BrokerError('a secret directory already exists for this run id', 3); }
  const files = entries.map(([name]) => ({ name, host: secretFilePath(root, runId, name), container: secretContainerPath(name) }));
  const handle = new SecretHandle({ backend, dir, files });
  try {
    let expiry = Infinity;
    for (const [i, [name, e]] of entries.entries()) {
      await backend.assertReadOnly(e.path);
      const { values, leaseId } = await backend.read(e.path);
      let payload, secretStrings, until;
      if (e.kind === 'session') {
        let state = values.storage_state; if (typeof state === 'string') { try { state = JSON.parse(state); } catch { throw new BrokerError(`secret ${name}: stored session is not valid JSON`, 4); } }
        const reduced = reduceSession(state, { domains: e.domains, maxTtlSeconds: e.maxTtlSeconds, now });
        payload = JSON.stringify(reduced.state); until = reduced.expiresAt * 1000;
        secretStrings = [
          ...reduced.state.cookies.map(c => c.value),
          ...reduced.state.origins.flatMap(o => [o.localStorage, o.sessionStorage]
            .flatMap(entries => Array.isArray(entries) ? entries.map(e => e?.value).filter(v => typeof v === 'string') : []))
        ];
      } else {
        const wanted = e.fields ?? Object.keys(values);
        if (!wanted.length || !wanted.every(f => typeof values[f] === 'string' && values[f].length)) throw new BrokerError(`secret ${name}: expected fields are missing`, 4);
        const picked = Object.fromEntries(wanted.map(f => [f, values[f]]));
        payload = JSON.stringify(picked); secretStrings = Object.values(picked); until = now + e.maxTtlSeconds * 1000;
      }
      handle._add(name, secretStrings, leaseId, e.kind === 'session' ? SESSION_FLOOR : 1);
      expiry = Math.min(expiry, until);
      const fd = fs.openSync(files[i].host, 'wx', 0o400);
      try { fs.writeSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.chmodSync(files[i].host, 0o400);
      if (process.getuid() === 0) fs.chownSync(files[i].host, uid, gid);
    }
    handle.expiresAt = new Date(expiry).toISOString();
    return handle;
  } catch (error) {
    await handle.cleanup();
    throw error instanceof BrokerError ? error : new BrokerError('secret materialisation failed', 3);
  }
}

// A contaminated output file is overwritten and removed, so a failed run never leaves the secret behind. Reports counts only.
function discardFiles(paths) {
  const out = { removed: 0, failed: 0 };
  for (const p of paths) {
    try {
      const st = fs.lstatSync(p, { throwIfNoEntry: false });
      if (st?.isFile()) { fs.chmodSync(p, 0o600); const fd = fs.openSync(p, 'r+'); try { fs.writeSync(fd, Buffer.alloc(st.size)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      fs.unlinkSync(p); out.removed++;
    } catch { out.failed++; }
  }
  return out;
}

// Wraps a run: secrets exist only for the duration of fn, are cleaned on every outcome, and the output is scanned afterwards.
export async function withSecrets(options, fn, { outputRoots = [] } = {}) {
  const handle = await materialize(options);
  let result, thrown = null;
  try { result = await fn(handle); } catch (error) { thrown = error; }
  let leak, cleanup, discarded = { removed: 0, failed: 0 };
  try {
    leak = handle.scan(outputRoots);   // before cleanup: cleanup forgets the values
    discarded = discardFiles(leak.findings);
  } finally { cleanup = await handle.cleanup(); }
  // A leaked output or an incomplete cleanup outranks a subject failure: the run is refused and the problem is reported, never masked.
  const problems = [];
  if (!leak.clean) problems.push({ code: 8, text: `a secret value was found in ${leak.findings.length} output file(s); ${discarded.removed} discarded${discarded.failed ? `, ${discarded.failed} could NOT be removed and must be deleted by hand` : ''}` });
  if (cleanup.errors.length) problems.push({ code: 7, text: 'secret cleanup was incomplete' });
  if (problems.length) {
    const error = new BrokerError(problems.map(p => p.text).join('; ') + (thrown ? `; the subject also failed (${String(thrown?.name || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 48)})` : ''), problems[0].code);
    error.subjectFailed = !!thrown;   // the subject's own message is not copied: it could carry a secret
    throw error;
  }
  if (thrown) throw thrown;
  return { result, cleanup, leak };
}
