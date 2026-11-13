// Posting an approved issue draft is isolated from Team so the final content check stays testable without growing the dispatcher.
import * as inboxStore from './inbox.mjs';
import { redact, redactLong } from './redact.mjs';
import { resolveAfter } from '../foreman-mcp/draft-after.mjs';
import { chainOutcome, withPrerequisites } from './draft-chain.mjs';

const failDraft = (team, dir, id, reason) => inboxStore.finish(dir, id, { state: 'failed', reason, result: 'nothing was posted', waitsFor: null }, team.clock.now());

// Where the draft stands against the drafts it names. 'post' carries their issue numbers; 'wait' and 'fail' have been recorded already.
function chainStep(team, dir, st, item) {
  if (!item.after) return { action: 'post', numbers: [] };
  const named = resolveAfter(dir, st.id, item.after);
  if (!named.ok) { failDraft(team, dir, st.id, named.reason); return { action: 'fail' }; }
  const outcome = chainOutcome(named.ids, id => inboxStore.statusOf(dir, id));
  if (outcome.action === 'fail') failDraft(team, dir, st.id, outcome.reason);
  // Recorded only when it changes, so a draft that waits for hours does not rewrite its status every pass.
  if (outcome.action === 'wait' && JSON.stringify(st.waitsFor) !== JSON.stringify(outcome.labels)) inboxStore.finish(dir, st.id, { waitsFor: outcome.labels }, team.clock.now());
  return outcome;
}

export async function postIssueDraft(team, dir, st, item, report) {
  const id = st.id;
  const chain = chainStep(team, dir, st, item);
  if (chain.action !== 'post') return;
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
    const full = item.after ? withPrerequisites(body, chain.numbers) : body;
    if (full === null) {
      failDraft(team, dir, id, 'the prerequisite line could not be written so that the dependency check accepts it');
      return;
    }
    number = await team.gh.createIssue(title, `${full}\n\n${mark}`);
  }
  inboxStore.finish(dir, id, { state: 'done', issue: number, waitsFor: null, result: `posted as issue #${number}` }, team.clock.now());
  (report.actions ||= []).push({ type: 'inbox-issue', result: `posted overseer issue draft ${id.slice(0, 8)} as #${number}` });
}
