// Issue #1239: the config validation and loading code moved from team.mjs to teamconfig.mjs. team.mjs still exports every name
// it exported before, a moved name is the same function reference, and loading the shipped team.json gives identical results.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as team from '../supervisor/team.mjs';
import * as teamconfig from '../supervisor/teamconfig.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const shipped = path.join(here, '..', 'supervisor', 'team.json');
// The names team.mjs exported on main before the split (commit f9ca6c1e) that now live in teamconfig.mjs.
const MOVED = ['validateTeamConfig', 'expectedFiles', 'capNotes', 'normalizeReviewConfig', 'globToRegExp', 'applyLocalOverride',
  'loadTeamConfig', 'ROLES', 'OVERALL_ROLES', 'roleCount', 'DEFAULT_REBASERS', 'UNBLOCK_DEFAULTS', 'HEALTH_DEFAULTS', 'LOCAL_OVERRIDE', 'weeklyAtOf'];

test('every moved name is still exported from team.mjs with the identity it has in teamconfig.mjs', () => {
  for (const name of MOVED) {
    assert.ok(name in teamconfig, `${name} is exported by teamconfig.mjs`);
    assert.ok(name in team, `${name} is still exported by team.mjs`);
    assert.strictEqual(team[name], teamconfig[name], `${name} is the same reference`);
  }
});

test('names that stayed in team.mjs are not duplicated in teamconfig.mjs', () => {
  for (const name of ['overallCap', 'touchesPaths', 'roleOfType', 'Team', 'decisionApproved']) {
    assert.ok(name in team, name);
    assert.ok(!(name in teamconfig), `${name} stays in team.mjs`);
  }
});

test('loading the shipped team.json and a local override gives the same result through both import paths', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'teamconfig-'));
  try {
    const none = team.loadTeamConfig(shipped, root);
    assert.deepEqual(teamconfig.loadTeamConfig(shipped, root), none);
    fs.writeFileSync(path.join(root, 'team.local.json'), JSON.stringify({ enabled: true, limits: { max_open_prs: 7, roles: { implementer: 2 } } }));
    const withLocal = team.loadTeamConfig(shipped, root);
    assert.deepEqual(teamconfig.loadTeamConfig(shipped, root), withLocal);
    assert.equal(withLocal.limits.max_open_prs, 7);
    assert.equal(withLocal.enabled, true);
    fs.writeFileSync(path.join(root, 'team.local.json'), JSON.stringify({ repository: 'x/y' }));
    for (const load of [team.loadTeamConfig, teamconfig.loadTeamConfig]) assert.throws(() => load(shipped, root), /key not overridable: repository/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
