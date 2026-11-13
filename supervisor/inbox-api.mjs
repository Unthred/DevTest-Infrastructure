// Issue #1197: GET /api/inbox.json, a compact read-only list of the Inbox cards for the Foreman MCP tool and for checks. It reads the
// status records Foreman wrote (allStatuses) and nothing else, writes nothing, and shows only the redacted title and state fields.
import { allStatuses, LIMITS } from './inbox.mjs';
import { redactLong } from './redact.mjs';

const clip = text => redactLong(String(text ?? '').replace(/\s+/g, ' '), LIMITS.title, ' [cut]').trim();

export function inboxCardsJson(inboxDir, now = Date.now()) {
  const cards = allStatuses(inboxDir)
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
    .map(status => ({
      id: status.id.slice(0, 8),
      kind: status.kind ?? null,
      title: clip(status.title),
      state: status.state ?? 'unknown',
      ageMinutes: Number.isFinite(status.createdAt) ? Math.max(0, Math.floor((now - status.createdAt) / 60000)) : null,
    }));
  return { count: cards.length, cards };
}

// The whole reply for the route, so the dashboard handler needs one short line: [status, content type, body].
export function inboxApiReply(inboxDir, now) {
  if (!inboxDir) return [404, 'text/plain; charset=utf-8', 'not found'];
  return [200, 'application/json; charset=utf-8', JSON.stringify(inboxCardsJson(inboxDir, now))];
}
