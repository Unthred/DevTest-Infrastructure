// Issue #1266: the pure parts of the web UI client: the status function, the formats, the stream client and the colour contrast.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toneOf, TONES } from '../supervisor/ui/status.mjs';
import { percent, duration, shortDuration, clock, dateTime, words } from '../supervisor/ui/format.mjs';
import { fetchModel, openStream, BEHIND_AFTER_MS } from '../supervisor/ui/client.mjs';

const groups = new Map([['running', 'active'], ['idle', 'waiting'], ['paused', 'held'], ['completed', 'done'], ['stopped', 'off'], ['stalled', 'failed'], ['stale', 'unknown']]);

test('status: attention decides first, then the group of the state, and failed counts as fault', () => {
  assert.equal(toneOf({ state: 'idle', attention: 'fault' }, groups), 'fault');
  assert.equal(toneOf({ state: 'running', attention: 'homeowner' }, groups), 'you');
  assert.equal(toneOf({ state: 'running', attention: 'unknown' }, groups), 'unknown');
  const expected = { running: 'active', idle: 'waiting', paused: 'held', completed: 'done', stopped: 'off', stalled: 'fault', stale: 'unknown' };
  for (const [state, tone] of Object.entries(expected)) assert.equal(toneOf({ state, attention: 'none' }, groups), tone, state);
});

test('status: a state the meta model does not know, or no condition, reads as unknown', () => {
  assert.equal(toneOf({ state: 'mystery', attention: 'none' }, groups), 'unknown');
  assert.equal(toneOf(null, groups), 'unknown');
  assert.equal(toneOf({ state: 'idle', attention: 'none' }, new Map()), 'unknown');
  for (const tone of ['active', 'waiting', 'held', 'done', 'off', 'you', 'fault', 'unknown']) assert.ok(TONES.includes(tone));
});

test('format: whole percentages, durations, London times and words', () => {
  assert.equal(percent(0.14), '14%');
  assert.equal(percent(0.15), '15%');
  assert.equal(duration(12180), '3h 23m');
  assert.equal(duration(32520), '9h 2m');
  assert.equal(shortDuration(32520), '9h');
  assert.equal(duration(32400), '9h');
  assert.equal(duration(360), '6m');
  assert.equal(duration(45), '45s');
  assert.equal(duration(183600), '2d 3h');
  assert.equal(duration(-1), 'unknown');
  assert.equal(duration(null), 'unknown');
  assert.equal(clock('2026-11-12T22:00:07Z'), '22:00');
  assert.equal(clock('2026-07-01T22:00:00Z'), '23:00', 'summer time is one hour ahead');
  assert.equal(dateTime('2026-11-19T04:00:00Z'), 'Thu 19 Nov, 04:00');
  assert.equal(clock('nonsense'), 'unknown');
  assert.equal(words('waiting_for_approval'), 'Waiting for approval');
  assert.equal(words(null), 'Unknown');
});

test('client: a model is fetched from /api/v1/ by name and a bad name or status is an error', async () => {
  const seen = [];
  const ok = async url => { seen.push(url); return { ok: true, json: async () => ({ model: 'appbar' }) }; };
  assert.deepEqual(await fetchModel('appbar', ok), { model: 'appbar' });
  assert.deepEqual(seen, ['/api/v1/appbar']);
  await assert.rejects(fetchModel('../x', ok), /not a model name/);
  await assert.rejects(fetchModel('http://evil', ok), /not a model name/);
  await assert.rejects(fetchModel('appbar', async () => ({ ok: false, status: 503 })), /503/);
});

class FakeSource {
  constructor(url) { this.url = url; this.listeners = {}; FakeSource.last = this; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  emit(type, data) { this.listeners[type]?.({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}

function stream() {
  const log = { states: [], changes: [], freshness: [] };
  let clockNow = 1000;
  let tick = null;
  const handle = openStream(
    { onState: s => log.states.push(s), onChange: n => log.changes.push(n), onFreshness: f => log.freshness.push(f) },
    { EventSource: FakeSource, now: () => clockNow, every: fn => { tick = fn; return 1; }, stopEvery: () => {} },
  );
  return { log, handle, source: FakeSource.last, advance: ms => { clockNow += ms; tick(); } };
}

test('client: the stream opens /api/v1/events and goes connecting, live, reconnecting, live', () => {
  const { log, handle, source } = stream();
  assert.equal(source.url, '/api/v1/events');
  assert.equal(handle.state(), 'connecting');
  source.emit('hello', {});
  source.onerror();
  source.emit('heartbeat', { freshness: { state: 'fresh' } });
  assert.deepEqual(log.states, ['live', 'reconnecting', 'live']);
  assert.deepEqual(log.freshness, [{ state: 'fresh' }]);
});

test('client: a model change reports the names, resync reports null, and a malformed event reports an empty list', () => {
  const { log, source } = stream();
  source.emit('model_changed', { models: ['appbar'] });
  source.emit('command_applied', { models: ['inbox'] });
  source.emit('resync_required', { reason_code: 'cursor_too_old' });
  source.listeners.model_changed({ data: 'not json' });
  assert.deepEqual(log.changes, [['appbar'], ['inbox'], null, []]);
});

test('client: nothing for 35 seconds is behind, a stream error does not undo it, and an event brings it back', () => {
  const { log, source, advance } = stream();
  source.emit('hello', {});
  advance(BEHIND_AFTER_MS);
  assert.deepEqual(log.states, ['live'], 'exactly 35 seconds is not yet behind');
  advance(1);
  source.onerror();
  assert.deepEqual(log.states, ['live', 'behind']);
  source.emit('heartbeat', {});
  assert.deepEqual(log.states, ['live', 'behind', 'live']);
});

test('colours: every text token has at least 4.5 to 1 on the surfaces in the light and the dark set', () => {
  const css = fs.readFileSync(new URL('../supervisor/ui/app.css', import.meta.url), 'utf8');
  const block = pattern => Object.fromEntries([...pattern.exec(css)[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map(m => [m[1], m[2]]));
  const light = block(/:root\s*{([^}]*)}/);
  const dark = { ...light, ...block(/\[data-theme="dark"\]\s*{([^}]*)}/) };
  const luminance = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  for (const [name, set] of [['light', light], ['dark', dark]]) {
    for (const text of ['text', 'muted', 'ok', 'you', 'fault', 'warn', 'unknown', 'accent']) {
      for (const surface of ['bg', 'surface', 'surface-2']) {
        assert.ok(ratio(set[text], set[surface]) >= 4.5, `${name} ${text} on ${surface}: ${ratio(set[text], set[surface]).toFixed(2)}`);
      }
    }
  }
});
