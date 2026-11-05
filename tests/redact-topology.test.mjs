import test from 'node:test';
import assert from 'node:assert/strict';
import { redactTopology } from '../supervisor/redact.mjs';
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

test('issue #584: a marker inside an HTML comment is never altered even if it looks like topology', () => {
  const marker = `<!-- note ${host} ${ip} -->`;
  assert.equal(redactTopology(`${marker} body ${host}`, []), `${marker} body [host]`);
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
