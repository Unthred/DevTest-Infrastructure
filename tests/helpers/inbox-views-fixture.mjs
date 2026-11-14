// Issue #1219: a fixture Inbox with the real item shapes, written through the real store (scan, decide, finish), so the /inbox page
// shows the same records it shows on Tower. Used by tests/inbox-views.test.mjs and tests/inbox-views-browser.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as inbox from '../../supervisor/inbox.mjs';

export const DRAFTCHAIN_TITLE = 'An issue draft can name earlier drafts as prerequisites and Foreman fills in their issue numbers Draftchain';
export const CIWATCH_TITLE = 'A pull request waiting on CI is watched and Foreman wakes the moment that run finishes Ciwatch';
export const DECIDED_TITLE = 'Split the parked pull request into four items Splitdecided';
export const RACE_TITLE = 'Check the router logs for dropped packets Raceitem';
export const LONG_TITLE = `Read only drift check ${'of every rule file in the shared rules repository '.repeat(3)}`.trim().slice(0, 190);
const hex = () => crypto.randomBytes(16).toString('hex');

// layout: also the two rows of 14 Nov 2026 (issue #1416); off for the row actions check, which counts the waiting items.
export function buildInbox(dir, now = Date.now(), { layout = false } = {}) {
  fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'status'), { recursive: true });
  // Each item is picked up at its own time, so the Age column has distinct values to sort.
  const drop = (item, ageMs) => { const id = hex(); fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(item)); inbox.scan(dir, now - ageMs); return id; };
  const ids = {
    donePrompt: drop({ kind: 'prompt', title: 'Rules drift check read only Driftcheck', prompt: 'Compare the rule files with the generated adapters and report drift.' }, 6 * 86400000),
    doneIssue: drop({ kind: 'issue_draft', title: 'Post-mortem: 3 jobs failed with cause deterministic', body: 'Three jobs failed for the same reason.' }, 5 * 86400000),
    failed: drop({ kind: 'prompt', title: "Tower's disk check, it can't start", prompt: 'Check the free space on the cache drive.' }, 2 * 86400000),
    long: drop({ kind: 'prompt', title: LONG_TITLE, prompt: 'Long title item.' }, 3600000),
    draftchain: drop({ kind: 'issue_draft', title: DRAFTCHAIN_TITLE, body: 'Draft that names earlier drafts as prerequisites.' }, 8 * 3600000),
    race: drop({ kind: 'prompt', title: RACE_TITLE, prompt: 'Read the router logs and count dropped packets.' }, 9 * 3600000),
    waiting: drop({ kind: 'prompt', title: 'Tidy the docs index', prompt: 'Fix the broken link in docs/README.md.' }, 7200000),
  };
  if (layout) {
    ids.ciwatch = drop({ kind: 'issue_draft', title: CIWATCH_TITLE, body: 'Draft with a long title and no result.' }, 3 * 3600000);
    ids.decided = drop({ kind: 'prompt', title: DECIDED_TITLE, prompt: 'Split it.' }, 5 * 3600000);
    inbox.decide(dir, ids.decided, 'approve', now - 1800000);   // decided, not yet carried out
  }
  for (const id of [ids.donePrompt, ids.doneIssue, ids.failed, ids.long]) inbox.decide(dir, id, 'approve', now - 4 * 86400000);
  inbox.finish(dir, ids.donePrompt, { state: 'done', result: 'No drift found.\nAll adapters match the rules.' }, now - 3 * 86400000);
  inbox.finish(dir, ids.doneIssue, { state: 'done', issue: 321, result: 'posted as issue #321' }, now - 2 * 86400000);
  inbox.finish(dir, ids.failed, { state: 'failed', reason: "It can't read the drive." }, now - 86400000);
  inbox.finish(dir, ids.long, { state: 'done' }, now - 3600000);
  return ids;
}
