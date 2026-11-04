// UI review evidence page (issue #455): listing, before/after pairs, desktop/phone grouping, and the negative cases that matter:
// path traversal, symlinks (file, folder, run and the allowlisted folder itself), disallowed file types and non-GET methods.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { listRuns, parseFilePath, readEvidenceFile, readRun, evidenceDir } from '../supervisor/evidence.mjs';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('not really a picture')]);
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] } }
};

// An evidence root with one realistic run, plus a secret file outside the allowlisted folder that no request may ever return.
function layout(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'evid-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const evidence = path.join(base, 'evidence'), run = path.join(evidence, 'ui-review', 'audit-1');
  for (const d of ['before', 'after', 'shots']) fs.mkdirSync(path.join(run, d), { recursive: true });
  const put = (rel, body = PNG) => fs.writeFileSync(path.join(run, rel), body);
  put('report.md', '# UI/UX review: <script>alert(1)</script>\n\nNo screenshots here.\n');
  put('manifest.json', JSON.stringify({ commit: 'abcdef0123456789', data_source: 'fixture', captures: [1, 2, 3] }));
  put('desktop-1440-overview.png'); put('phone-390-overview.png');
  put('before/desktop-1440-work.png'); put('after/desktop-1440-work.png'); put('before/phone-390-work.png'); put('after/phone-390-work.png'); put('before/only-before.png');
  put('shots/tablet-768-system.png');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'TOP-SECRET-OUTSIDE');
  fs.writeFileSync(path.join(evidence, 'outside.png'), PNG);
  return { base, evidence, run };
}

async function serve(t, evidenceRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evid-state-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, delivered: [], pulls: [], issues: [] }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port; server.on('request', handler({ root, config, host: '127.0.0.1', port, now: () => NOW, evidenceRoot }));
  const call = (method, p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(c), body: Buffer.concat(c).toString('utf8') })); });
    req.on('error', reject); req.end();
  });
  return { get: p => call('GET', p), call };
}

test('lists review runs with commit, data source, screenshot and pair counts, newest first', t => {
  const { evidence, run } = layout(t);
  const second = path.join(evidence, 'ui-review', 'audit-0'); fs.mkdirSync(second);
  fs.utimesSync(second, new Date(NOW - 86400000), new Date(NOW - 86400000));
  const { available, runs } = listRuns(evidence);
  assert.equal(available, true);
  assert.deepEqual(runs.map(r => r.name), ['audit-1', 'audit-0']);
  assert.deepEqual({ ...runs[0], mtime: 0 }, { name: 'audit-1', mtime: 0, screenshots: 7, pairs: 2, hasReport: true, hasManifest: true, commit: 'abcdef0123456789', source: 'fixture' });
  assert.equal(readRun(evidence, 'audit-1').name, 'audit-1');
  assert.ok(run);
});

test('a run shows its report, manifest facts, desktop/phone/tablet groups and before/after pairs matched by name', t => {
  const { evidence } = layout(t);
  const r = readRun(evidence, 'audit-1');
  assert.deepEqual(r.pairs.map(p => p.name).sort(), ['desktop-1440-work.png', 'phone-390-work.png']);
  assert.deepEqual(r.unpaired, [{ name: 'only-before.png', side: 'before' }]);
  assert.deepEqual(r.shots.map(s => s.profile).sort(), ['desktop-1440', 'phone-390', 'tablet-768']);
  assert.match(r.report, /^# UI\/UX review/);
  assert.deepEqual(r.manifest.facts.map(([k]) => k), ['commit', 'data_source']);
});

test('pages and files are served through the dashboard handler, escaped, with images allowed only on the evidence pages', async t => {
  const { evidence } = layout(t);
  const s = await serve(t, evidence);
  const list = await s.get('/evidence');
  assert.equal(list.status, 200); assert.match(list.body, /href="\/evidence\/audit-1"/); assert.match(list.body, /abcdef012345/);
  assert.match(list.headers['content-security-policy'], /img-src 'self' data:/);
  assert.match((await s.get('/')).headers['content-security-policy'], /img-src data:;/, 'other pages keep the strict policy');
  const page = await s.get('/evidence/audit-1');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.body, /<script>alert/); assert.match(page.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page.body, /Before and after \(2\)/); assert.match(page.body, /ev-sides/);
  assert.match(page.body, /<h3 class="ev-h">desktop<\/h3>/); assert.match(page.body, /<h3 class="ev-h">phone<\/h3>/);
  assert.match(page.body, /src="\/evidence\/files\/audit-1\/before\/desktop-1440-work\.png"/);
  const img = await s.get('/evidence/files/audit-1/after/phone-390-work.png');
  assert.equal(img.status, 200); assert.equal(img.headers['content-type'], 'image/png'); assert.deepEqual(img.buf, PNG); assert.equal(img.headers['x-content-type-options'], 'nosniff');
  assert.equal((await s.get('/evidence/files/audit-1/report.md')).headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal((await s.get('/evidence/files/audit-1/manifest.json')).headers['content-type'], 'application/json; charset=utf-8');
  assert.equal((await s.call('HEAD', '/evidence/files/audit-1/report.md')).status, 200);
  assert.equal((await s.get('/evidence/nope')).status, 404);
});

test('a missing evidence folder gives an empty state, not an error', async t => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'evid-none-')); t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const s = await serve(t, empty);
  const r = await s.get('/evidence'); assert.equal(r.status, 200); assert.match(r.body, /No evidence folder yet/);
  assert.equal((await s.get('/evidence/files/audit-1/report.md')).status, 404);
});

test('path traversal in any spelling is refused and never reads outside the allowlisted folder', async t => {
  const { evidence } = layout(t);
  const s = await serve(t, evidence);
  const hostile = ['/evidence/files/../../secret.txt', '/evidence/files/audit-1/../../outside.png', '/evidence/files/audit-1/%2e%2e/%2e%2e/outside.png', '/evidence/files/..%2f..%2fsecret.txt/x.png',
    '/evidence/files/audit-1/..%2f..%2f..%2fsecret.txt', '/evidence/files/audit-1/%252e%252e/x.png', '/evidence/files/audit-1/a%00.png', '/evidence/files/audit-1/shots/%2e%2e/report.md',
    '/evidence/files/audit-1\\..\\..\\secret.txt', '/evidence/files//audit-1/report.md', '/evidence/files/audit-1/shots/deeper/more/x.png', '/evidence/files/.hidden/x.png', '/evidence/files/audit-1/.png'];
  for (const p of hostile) { const r = await s.get(p); assert.equal(r.status, 404, p); assert.doesNotMatch(r.body, /TOP-SECRET/, p); }
  assert.equal(parseFilePath('audit-1/..'), null); assert.equal(parseFilePath('..'), null);
  assert.deepEqual(readEvidenceFile(evidence, { run: '..', parts: ['secret.txt'] }), { error: 'not-found' });
});

test('symlinks are never followed: file, folder, run, and the allowlisted folder itself', async t => {
  const { base, evidence, run } = layout(t);
  fs.symlinkSync(path.join(base, 'secret.txt'), path.join(run, 'linked.md'));
  fs.symlinkSync(path.join(evidence, 'outside.png'), path.join(run, 'linked.png'));
  fs.symlinkSync(base, path.join(run, 'linkdir'));
  fs.symlinkSync(run, path.join(evidence, 'ui-review', 'linkrun'));
  const s = await serve(t, evidence);
  for (const p of ['/evidence/files/audit-1/linked.md', '/evidence/files/audit-1/linked.png', '/evidence/files/audit-1/linkdir/secret.txt', '/evidence/files/linkrun/report.md', '/evidence/linkrun']) {
    const r = await s.get(p); assert.equal(r.status, 404, p); assert.doesNotMatch(r.body, /TOP-SECRET/, p);
  }
  const detail = await s.get('/evidence/audit-1');
  assert.doesNotMatch(detail.body, /linked\.(md|png)|linkdir/, 'symlinks are not even listed');
  assert.ok(!listRuns(evidence).runs.some(r => r.name === 'linkrun'));
  // The allowlisted folder itself replaced by a link to somewhere else.
  const elsewhere = path.join(base, 'elsewhere'); fs.mkdirSync(path.join(elsewhere, 'r'), { recursive: true }); fs.writeFileSync(path.join(elsewhere, 'r', 'a.png'), PNG);
  const other = path.join(base, 'ev2'); fs.mkdirSync(other); fs.symlinkSync(elsewhere, path.join(other, 'ui-review'));
  assert.equal(evidenceDir(other), null); assert.deepEqual(listRuns(other), { available: false, runs: [] });
  assert.equal((await (await serve(t, other)).get('/evidence/files/r/a.png')).status, 404);
});

test('only png, json and md are served: other types, an executable, and an oversized file are refused', async t => {
  const { evidence, run } = layout(t);
  for (const f of ['page.html', 'run.sh', 'x.svg', 'notes.txt', 'noext', 'Report.MD.exe', 'a.png.html']) fs.writeFileSync(path.join(run, f), 'x');
  fs.writeFileSync(path.join(run, 'huge.json'), Buffer.alloc(600 * 1024, 32));
  const s = await serve(t, evidence);
  for (const f of ['page.html', 'run.sh', 'x.svg', 'notes.txt', 'noext', 'Report.MD.exe', 'a.png.html']) assert.equal((await s.get(`/evidence/files/audit-1/${f}`)).status, 404, f);
  assert.equal((await s.get('/evidence/files/audit-1/huge.json')).status, 413);
  const detail = await s.get('/evidence/audit-1');
  assert.doesNotMatch(detail.body, /page\.html|run\.sh|x\.svg|notes\.txt/);
});

test('only GET and HEAD: every other method is refused with 405 and changes nothing', async t => {
  const { evidence, run } = layout(t);
  const s = await serve(t, evidence);
  const before = fs.readdirSync(run).sort().join();
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE']) for (const p of ['/evidence', '/evidence/audit-1', '/evidence/files/audit-1/report.md']) {
    const r = await s.call(method, p, { origin: `http://127.0.0.1` }); assert.equal(r.status, 405, `${method} ${p}`); assert.match(r.headers.allow, /GET, HEAD/);
  }
  assert.equal(fs.readdirSync(run).sort().join(), before);
  assert.equal((await s.call('GET', '/evidence', { host: 'evil.example:80' })).status, 421, 'the host check applies to evidence too');
});
