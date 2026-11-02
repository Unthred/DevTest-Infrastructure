#!/usr/bin/env node
// CI lint (issue #12): shell syntax, workflow safety and the image lock (pinning, freshness, version agreement).
// Needs no Docker, no network and no secrets, so it runs on a hosted runner. Docker-dependent smokes run on Tower only (docs/ci-and-images.md).
// Usage: node tools/ci/check-ci.mjs [root] [--max-age-days N] [--now ISO-date]    Exit 0 = clean, 1 = findings, 2 = usage.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Freshness is opt-in (--max-age-days): a PR gate that fails because the calendar moved is not reproducible. The scheduled workflow passes it.
export const RECOMMENDED_MAX_AGE_DAYS = 45;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const DIGEST = /^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$/;
// Actions are pinned to a full commit SHA, or to a major tag of GitHub's own `actions/` namespace (documented exception).
const ACTION_SHA = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const ACTION_OFFICIAL_MAJOR = /^actions\/[\w.-]+(?:\/[\w./-]+)?@v\d+$/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}

export function checkShell(root, add) {
  for (const file of walk(root)) {
    const name = path.relative(root, file).split(path.sep).join('/');
    const head = fs.readFileSync(file, 'utf8').slice(0, 200);
    const isSh = file.endsWith('.sh') || /^#!\s*\/(?:usr\/)?bin\/(?:env\s+)?(?:ba)?sh\b/.test(head);
    if (!isSh) continue;
    const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    if (r.error) add('shell', `${name}: bash unavailable (${r.error.code})`);
    else if (r.status !== 0) add('shell', `${name}: syntax error: ${(r.stderr || '').trim().split('\n')[0].slice(0, 160)}`);
    if (!/^#!/.test(head)) add('shell', `${name}: missing shebang`);
  }
}

export function checkWorkflows(root, add) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return add('workflows', 'no .github/workflows directory');
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  if (!files.length) add('workflows', 'no workflow files');
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const lines = text.split('\n');
    const at = (i) => `.github/workflows/${f}:${i + 1}`;
    if (!/^permissions:/m.test(text)) add('workflows', `${f}: no top-level "permissions:" (default token scope is too wide)`);
    if (/^\s*permissions:\s*write-all\b/m.test(text) || /^\s+(?:contents|packages|id-token):\s*write\b/m.test(text)) add('workflows', `${f}: write permission in a CI workflow`);
    if (/\bpull_request_target\b/.test(text)) add('workflows', `${f}: pull_request_target runs untrusted code with secrets`);
    if (/\bruns-on:\s*\[?\s*self-hosted\b/.test(text)) add('workflows', `${f}: self-hosted runner (Tower stays out of hosted CI; D-007)`);
    if (!/^\s*timeout-minutes:/m.test(text)) add('workflows', `${f}: jobs need timeout-minutes`);
    lines.forEach((line, i) => {
      const code = line.replace(/#.*$/, '');
      const use = code.match(/^\s*-?\s*uses:\s*["']?([^\s"']+)/);
      if (use) {
        const ref = use[1];
        if (!ref.startsWith('./') && !ACTION_SHA.test(ref) && !ACTION_OFFICIAL_MAJOR.test(ref)) add('workflows', `${at(i)}: action "${ref}" is not pinned to a commit SHA (only official actions/* major tags are allowed)`);
      }
      if (/\bdocker\s+(?:run|compose|build)\b/.test(code)) add('workflows', `${at(i)}: Docker in hosted CI; Docker-dependent smokes run on Tower only (OQ-3)`);
      if (/\$\{\{\s*secrets\./.test(code)) add('workflows', `${at(i)}: secret referenced in a CI workflow`);
    });
  }
}

export function checkImageLock(root, add, { maxAgeDays = null, now = new Date() } = {}) {
  const file = path.join(root, 'docker', 'images.lock.json');
  if (!fs.existsSync(file)) return add('image-lock', 'docker/images.lock.json missing');
  let lock;
  try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return add('image-lock', `not valid JSON: ${e.message}`); }
  const dateOk = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  if (lock.schema_version !== 1) add('image-lock', 'schema_version must be 1');
  if (!dateOk(lock.observed_on)) add('image-lock', 'observed_on must be YYYY-MM-DD');
  const images = lock.images && typeof lock.images === 'object' ? lock.images : {};
  if (!Object.keys(images).length) add('image-lock', 'no images recorded');
  const digests = new Set();
  for (const [id, img] of Object.entries(images)) {
    if (!img || typeof img.tag !== 'string' || typeof img.reference !== 'string') { add('image-lock', `${id}: tag and reference are required`); continue; }
    if (!DIGEST.test(img.reference)) add('image-lock', `${id}: reference is not a registry path pinned by a 64-hex sha256 digest`);
    if (/:latest$/.test(img.tag) || !/:[^:@/]+$/.test(img.tag)) add('image-lock', `${id}: tag "${img.tag}" must carry an explicit non-latest tag`);
    const repo = (s) => s.replace(/[:@].*$/, '');
    if (DIGEST.test(img.reference) && repo(img.tag) !== repo(img.reference)) add('image-lock', `${id}: reference repository differs from tag repository`);
    if (!/^(?:mcr\.microsoft\.com)\//.test(img.reference)) add('image-lock', `${id}: not an allow-listed official registry (D-004)`);
    if (digests.has(img.reference)) add('image-lock', `${id}: duplicate reference`);
    digests.add(img.reference);
    const when = img.resolved_on || lock.observed_on;
    if (!dateOk(when)) continue;
    const age = (now - Date.parse(when)) / 86400000;
    if (age < 0) add('image-lock', `${id}: resolved date ${when} is in the future`);
    else if (maxAgeDays !== null && age > maxAgeDays) add('image-lock', `${id}: resolved ${Math.floor(age)} days ago, over the ${maxAgeDays}-day update cadence; re-resolve and record the digest`);
  }
  // Playwright package must agree with the pinned Playwright image tag.
  const pw = images.playwright, pkg = lock.packages?.['playwright-core'];
  if (pw && pkg) {
    const v = (pw.tag.match(/:v(\d+\.\d+\.\d+)/) || [])[1];
    if (!v) add('image-lock', 'playwright tag has no vX.Y.Z version');
    else if (v !== pkg.version) add('image-lock', `playwright-core ${pkg.version} does not match image tag version ${v}`);
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(pkg.integrity || '')) add('image-lock', 'playwright-core integrity must be an sha512 SRI value');
  } else if (pw || pkg) add('image-lock', 'playwright image and playwright-core package must both be recorded');
  // Every digest referenced elsewhere must be in the lock (no drift between code and lock).
  for (const f of walk(root)) {
    const name = path.relative(root, f).split(path.sep).join('/');
    if (name === 'docker/images.lock.json' || name.startsWith('tests/') || name.startsWith('docs/') || !/\.(?:mjs|json|ya?ml|sh)$/.test(f)) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/mcr\.microsoft\.com\/[\w./-]+@sha256:[0-9a-f]{64}/g)) {
      if (!digests.has(m[0])) add('image-lock', `${name}: image ${m[0].slice(0, 60)}… is not in docker/images.lock.json`);
    }
  }
}

export function checkCi(root, opts = {}) {
  const findings = [];
  const add = (check, message) => findings.push({ check, message });
  checkShell(root, add); checkWorkflows(root, add); checkImageLock(root, add, opts);
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts = {}; let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-age-days') { opts.maxAgeDays = Number(args[++i]); if (!(opts.maxAgeDays > 0)) { console.error('check-ci: --max-age-days needs a positive number'); process.exit(2); } }
    else if (args[i] === '--now') { opts.now = new Date(args[++i]); if (Number.isNaN(+opts.now)) { console.error('check-ci: --now needs a date'); process.exit(2); } }
    else if (args[i].startsWith('--')) { console.error(`check-ci: unknown option ${args[i]}`); process.exit(2); }
    else root = path.resolve(args[i]);
  }
  if (!fs.existsSync(root)) { console.error(`check-ci: no such directory: ${root}`); process.exit(2); }
  const findings = checkCi(root, opts);
  for (const f of findings) console.error(`FAIL [${f.check}] ${f.message}`);
  if (findings.length) { console.error(`${findings.length} finding(s)`); process.exit(1); }
  console.log('check-ci: OK');
}
