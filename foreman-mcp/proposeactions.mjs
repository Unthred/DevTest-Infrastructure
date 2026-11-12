// What foreman_propose accepts for kind "action", in one place: the schema enum and the description text (issue #1158 added the strong tier).
// The strong names need the homeowner to type the pull request number on the head the card shows; the overseer can propose them, never approve.
export const STRONG_NAMES = ['merge_pr', 'approve_decision', 'verdict_pass', 'verdict_changes'];
export const ACTION_NAMES = ['new_review_attempt', 'clear_retry_cap', 'reopen', 'close_job', 'stop_job', 'resume_job', ...STRONG_NAMES];

export const PROPOSE_DESCRIPTION = 'Propose one item for the homeowner to approve on the Foreman dashboard. kind "prompt": a task to run as a supervised Foreman job '
  + '(it cannot merge, approve reviews or widen its limits). kind "issue_draft": an issue to post as the homeowner. kind "action": one named job action '
  + '(new_review_attempt or clear_retry_cap with a PR number, reopen with an issue number, close_job, stop_job or resume_job with an 8-character job id; '
  + 'or, strong tier, merge_pr, approve_decision, verdict_pass or verdict_changes with a PR number: the homeowner must type that number on the head shown, '
  + 'and you can never approve them) plus a reason. This only writes a proposal; nothing happens until the homeowner approves it, and you cannot approve it. '
  + 'Secret-shaped text, AI attribution text, oversized items and unknown fields are refused. Read the outcome with foreman_proposal_status.';
