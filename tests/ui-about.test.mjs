// Issue #1449: the pure helpers of the About box that the browser test does not reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusLine, earlierDays, installedWords } from '../supervisor/ui/about.mjs';

test('statusLine words paused, waiting, up to date and unknown', () => {
  assert.equal(statusLine({ hold: { reason: 'tests failing' }, behind: 3 }), 'Upgrades are paused: tests failing');
  assert.equal(statusLine({ behind: 1 }), '1 change waiting to install');
  assert.equal(statusLine({ behind: 4 }), '4 changes waiting to install');
  assert.equal(statusLine({ behind: 0 }), 'Up to date');
  assert.equal(statusLine({ behind: null }), 'Whether changes are waiting is not known');
});

test('earlierDays skips the current install and groups by day, newest first', () => {
  const now = Date.parse('2026-11-14T10:00:00Z');
  const installs = [
    { current: true, at: '2026-11-14T09:18:00Z', changes: [{ text: 'now' }] },
    { at: '2026-11-13T20:00:00Z', changes: [{ text: 'a' }] },
    { at: '2026-11-13T08:00:00Z', changes: [{ text: 'b' }] },
    { at: '2026-11-12T08:00:00Z', changes: [{ text: 'c' }] },
  ];
  const days = earlierDays(installs, now);
  assert.equal(days[0].label, 'Yesterday');
  assert.equal(days[0].changes.length, 2);
  assert.equal(days.length, 2);
});

test('installedWords handles a missing time', () => {
  assert.equal(installedWords('nonsense', Date.now()), 'Install time not recorded');
});
