// Issue #1368: the client of the Retry install now button posts the named command and reports a refusal in the refusal's own words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_URL, requestBody, send, settle } from '../supervisor/dashui/retry-install-ui.mjs';

test('send posts upgrade.retry_install with the proof and an empty input', async () => {
  let seen;
  const fetchFn = async (url, init) => { seen = { url, init }; return { json: async () => ({ ok: true }) }; };
  const result = await send(fetchFn, { proof: 'p', key: 'k1' });
  assert.equal(seen.url, COMMAND_URL);
  assert.equal(COMMAND_URL, '/api/v1/commands/upgrade.retry_install');
  assert.equal(seen.init.headers['x-foreman-proof'], 'p');
  assert.deepEqual(JSON.parse(seen.init.body), { input: {}, idempotency_key: 'k1' });
  assert.equal(result.state, 'done');
});

test('a refusal shows its text and an unreachable server is a failure, never a success', async () => {
  assert.deepEqual(settle({ ok: false, refusal_text: 'No install is blocked: x.' }), { state: 'failed', text: 'No install is blocked: x.' });
  assert.equal(settle(null).state, 'failed');
  assert.equal((await send(async () => { throw new Error('down'); }, { proof: 'p' })).state, 'failed');
  assert.equal(JSON.parse(requestBody('k')).idempotency_key, 'k');
});
