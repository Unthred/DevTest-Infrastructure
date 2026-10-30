import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dotnetRunSpec } from '../dotnet/run.mjs';

test('dotnet runner adapter selects the pinned SDK image, phase and isolated cache', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-dotnet-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'App.csproj');
  fs.writeFileSync(project, '<Project />');
  const feed = path.join(root, 'feed');
  fs.mkdirSync(feed);
  for (const sdk of ['8', '9', '10']) {
    const { spec, command } = dotnetRunSpec({ sdk, operation: 'restore', projectRoot: root, project, packageSource: feed, runId: 'abcdef0123456789' });
    assert.equal(spec.image, `dotnet-${sdk}`);
    assert.equal(spec.phase, 'restore');
    assert.equal(spec.cacheName, `nuget-sdk-${sdk}`);
    assert.equal(spec.project, root);
    assert.equal(spec.command[0], 'dotnet');
    assert.equal(command.sdk, sdk);
    assert.ok(spec.command.includes('/src/feed'));
  }
  assert.throws(() => dotnetRunSpec({ sdk: '8', operation: 'build', projectRoot: root, project }), /runId/);
});
