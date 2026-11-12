// Posting an approved issue draft is isolated from Team so the final content check stays testable without growing the dispatcher.
import * as inboxStore from './inbox.mjs';
import { redact, redactLong } from './redact.mjs';

export async function postIssueDraft(team, dir, st, item, report) {
  const id = st.id;
  const mark = inboxStore.marker(id);
  if (st.state === 'approved' && !inboxStore.claim(dir, id, 'approved', { state: 'posting' }, team.clock.now())) return;
  const final = inboxStore.validateItem(item);
  if (!final.ok) {
    inboxStore.finish(dir, id, { state: 'failed', reason: final.reason, result: 'nothing was posted' }, team.clock.now());
    return;
  }
  let number = await team.gh.findIssueByMarker(mark);
  if (!number) {
    const title = redact(item.title, 200);
    const body = redactLong(item.body, 8000, ' [cut]');
    if (inboxStore.attributionShaped(title + body) || inboxStore.secretShaped(title + body)) {
      inboxStore.finish(dir, id, { state: 'failed', reason: 'the text failed the final check', result: 'nothing was posted' }, team.clock.now());
      return;
    }
    number = await team.gh.createIssue(title, `${body}\n\n${mark}`);
  }
  inboxStore.finish(dir, id, { state: 'done', issue: number, result: `posted as issue #${number}` }, team.clock.now());
  (report.actions ||= []).push({ type: 'inbox-issue', result: `posted overseer issue draft ${id.slice(0, 8)} as #${number}` });
}
