import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOT_FILES } from '../supervisor/team.mjs';

test('#1194: package.json is a known root file for review claims', () => {
  assert.ok(ROOT_FILES.has('package.json'));
});
