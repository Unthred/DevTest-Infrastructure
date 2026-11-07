import test from 'node:test';
import assert from 'node:assert/strict';
import { redactTopology } from '../supervisor/redact.mjs';
import { refusalText } from '../supervisor/upgrade.mjs';
import * as github from '../supervisor/github.mjs';

// Fixtures are assembled at run time so no literal LAN address, host or domain is stored in the public repository.
const ip = [192, 168, 7, 42].join('.');
const host = ['tower'].join('') + ':' + String(8000 + 123);
const lan = ['nas', 'lab', 'lan'].join('.');
const custom = ['ha', 'mylab', 'net'].join('.');

test('issue #584: LAN address, host:port and local domains are redacted from posted text', () => {
  const text = `measured ${ip}:8123 and ${ip}, then ${host}, ${lan}:9000, ${custom}/api`;
  const out = redactTopology(text, ['mylab.net']);
  for (const leak of [ip, 'tower', lan, 'mylab', '8123', '9000']) assert.ok(!out.includes(leak), `${leak} leaked: ${out}`);
  assert.match(out, /measured \[ip\] and \[ip\], then \[host\]/);
});

test('issue #584: ordinary findings text is untouched (files, times, public URLs, markers)', () => {
  const marker = '<!-- devtest-review v1 job=a-1 pr=5 head=abc123 -->';
  const text = `${marker}\nsee supervisor/team.mjs:1923 at 12:30, https://github.com/Unthred/x/pull/5 and /mnt/user/projects/x; version 1.2.3`;
  assert.equal(redactTopology(text, []), text);
});

test('issue #584: a Foreman marker comment is kept, any other HTML comment is redacted', () => {
  const marker = '<!-- devtest-verdict v1 job=a-1 pr=5 head=abc -->';
  assert.equal(redactTopology(`${marker} body ${host}`, []), `${marker} body [host]`);
  const out = redactTopology(`<!-- ${ip}:8123 ${host} -->`, []);
  assert.ok(!out.includes(ip) && !out.includes('tower'), out);
});

test('issue #584: refusalText keeps its stricter behaviour (comments, path after host, any host:port)', () => {
  assert.equal(refusalText(`<!-- ${host} --> x`, []), '<!-- [host] --> x');
  assert.equal(refusalText(`probe ${lan}/api failed`, []), 'probe [host] failed');
  assert.equal(refusalText('main.py:12', []), '[host]');
});

test('issue #858: refusalText stays stricter than redactTopology for host:port (intentional divergence)', () => {
  for (const [input, want] of [['tower:8123.5', '[host].5'], ['node:20', '[host]'], ['main.py:12', '[host]'], ['build.mjs:42', 'build.mjs:42']]) {
    assert.equal(refusalText(input, []), want, input);
  }
  // The shared rule keeps image tags and file names that refusalText hides.
  assert.equal(redactTopology('node:20 main.py:12', []), 'node:20 main.py:12');
  assert.equal(redactTopology('tower:8123', []), '[host]');
});

test('issue #584: every GitHub write (comment, issue create, issue body) is redacted before gh sees it', async () => {
  const calls = [];
  const gh = (args, input) => { calls.push({ args, input }); return args[0] === 'issue' && args[1] === 'create' ? 'https://github.com/o/r/issues/9\n' : ''; };
  const client = github.githubClient({ repository: 'o/r' }, gh);
  await client.comment(5, `finding: ${ip}:8123 and ${host}`);
  await client.createIssue(`about ${lan}`, `body ${ip}`);
  await client.updateIssueBody(5, `body ${host}`);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    const sent = JSON.stringify(c);
    for (const leak of [ip, 'tower', lan, '8123']) assert.ok(!sent.includes(leak), `${leak} sent to gh: ${sent}`);
  }
  assert.match(calls[0].input, /finding: \[ip\] and \[host\]/);
});

test('issue #607: image tags and versions are kept, real host:port values still redacted', () => {
  assert.equal(redactTopology('node:20 ubuntu:22.04 postgres:16-alpine nginx:1.25.3', []), 'node:20 ubuntu:22.04 postgres:16-alpine nginx:1.25.3');
  assert.equal(redactTopology(host, []), '[host]');
  assert.equal(redactTopology('redis:7000', []), '[host]');
  assert.equal(redactTopology('api.example.org:22', []), '[host]');
});

test('issue #607: a hyphen after a real host:port does not leak it', () => {
  assert.equal(redactTopology('api.example.org:8000-8100', []), '[host]-8100');
  assert.equal(redactTopology('myhost:8000-8100', []), '[host]-8100');
  assert.equal(redactTopology('myhost:8123-ha', []), '[host]-ha');
  assert.equal(redactTopology('api.example.org:8123-ha', []), '[host]-ha');
  assert.equal(redactTopology('postgres:16-alpine', []), 'postgres:16-alpine');
});

test('issue #607: recorded trade-off, a dotless host with a 2-digit port is kept (3+ digits needed), a dotted host is not', () => {
  assert.equal(redactTopology('myhost:22 myhost:80', []), 'myhost:22 myhost:80');
  assert.equal(redactTopology('api.example.org:80', []), '[host]');
});

test('issue #679: a dotted host:port is redacted even when .digit follows; a dotless host:port.version is kept', () => {
  assert.equal(redactTopology('api.example.org:8000.5', []), '[host].5');
  assert.equal(redactTopology('api.example.org:8000.', []), '[host].');
  assert.equal(redactTopology('myhost:8000.5', []), 'myhost:8000.5');
  assert.equal(redactTopology('ubuntu:22.04 redis:7000', []), 'ubuntu:22.04 [host]');
});

test('issue #772: file-name hosts stay kept when .digit follows; over-redaction of dotted version-like tokens is the recorded trade-off', () => {
  for (const s of ['node.js:20.11', 'build.mjs:42.1', 'app.mjs:120.3']) assert.equal(redactTopology(s, []), s);
  assert.equal(redactTopology('v1.2:10.5', []), '[host].5');
  assert.equal(redactTopology('a.b:12345.67', []), '[host].67');
});
