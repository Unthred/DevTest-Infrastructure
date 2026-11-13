import * as inboxStore from './inbox.mjs';

export async function recordCreatedInboxJob({ inboxDir, act, job, now, announce }) {
  if (act.type === 'inbox') inboxStore.finish(inboxDir, act.inboxId, { activeJob: job.id }, now());
  if (announce) await announce();
}
