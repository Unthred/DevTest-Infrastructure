// Issue #1115: a GitHub write made as Foreman's GitHub App, never as the owner account. The App is configured in team.json as
// github_app { app_id, installation_id, key_file } (set in the host's team.local.json through an approved host_value item); key_file is a path to
// the App's private key (PEM) on Tower. The key is refused unless it is a regular, non-symlink file readable by its owner only (decision D-039).
// Without that setting every App write is refused by name, so nothing falls back to the owner login.
// The key and the tokens are never logged or placed in an argument list: the JWT and the installation token travel only in request headers.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { SupervisorError } from './core.mjs';

const API = 'https://api.github.com';
const b64 = x => Buffer.from(x).toString('base64url');

export const validGithubApp = a => !!a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).every(k => ['app_id', 'installation_id', 'key_file'].includes(k))
  && Number.isSafeInteger(a.app_id) && Number.isSafeInteger(a.installation_id) && typeof a.key_file === 'string' && path.isAbsolute(a.key_file);

export const appConfigured = config => {
  const a = config?.github_app;
  return !!(a && Number.isSafeInteger(a.app_id) && Number.isSafeInteger(a.installation_id) && typeof a.key_file === 'string' && a.key_file);
};

// Owner-only rule as for the OpenBao token file (docs/secrets.md): a regular file, not a symlink, no group or other access.
export function readKeyFile(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new SupervisorError('the GitHub App key file must be a regular file, not a link');
  if (st.mode & 0o077) throw new SupervisorError('the GitHub App key file must be readable by its owner only (chmod 600)');
  return fs.readFileSync(file);
}

export function appJwt({ appId, key, now = Date.now() }) {
  const iat = Math.floor(now / 1000) - 30;
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), claims = b64(JSON.stringify({ iat, exp: iat + 540, iss: String(appId) }));
  return `${head}.${claims}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), key).toString('base64url')}`;
}

const headers = token => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'foreman' });

async function installationToken(app, { fetchFn, readKey, now }) {
  const jwt = appJwt({ appId: app.app_id, key: readKey(app.key_file), now });
  const res = await fetchFn(`${API}/app/installations/${app.installation_id}/access_tokens`, { method: 'POST', headers: headers(jwt) });
  if (!res.ok) throw new SupervisorError(`GitHub App token request failed (HTTP ${res.status})`);
  const token = (await res.json())?.token;
  if (typeof token !== 'string' || !token) throw new SupervisorError('GitHub App token request returned no token');
  return token;
}

// Adds an existing label to an issue or pull request as the App. Never creates or recolours the label.
export async function addLabelAsApp(config, n, label, { fetchFn = fetch, readKey = readKeyFile, now = Date.now() } = {}) {
  if (!appConfigured(config)) throw new SupervisorError('Foreman has no GitHub App identity configured (github_app in team.local.json), so it will not label as the owner account');
  const token = await installationToken(config.github_app, { fetchFn, readKey, now });
  const res = await fetchFn(`${API}/repos/${config.repository}/issues/${Number(n)}/labels`, { method: 'POST', headers: { ...headers(token), 'content-type': 'application/json' }, body: JSON.stringify({ labels: [label] }) });
  if (!res.ok) throw new SupervisorError(`GitHub App label write failed (HTTP ${res.status})`);
}

// The App setting is host-only: it comes from team.local.json and is checked there, so a malformed value fails the override by name.
export function withHostGithubApp(shipped, local) {
  if (!('github_app' in local)) return shipped;
  if (!validGithubApp(local.github_app)) throw new SupervisorError('invalid team.local.json: github_app needs app_id, installation_id and an absolute key_file');
  return { ...shipped, github_app: local.github_app };
}

export function assertGithubApp(config) {
  if ('github_app' in config && !validGithubApp(config.github_app)) throw new SupervisorError('invalid team config: github_app needs app_id, installation_id and an absolute key_file');
}
