// Issue #1161: foreman_stop_record reads the stop record a latch or pause reason names, and nothing else. Fixtures are built at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createToolset } from '../foreman-mcp/toolset.mjs';
import { namedPaths, insideAllowed, stopDirsFrom, STOP_MAX_CHARS } from '../foreman-mcp/stoprecord.mjs';

const tmp = t => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'stoprec-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return fs.realpathSync(d); };
const toolsFor = ({ dirs, latchReason = null, attention = [], installsFail = false }) => createToolset({
  source: { get: async () => ({ view: { attention }, ageMs: 0 }) },
  getPath: async p => { if (installsFail) throw new Error('down'); assert.equal(p, '/api/installs.json'); return { latch: latchReason ? { reason: latchReason } : null }; },
  readHost: () => ({}), stopDirs: dirs,
});
const run = async tools => JSON.parse((await tools.call('foreman_stop_record', {})).text);

test('returns the named record, redacted, with path and modified time', async t => {
  const dir = tmp(t), file = path.join(dir, 'foreman-stop.md');
  const secret = 'ghp_' + crypto.randomBytes(15).toString('hex');
  fs.writeFileSync(file, `# S1 stop\nCovers storage work.\nResume when X.\ntoken ${secret}\n`);
  const out = await run(toolsFor({ dirs: [dir], latchReason: `homeowner pause, see ${file}` }));
  assert.equal(out.stop, true);
  const [r] = out.records;
  assert.equal(r.path, file);
  assert.equal(r.source, 'upgrade latch');
  assert.match(r.text, /Resume when X/);
  assert.ok(!r.text.includes(secret));
  assert.ok(Number.isFinite(Date.parse(r.modified)));
  assert.equal(r.truncated, false);
});
test('the tool is listed read-only', t => {
  const l = toolsFor({ dirs: [tmp(t)] }).list().find(d => d.name === 'foreman_stop_record');
  assert.equal(l.annotations.readOnlyHint, true);
});
test('refuses a path outside the allowed directory, and never reads it', async t => {
  const allowed = tmp(t), other = tmp(t), file = path.join(other, 'secret.md');
  fs.writeFileSync(file, 'must not be shown');
  const out = await run(toolsFor({ dirs: [allowed], latchReason: `see ${file}` }));
  assert.match(out.records[0].refused, /not in the allowed/);
  assert.ok(!JSON.stringify(out).includes('must not be shown'));
});
test('refuses ../ traversal, a subdirectory, a symlink file and a symlinked directory', async t => {
  const allowed = tmp(t), other = tmp(t);
  fs.writeFileSync(path.join(other, 'x.md'), 'outside');
  fs.mkdirSync(path.join(allowed, 'sub')); fs.writeFileSync(path.join(allowed, 'sub', 'y.md'), 'nested');
  fs.symlinkSync(path.join(other, 'x.md'), path.join(allowed, 'link.md'));
  fs.symlinkSync(other, path.join(allowed, 'dirlink'));
  const reason = [`${allowed}/../${path.basename(other)}/x.md`, `${allowed}/sub/y.md`, `${allowed}/link.md`, `${allowed}/dirlink/x.md`].join(' ');
  const out = await run(toolsFor({ dirs: [allowed], latchReason: reason }));
  assert.equal(out.records.length, 4);
  for (const r of out.records) { assert.ok(r.refused, JSON.stringify(r)); assert.equal(r.text, undefined); }
  assert.ok(!JSON.stringify(out).includes('outside') || !out.records.some(r => r.text));
});
test('reports no stop when no latch or pause reason is set', async t => {
  const out = await run(toolsFor({ dirs: [tmp(t)], attention: [{ id: 'h-8', text: '#8 needs you' }] }));
  assert.equal(out.stop, false);
  assert.match(out.note, /no homeowner stop/i);
});
test('an automatic rollback latch is shown but is not a homeowner stop', async t => {
  const out = await run(toolsFor({ dirs: [tmp(t)], latchReason: 'rolled back: tests failed' }));
  assert.equal(out.stop, false);
  assert.match(out.note, /No homeowner stop/);
  assert.match(out.automaticHolds[0].text, /tests failed/);
});
test('the routine open-PR cap item (paused-new-work) is no homeowner stop', async t => {
  const out = await run(toolsFor({ dirs: [tmp(t)], attention: [{ id: 'paused-new-work', text: 'Paused new work: 5 open PRs (cap 5)' }] }));
  assert.equal(out.stop, false);
  assert.match(out.note, /No homeowner stop/);
});
test('a pause Needs you item can name the record', async t => {
  const dir = tmp(t), file = path.join(dir, 'p.md'); fs.writeFileSync(file, 'paused for S1');
  const out = await run(toolsFor({ dirs: [dir], attention: [{ id: 'homeowner-pause', text: `Foreman is paused: ${file}` }] }));
  assert.equal(out.records[0].text, 'paused for S1');
});
test('a long record is cut and says so; a missing file and an unavailable source are reported', async t => {
  const dir = tmp(t), file = path.join(dir, 'big.md'); fs.writeFileSync(file, 'a'.repeat(STOP_MAX_CHARS + 500));
  const out = await run(toolsFor({ dirs: [dir], latchReason: `${file} ${dir}/gone.md` }));
  assert.equal(out.records[0].text.length, STOP_MAX_CHARS);
  assert.equal(out.records[0].truncated, true);
  assert.match(out.records[1].refused, /does not exist/);
  const down = await run(toolsFor({ dirs: [dir], installsFail: true }));
  assert.deepEqual(down.unavailable, ['install history']);
});
test('pure helpers', () => {
  assert.deepEqual(namedPaths([{ source: 'a', text: 'x /a/b.md and /a/b.md /c/d.txt.' }]).map(n => n.file), ['/a/b.md', '/c/d.txt']);
  assert.equal(insideAllowed('/a/b/../c.md', ['/a']), true);
  assert.equal(insideAllowed('/a/b/c.md', ['/a']), false);
});
test('allowed directories: environment, then the configuration file, then the default', t => {
  const cfg = path.join(tmp(t), 'c.json'); fs.writeFileSync(cfg, JSON.stringify({ stopDirs: ['/x/y'] }));
  assert.deepEqual(stopDirsFrom({ FOREMAN_MCP_STOP_DIRS: '/a:/b', FOREMAN_MCP_CONFIG: cfg }), ['/a', '/b']);
  assert.deepEqual(stopDirsFrom({ FOREMAN_MCP_CONFIG: cfg }), ['/x/y']);
  assert.deepEqual(stopDirsFrom({}), ['/mnt/cache/logs/agent-cleanup']);
});

test('the real stdio server answers foreman_stop_record against a stub dashboard', async t => {
  const dir = tmp(t), file = path.join(dir, 'foreman-stop.md');
  fs.writeFileSync(file, '# S1 stop\nResume when X.\n');
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const stub = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.startsWith('/api/installs') ? { latch: { reason: `paused, see ${file}` } } : { view: { attention: [] } }));
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  t.after(() => stub.close());
  const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'foreman-mcp', 'server.mjs');
  const child = spawn(process.execPath, [server], { env: { PATH: process.env.PATH, FOREMAN_MCP_VIEW_URL: `http://127.0.0.1:${stub.address().port}/api/view.json`, FOREMAN_MCP_STOP_DIRS: dir } });
  t.after(() => child.kill());
  const answer = new Promise(resolve => { let buf = ''; child.stdout.on('data', d => { buf += d; const l = buf.split('\n').find(x => x.includes('"id":7')); if (l) resolve(JSON.parse(l)); }); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'foreman_stop_record', arguments: {} } }) + '\n');
  const out = JSON.parse((await answer).result.content[0].text);
  assert.equal(out.stop, true);
  assert.match(out.records[0].text, /Resume when X/);
});

test('a relative doc path or a URL in a hold reason is not a stop record', () => {
  const text = 'rolled back (see docs/DECISIONS.md and https://github.com/x/y/blob/main/cooperative-work.md)';
  assert.deepEqual(namedPaths([{ source: 'a', text }]), []);
  assert.deepEqual(namedPaths([{ source: 'a', text: 'paused: "/mnt/cache/logs/agent-cleanup/foreman-stop.md"' }]).map(n => n.file), ['/mnt/cache/logs/agent-cleanup/foreman-stop.md']);
});
