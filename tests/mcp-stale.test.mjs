// Issue #1314: the MCP server says when it runs older code than is installed, and a proposal reply shows what was stored. These tests start the
// real server process over a temporary copy of the server folder and talk to it over stdio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fingerprintOf, createSelfCheck, markStale, STALE_TEXT } from '../foreman-mcp/selfcheck.mjs';

const mcpDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'foreman-mcp');
const FIRST = 'Live board balls travel from hopper to lane and bounce down the pegs into their box Boardmotion';
const SECOND = 'Live board drawing styles behind one switch with the peg board as the first style Boardstyles';

function viewServer(t) {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: { installed: 'aaaaaaa', mcp: { installed: 'aaaaaaa' } } })); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => { t.after(() => server.close()); resolve(`http://127.0.0.1:${server.address().port}/api/view.json`); }));
}

// Copies the server folder, starts it, and returns a small client.
async function start(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = path.join(root, 'srv'), inbox = path.join(root, 'inbox');
  fs.cpSync(mcpDir, server, { recursive: true, preserveTimestamps: true });
  fs.mkdirSync(path.join(inbox, 'items'), { recursive: true });
  fs.mkdirSync(path.join(inbox, 'status'));
  const child = spawn(process.execPath, [path.join(server, 'server.mjs')], { env: { PATH: process.env.PATH, FOREMAN_MCP_VIEW_URL: await viewServer(t), FOREMAN_MCP_INBOX: inbox, FOREMAN_MCP_LOG: path.join(root, 'calls.log') }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const waiting = new Map();
  let buffer = '', next = 1;
  child.stdout.on('data', d => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) { const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); waiting.get(m.id)?.(m); }
  });
  const rpc = (method, params) => new Promise(resolve => { const id = next++; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return { isError: r.result.isError, body: JSON.parse(r.result.content[0].text), raw: r.result.content[0].text }; };
  await rpc('ping');   // the server has started, and so has taken its fingerprint, once it answers
  return { server, inbox, rpc, call, items: () => fs.readdirSync(path.join(inbox, 'items')) };
}

test('fresh server: version carries the start time, status says stale false, a read tool has no staleServer line', async t => {
  const s = await start(t);
  const init = await s.rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.match(init.result.serverInfo.version, /^0\.1\.0\+\d{8}T\d{9}Z$/);
  const status = await s.call('foreman_status');
  assert.equal(status.body.version.mcp.stale, false);
  assert.match(status.body.version.mcp.startedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(status.body.version.mcp.installed, 'aaaaaaa', 'the existing entry is kept');
  assert.equal(status.body.staleServer, undefined);
  const read = await s.call('foreman_inbox');
  assert.equal(read.isError, false);
  assert.ok(!read.raw.includes('staleServer'));
});

test('a changed file makes the next reply carry staleServer and still answer; changed back to the same size and time is not stale; a new file is stale', async t => {
  const s = await start(t);
  const file = path.join(s.server, 'gbp.mjs'), original = fs.readFileSync(file), before = fs.statSync(file);
  fs.appendFileSync(file, '// changed\n');
  const read = await s.call('foreman_inbox');
  assert.equal(read.isError, false);
  assert.equal(read.body.staleServer, STALE_TEXT);
  assert.equal(Object.keys(read.body)[0], 'staleServer', 'the line is at the top');
  assert.equal((await s.call('foreman_status')).body.version.mcp.stale, true);
  fs.writeFileSync(file, original);
  fs.utimesSync(file, before.atime, before.mtime);
  const back = await s.call('foreman_status');
  assert.equal(back.body.version.mcp.stale, false, 'same size and time');
  assert.equal(back.body.staleServer, undefined);
  fs.writeFileSync(path.join(s.server, 'added.mjs'), '// new\n');
  assert.equal((await s.call('foreman_status')).body.version.mcp.stale, true, 'a new file');
});

test('while stale a proposal and a control tool are refused with the restart text and nothing is written', async t => {
  const s = await start(t);
  fs.appendFileSync(path.join(s.server, 'gbp.mjs'), '// changed\n');
  const proposal = await s.call('foreman_propose', { kind: 'issue_draft', title: FIRST, body: 'body' });
  assert.equal(proposal.isError, true);
  assert.equal(proposal.body.error, STALE_TEXT);
  for (const [name, args] of [['foreman_park', { number: 5, reason: 'r' }], ['foreman_unpark', { number: 5, reason: 'r' }], ['foreman_stop_job', { id: 'abcdef12', reason: 'r' }], ['foreman_release_agent', { agent: 'codex', reason: 'r' }]]) {
    const r = await s.call(name, args);
    assert.equal(r.isError, true, name);
    assert.equal(r.body.error, STALE_TEXT, name);
  }
  assert.deepEqual(s.items(), [], 'the items folder has no new file');
});

test('a server folder that becomes unreadable gives stale true, not a crash', async t => {
  const s = await start(t);
  fs.renameSync(s.server, `${s.server}-moved`);
  const status = await s.call('foreman_status');
  assert.equal(status.body.version.mcp.stale, true);
  assert.equal((await s.call('foreman_inbox')).body.staleServer, STALE_TEXT);
});

test('a proposal reply names the stored optional fields and, with after, waitsFor the first title', async t => {
  const s = await start(t);
  const first = await s.call('foreman_propose', { kind: 'issue_draft', title: FIRST, body: 'Body of the first draft.' });
  assert.equal(first.isError, false);
  assert.deepEqual(first.body.stored, []);
  assert.equal(first.body.waitsFor, undefined);
  const chained = await s.call('foreman_propose', { kind: 'issue_draft', title: SECOND, body: 'Body of the second draft.', why: 'builds on the first', after: [first.body.shortId] });
  assert.deepEqual(chained.body.stored, ['why', 'after']);
  assert.equal(chained.body.waitsFor.length, 1);
  assert.ok(chained.body.waitsFor[0].startsWith(FIRST), chained.body.waitsFor[0]);
  const plain = await s.call('foreman_propose', { kind: 'issue_draft', title: SECOND, body: 'Body of the second draft.' });
  assert.ok(!plain.body.stored.includes('after'));
  assert.equal(plain.body.waitsFor, undefined);
  const prompt = await s.call('foreman_propose', { kind: 'prompt', title: 'read only', prompt: 'look', effect: 'read_only' });
  assert.deepEqual(prompt.body.stored, ['effect']);
});

test('fingerprint: only module files count, order does not matter; a null reading is stale; a non-JSON reply gets the line first', () => {
  const a = { name: 'a.mjs', size: 1, mtimeMs: 5 }, b = { name: 'b.mjs', size: 2, mtimeMs: 6 };
  assert.equal(fingerprintOf([a, b]), fingerprintOf([b, a]));
  assert.equal(fingerprintOf([a, { name: 'notes.txt', size: 9, mtimeMs: 1 }]), fingerprintOf([a]));
  assert.notEqual(fingerprintOf([a]), fingerprintOf([{ ...a, size: 2 }]));
  const readings = ['x', 'x', null, 'y'];
  const check = createSelfCheck({ dir: '/nowhere', now: () => 0, take: () => readings.shift() });
  assert.equal(check.startedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(check.stale(), false);
  assert.equal(check.stale(), true, 'unreadable');
  assert.equal(check.stale(), true, 'different');
  assert.equal(markStale('plain text'), `staleServer: ${STALE_TEXT}\nplain text`);
});
