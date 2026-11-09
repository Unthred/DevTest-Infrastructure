import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { highlightInboxText, matchesInboxSearch } from '../foreman-mcp/inbox-search.mjs';
import { createInbox } from '../foreman-mcp/inbox.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { scan } from '../supervisor/inbox.mjs';

const item = {
  title: 'Reserve digest for allowance and role fallback',
  prompt: 'Check pull request #1104 before the next dispatch.',
  why: 'The “Reserve” note uses an en–dash.',
  kind: 'prompt',
  state: 'pending',
  pr: 1104,
};

test('Inbox matcher requires every word and accepts linked numbers with or without a hash', () => {
  assert.equal(matchesInboxSearch(item, 'Reserve fallback'), true);
  assert.equal(matchesInboxSearch(item, 'Reserve 1104'), true);
  assert.equal(matchesInboxSearch(item, '#1104 pending'), true);
  assert.equal(matchesInboxSearch(item, 'Reserve absent'), false);
});

test('Inbox matcher handles empty, short, cross-field and punctuation-insensitive queries', () => {
  assert.equal(matchesInboxSearch(item, ''), true);
  assert.equal(matchesInboxSearch(item, 'R'), true);
  assert.equal(matchesInboxSearch(item, 'allowance dispatch'), true);
  assert.equal(matchesInboxSearch(item, '“reserve” en-dash'), true);
  assert.equal(matchesInboxSearch(item, '*** ???'), true);
});

test('Inbox heading highlights matched words without treating special characters as markup', () => {
  const parts = highlightInboxText('Reserve <safe> fallback', 'reserve fallback');
  assert.deepEqual(parts.filter(part => part.matched).map(part => part.text), ['Reserve', 'fallback']);
});

test('Inbox MCP search shares the matcher and combines kind and state filters', async t => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'inbox-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const items = path.join(root, 'items');
  fs.mkdirSync(items);
  fs.mkdirSync(path.join(root, 'status'));
  const id = crypto.randomBytes(16).toString('hex');
  const proposal = { kind: item.kind, title: item.title, prompt: item.prompt, why: item.why };
  fs.writeFileSync(path.join(items, `${id}.json`), JSON.stringify(proposal));
  scan(root, 1000);
  const tools = createTools({
    source: { get: async () => ({ view: {}, ageMs: 0 }) },
    readHost: () => ({}),
    inbox: createInbox({ dir: root }),
  });
  const found = await tools.call('foreman_inbox_items', {
    search: 'reserve #1104',
    kind: 'prompt',
    state: 'pending',
  });
  const result = JSON.parse(found.text);
  assert.equal(result.count, 1);
  assert.equal(result.items[0].id, id);
  const none = await tools.call('foreman_inbox_items', { search: 'reserve absent' });
  assert.equal(JSON.parse(none.text).count, 0);
});
