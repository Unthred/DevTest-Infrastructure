// Issue #946: the Foreman MCP server is installed and updated with the self-upgrade.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SelfUpgrade, rangeNeedsInstall } from '../supervisor/upgrade.mjs';
import { mcpNeedsInstall, readMcpInstall } from '../supervisor/mcpinstall.mjs';
import { readVersion } from '../supervisor/dashdata.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SH = '1'.repeat(40), SH2 = '2'.repeat(40);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-install-'));
const install = (src, commit, state) => {
  const r = spawnSync('bash', [path.join(REPO, 'tools/install-foreman-mcp.sh'), src, commit], { encoding: 'utf8', env: { PATH: process.env.PATH, AI_SUPERVISOR_STATE_DIR: state } });
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()) : null, err: r.stderr };
};
// A source tree with a foreman-mcp/ directory, a state directory, and a hand-installed copy beside launcher.env.
function world({ configured = true, installed = true } = {}) {
  const dir = tmp(), state = path.join(dir, 'state'), inst = path.join(dir, 'inst'), src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'foreman-mcp'), { recursive: true }); fs.mkdirSync(state); fs.mkdirSync(inst);
  fs.writeFileSync(path.join(src, 'foreman-mcp/server.mjs'), 'export const v = 2;\n');
  fs.writeFileSync(path.join(src, 'foreman-mcp/launcher.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (configured) fs.writeFileSync(path.join(state, 'foreman-mcp.install'), `INSTALL_DIR=${inst}\n`);
  if (installed) {
    fs.mkdirSync(path.join(inst, 'foreman-mcp'));
    fs.writeFileSync(path.join(inst, 'foreman-mcp/server.mjs'), 'export const v = 1;\n');
    fs.writeFileSync(path.join(inst, 'foreman-mcp/launcher.env'), 'NODE_BIN=/x\n', { mode: 0o640 });
    fs.writeFileSync(path.join(inst, 'VERSION'), SH + '\n');
  }
  return { dir, state, inst, src };
}

test('install: updates the copy, keeps launcher.env, sets modes, records VERSION and the result', () => {
  const w = world();
  const r = install(w.src, SH2, w.state);
  assert.equal(r.status, 0, r.err); assert.equal(r.out.result, 'installed');
  assert.equal(fs.readFileSync(path.join(w.inst, 'foreman-mcp/server.mjs'), 'utf8'), 'export const v = 2;\n');
  assert.equal(fs.readFileSync(path.join(w.inst, 'foreman-mcp/launcher.env'), 'utf8'), 'NODE_BIN=/x\n', 'local configuration is carried over');
  assert.equal(fs.statSync(path.join(w.inst, 'foreman-mcp/launcher.env')).mode & 0o777, 0o640);
  assert.equal(fs.statSync(path.join(w.inst, 'foreman-mcp/server.mjs')).mode & 0o777, 0o644, 'read-only for the account');
  assert.equal(fs.statSync(path.join(w.inst, 'foreman-mcp/launcher.sh')).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(w.inst, 'VERSION'), 'utf8').trim(), SH2);
  assert.deepEqual(fs.readdirSync(w.inst).sort(), ['VERSION', 'foreman-mcp'], 'no staging directories left behind');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, 'team/mcp-install.json'), 'utf8')).result, 'installed');
  const again = install(w.src, SH2, w.state);
  assert.equal(again.out.result, 'unchanged', 'a second run changes nothing');
});

test('install: a commit that does not touch foreman-mcp/ still moves VERSION so the drift flag clears', () => {
  const w = world();
  install(w.src, SH2, w.state);
  const r = install(w.src, '3'.repeat(40), w.state);
  assert.equal(r.out.result, 'unchanged');
  assert.equal(fs.readFileSync(path.join(w.inst, 'VERSION'), 'utf8').trim(), '3'.repeat(40));
});

test('install: a failing copy keeps the previous one working and reports failure', () => {
  const w = world();
  fs.writeFileSync(path.join(w.src, 'foreman-mcp/server.mjs'), 'export const = ;\n');   // does not parse
  const r = install(w.src, SH2, w.state);
  assert.equal(r.status, 1); assert.equal(r.out.result, 'failed'); assert.match(r.out.reason, /parse/);
  assert.equal(fs.readFileSync(path.join(w.inst, 'foreman-mcp/server.mjs'), 'utf8'), 'export const v = 1;\n', 'previous copy untouched');
  assert.equal(fs.readFileSync(path.join(w.inst, 'VERSION'), 'utf8').trim(), SH, 'VERSION still names the copy that is there');
  assert.deepEqual(fs.readdirSync(w.inst).sort(), ['VERSION', 'foreman-mcp']);
});

test('install: skipped without a configuration file or without a hand-installed copy; bad install dir fails', () => {
  const nc = world({ configured: false }); assert.equal(install(nc.src, SH2, nc.state).out.result, 'skipped');
  const w = world({ installed: false });
  assert.equal(install(w.src, SH2, w.state).out.result, 'skipped');
  assert.equal(fs.existsSync(path.join(w.inst, 'foreman-mcp')), false, 'nothing is created');
  const b = world(); fs.writeFileSync(path.join(b.state, 'foreman-mcp.install'), 'INSTALL_DIR=relative/path\n');
  assert.equal(install(b.src, SH2, b.state).status, 1);
  assert.equal(spawnSync('bash', [path.join(REPO, 'tools/install-foreman-mcp.sh'), b.src, 'nothex'], { encoding: 'utf8' }).status, 2);
});

test('readers: installed commit, drift against Foreman, last result', () => {
  const w = world();
  assert.deepEqual(readMcpInstall(w.state, SH), { installed: SH, drift: false, last: null });
  assert.equal(readMcpInstall(w.state, SH2).drift, true);
  install(w.src, SH2, w.state);
  assert.equal(readMcpInstall(w.state, SH2).drift, false); assert.equal(readMcpInstall(w.state, SH2).last.result, 'installed');
  assert.equal(readMcpInstall(world({ configured: false }).state, SH), null, 'not configured: nothing shown');
});

test('System page data: readVersion carries the MCP commit and flags drift', () => {
  const w = world();
  fs.mkdirSync(path.join(w.state, 'versions', SH), { recursive: true }); fs.symlinkSync(`versions/${SH}`, path.join(w.state, 'current'));
  assert.equal(readVersion(w.state, { running: null }).mcp.drift, false);
  fs.writeFileSync(path.join(w.inst, 'VERSION'), SH2 + '\n');
  assert.deepEqual(readVersion(w.state, { running: null }).mcp.installed, SH2);
  assert.equal(readVersion(w.state, { running: null }).mcp.drift, true);
  const none = world({ configured: false }); fs.mkdirSync(path.join(none.state, 'versions', SH), { recursive: true }); fs.symlinkSync(`versions/${SH}`, path.join(none.state, 'current'));
  assert.equal('mcp' in readVersion(none.state, { running: null }), false);
});

function upgrader(result, alerts) {
  const u = Object.create(SelfUpgrade.prototype);
  Object.assign(u, { s: {}, clock: { now: () => 5 }, d: { mcpResult: async () => result }, save() {}, record(r) { (this.recs ||= []).push(r); }, alert: async (k, m) => { alerts.push([k, m]); } });
  return u;
}
test('self-upgrade: a failed MCP install alerts once with the reason and is recorded; success and no-news stay quiet', async () => {
  let alerts = [];
  let u = upgrader({ sha: SH2, result: 'failed', reason: 'copy failed' }, alerts);
  await u.noteMcp(SH, SH2, ['foreman-mcp/tools.mjs']);
  assert.equal(alerts.length, 1); assert.match(alerts[0][1], /not updated/); assert.match(alerts[0][1], /copy failed/);
  assert.equal(u.recs[0].result, 'mcp_install_failed');
  u = upgrader(null, alerts = []);
  await u.noteMcp(SH, SH2, ['foreman-mcp/tools.mjs']);
  assert.equal(alerts.length, 1, 'a changed foreman-mcp/ with no installer result is a failure');
  u = upgrader(null, alerts = []); await u.noteMcp(SH, SH2, ['supervisor/team.mjs']);
  assert.equal(alerts.length, 0); assert.equal(u.recs, undefined);
  u = upgrader({ sha: SH2, result: 'installed', reason: 'ok' }, alerts = []); await u.noteMcp(SH, SH2, ['foreman-mcp/tools.mjs']);
  assert.equal(alerts.length, 0); assert.equal(u.recs[0].result, 'mcp_install');
});

test('plan: every foreman-mcp/ file needs an install and is covered by the MCP step', () => {
  const files = fs.readdirSync(path.join(REPO, 'foreman-mcp')).map(f => `foreman-mcp/${f}`);
  assert.ok(files.length > 5);
  for (const f of files) { assert.equal(rangeNeedsInstall([f]), true, `${f} must not be on the no-install list`); assert.equal(mcpNeedsInstall([f]), true, f); }
  assert.equal(mcpNeedsInstall(['docs/foreman-mcp.md', 'supervisor/team.mjs']), false);
  const up = fs.readFileSync(path.join(REPO, 'tools/upgrade-supervisor.sh'), 'utf8'), rb = fs.readFileSync(path.join(REPO, 'tools/rollback-supervisor.sh'), 'utf8');
  assert.match(up, /install-foreman-mcp\.sh/, 'the upgrade script must run the MCP installer'); assert.match(rb, /install-foreman-mcp\.sh/, 'the rollback must restore the MCP copy');
});

test('plan: a change under foreman-mcp/ on this branch is in the upgrade plan', () => {
  const g = args => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
  const base = ['origin/main', 'main'].map(b => g(['merge-base', 'HEAD', b])).find(r => r.status === 0)?.stdout.trim();
  if (!base) return;
  const changed = g(['diff', '--name-only', base, 'HEAD']).stdout.split('\n').filter(f => f.startsWith('foreman-mcp/'));
  if (changed.length) { assert.equal(rangeNeedsInstall(changed), true); assert.equal(mcpNeedsInstall(changed), true); }
});
