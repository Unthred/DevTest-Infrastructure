import { CARD_STATES } from './inbox-cards.mjs';

// Inbox MCP tool definitions live apart from the main registry so adding an Inbox
// capability does not expand createTools(), which already coordinates all tools.
const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    search: { type: 'string', maxLength: 200 },
    kind: { type: 'string', enum: ['prompt', 'issue_draft', 'action', 'host_value', 'decision'] },
    state: { type: 'string', enum: ['pending', 'approved', 'rejected', 'running', 'posting', 'done', 'failed', 'refused'] },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
};

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['prompt', 'issue_draft', 'action'] },
    title: { type: 'string', maxLength: 200 },
    action: { type: 'string', enum: ['new_review_attempt', 'clear_retry_cap', 'reopen', 'close_job', 'stop_job', 'resume_job', 'clear_latch'], description: 'kind action: the named action' },
    target: { type: 'string', maxLength: 12, description: 'kind action: PR or issue number, or 8-character job id; omit for clear_latch' },
    reason: { type: 'string', maxLength: 300, description: 'kind action: why' },
    prompt: { type: 'string', maxLength: 8000, description: 'kind prompt: the task text' },
    body: { type: 'string', maxLength: 8000, description: 'kind issue_draft: the issue body' },
    why: { type: 'string', maxLength: 400, description: 'optional: why this is proposed' },
  },
  required: ['kind', 'title'],
  additionalProperties: false,
};

const CARDS_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: CARD_STATES },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'default 20' },
  },
  additionalProperties: false,
};

const STATUS_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string', pattern: '^([a-f0-9]{8}|[a-f0-9]{32})$' } },
  required: ['id'],
  additionalProperties: false,
};

export function inboxToolDefs(inbox, search = null, cards = null) {
  if (!inbox.enabled) return [];
  return [
    {
      name: 'foreman_inbox_items',
      description: 'Search Inbox items and homeowner decisions exactly as the dashboard does: every typed word must appear across the title, proposal text, why, kind, state, or linked issue or pull request number. Search is case- and punctuation-insensitive; 1104 and #1104 are equivalent. Optional kind and state filters combine with search. Read-only.',
      inputSchema: SEARCH_SCHEMA,
      run: args => search ? search(args) : inbox.list(args),
    },
    ...(cards ? [{
      name: 'foreman_inbox',
      description: 'List every Inbox card newest first, compactly: short id, kind, the exact title the dashboard shows, state (submitted, pending, approved, running, done, failed, refused, rejected), age in minutes, who proposed it (overseer or system) and, for prompts, the first line of the prompt. Optional state filter and limit (default 20). Refused cards show only when state is refused. For full text or word search use foreman_inbox_items. Read-only.',
      inputSchema: CARDS_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: args => cards(args),
    }] : []),
    {
      name: 'foreman_propose',
      description: 'Propose one item for the homeowner to approve on the Foreman dashboard. kind "prompt": a task to run as a supervised Foreman job (it cannot merge, approve reviews or widen its limits). kind "issue_draft": an issue to post as the homeowner. kind "action": one named job action (new_review_attempt or clear_retry_cap with a PR number, reopen with an issue number, close_job, stop_job or resume_job with an 8-character job id, or clear_latch with no target to clear the upgrade latch) plus a reason. This only writes a proposal; nothing happens until the homeowner approves it, and you cannot approve it. Secret-shaped text, AI attribution text, oversized items and unknown fields are refused. Read the outcome with foreman_proposal_status.',
      inputSchema: PROPOSAL_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: args => inbox.propose(args),
    },
    {
      name: 'foreman_proposal_status',
      description: 'The state of a proposal made with foreman_propose: waiting, pending (awaiting the homeowner), refused (with the reason), rejected, approved, running, done or failed, with the result summary once there is one.',
      inputSchema: STATUS_SCHEMA,
      run: args => inbox.status(args.id),
    },
  ];
}
