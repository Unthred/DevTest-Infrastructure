import { allStatuses, loadItem } from './inbox.mjs';

const textOf = item => item.kind === 'prompt' ? item.prompt
  : item.kind === 'action' ? `${item.action} ${item.target}\nReason: ${item.reason}`
    : item.body;

const liveCard = (status, item) => ({
  id: status.id,
  kind: item.kind,
  state: status.state,
  createdAt: status.createdAt ?? null,
  title: item.title,
  why: item.why ?? null,
  body: item.body,
  prompt: item.prompt,
  reason: item.reason,
  target: item.target,
  issue: status.issue ?? null,
  pr: status.pr ?? null,
  text: textOf(item),
});

const storedCard = status => ({
  id: status.id,
  kind: status.kind ?? 'unknown',
  state: status.state ?? 'unknown',
  createdAt: status.createdAt ?? null,
  title: status.title || 'Inbox item',
  reason: status.reason ?? status.result ?? null,
  issue: status.issue ?? null,
  pr: status.pr ?? null,
  text: status.result ?? status.reason ?? '',
});

export function searchableInboxCards(dir) {
  return allStatuses(dir).map(status => {
    const loaded = loadItem(dir, status.id);
    return loaded.ok ? liveCard(status, loaded.item) : storedCard(status);
  }).sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
}
