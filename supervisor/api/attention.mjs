// Issue #1252: one table that says, for every Needs you item, what kind it is, whether it waits for the homeowner or is a fault,
// and which controls apply. Pure: nothing here reads a file, the clock or the network.
// An item is one attention item as the view builder makes it (id, text, ref, severity, action, since); `known` is the set of command names that exist.

export const KINDS = Object.freeze([
  'decision', 'inbox_item', 'homeowner_step', 'stuck_change', 'held_item', 'idle_agent',
  'waste', 'stale_reading', 'install', 'breaker', 'host', 'other',
]);
export const ATTENTIONS = Object.freeze(['homeowner', 'fault', 'unknown']);
export const TIERS = Object.freeze(['direct', 'approval', 'person_only']);

const NOT_BUILT_TEXT = 'This control is not built yet.';

// One control. `input` is a function of the item and the id match, or null when the command needs no input.
const act = (command, tier, reversible, input = null) => ({ command, tier, reversible, input });

const BY_PR = (item, m) => ({ pull: Number(m[1]) });
const BY_ISSUE = (item, m) => ({ issue: Number(m[1]) });
const BY_JOB = (item, m) => ({ job: m[1] });
const parkPr = act('work_item.park', 'direct', true, BY_PR);

// Row: id pattern, the values it gives, and `example` (an id this pattern matches, used by the tests to run the dead end check over every row).
// `step` says where a homeowner step's text comes from: the item's text or its action line. Order matters: the first match wins.
// `target` is a function of the id match that names the pull request the item is about, for the items whose own record carries no reference.
const row = (pattern, example, kind, attention, reasonCode, actions = [], step = null, target = null) => (
  { pattern, example, kind, attention, reasonCode, actions, step, target }
);

export const TABLE = Object.freeze([
  row(/^breaker-halt$/, 'breaker-halt', 'breaker', 'fault', 'breaker_halt', [act('breaker.resume', 'person_only', true)]),
  row(/^breaker-error$/, 'breaker-error', 'breaker', 'fault', 'breaker_failed'),
  row(/^foreman-idle$/, 'foreman-idle', 'idle_agent', 'fault', 'foreman_idle'),
  row(/^idle-[\w-]+$/, 'idle-claude', 'idle_agent', 'fault', 'agent_idle'),
  row(/^unexplained-hold-/, 'unexplained-hold-implement-claude-1185', 'idle_agent', 'fault', 'unexplained_hold'),
  row(/^stalled-hold-/, 'stalled-hold-x', 'idle_agent', 'fault', 'known_hold_stalled'),
  row(/^hold-cycle-/, 'hold-cycle-abcd', 'held_item', 'fault', 'hold_cycle_dropped'),
  row(/^decision-proposal-(D-\d+|[\w-]+?)-(\d+)$/, 'decision-proposal-D-040-12', 'decision', 'homeowner', 'decision_proposed', [
    act('decision.approve', 'person_only', false, (item, m) => ({ decision: m[1], pull: Number(m[2]) })),
    act('decision.reject', 'person_only', false, (item, m) => ({ decision: m[1], pull: Number(m[2]) })),
  ]),
  row(/^decision-(D-\d+)$/, 'decision-D-024', 'decision', 'homeowner', 'decision_unapproved', [
    act('decision.approve', 'person_only', false, (item, m) => ({ decision: m[1] })),
    act('decision.reject', 'person_only', false, (item, m) => ({ decision: m[1] })),
  ]),
  row(/^fixlimit-(\d+)$/, 'fixlimit-1192', 'stuck_change', 'homeowner', 'fix_limit_reached', [
    act('work_item.allow_fix_round', 'approval', false, BY_PR),
    act('work_item.accept_split', 'approval', false, BY_PR),
    parkPr,
  ]),
  row(/^escalating-(\d+)$/, 'escalating-7', 'stuck_change', 'unknown', 'final_fix_round_planned'),
  row(/^reviewlimit-(\d+)$/, 'reviewlimit-7', 'stuck_change', 'homeowner', 'review_limit_reached', [parkPr]),
  row(/^reviewrefused-(\d+)$/, 'reviewrefused-7', 'stuck_change', 'homeowner', 'review_verdict_refused', [parkPr]),
  row(/^retrycap-/, 'retrycap-implement-12', 'stuck_change', 'homeowner', 'retry_capped', [
    act('work_item.clear_retry_cap', 'approval', true, (item, m) => ({ key: item.id.slice('retrycap-'.length) })),
  ]),
  row(/^split-(\d+)$/, 'split-9', 'stuck_change', 'homeowner', 'split_proposed', [
    act('work_item.accept_split', 'approval', false, BY_ISSUE),
    act('work_item.park', 'direct', true, BY_ISSUE),
  ]),
  row(/^upgrade-latched$/, 'upgrade-latched', 'install', 'homeowner', 'upgrade_latched', [act('upgrade.clear_latch', 'person_only', true)]),
  row(/^upgrade-blocked$/, 'upgrade-blocked', 'install', 'fault', 'install_tests_refused', [act('upgrade.retry_install', 'direct', false)]),   // issue #1368
  row(/^flaky-test-[0-9a-f]+$/, 'flaky-test-0123456789abcdef', 'install', 'fault', 'flaky_test'),   // issue #1370
  row(/^upgrade-refused$/, 'upgrade-refused', 'install', 'fault', 'upgrade_refused'),
  row(/^dashboard-restart-failed$/, 'dashboard-restart-failed', 'install', 'fault', 'dashboard_restart_failed'),
  row(/^dashboard-stale$/, 'dashboard-stale', 'install', 'fault', 'dashboard_stale'),
  row(/^migration-failed$/, 'migration-failed', 'install', 'fault', 'migration_failed'),
  row(/^config-invalid$/, 'config-invalid', 'install', 'fault', 'configuration_invalid'),
  row(/^drift$/, 'drift', 'install', 'unknown', 'merged_not_installed'),
  // Issue #1306: every issue closed as not planned or duplicate with no recorded reason, as one item; its control takes the listed numbers and a reason text.
  row(/^closed-noreason$/, 'closed-noreason', 'held_item', 'homeowner', 'closed_without_reason', [
    act('work_item.close_reason', 'direct', false, item => ({ issues: (Array.isArray(item.issues) ? item.issues : []).join(',') })),
  ]),
  row(/^closed-noreason-unreadable$/, 'closed-noreason-unreadable', 'held_item', 'fault', 'close_reason_record_unreadable'),
  row(/^hand-deploy$/, 'hand-deploy', 'homeowner_step', 'homeowner', 'hand_deploy', [], 'text'),
  row(/^history-storage$/, 'history-storage', 'homeowner_step', 'homeowner', 'history_storage', [], 'action'),
  row(/^homeowner-steps-(\d+)$/, 'homeowner-steps-5', 'homeowner_step', 'homeowner', 'homeowner_steps_listed', [], 'text'),
  // Issue #1377: the pending steps module writes homeowner-step-<pr>-<step>. The old dashboard's Mark done has no command yet, so it is listed as not built.
  row(/^homeowner-step-(\d+)-(\d+)$/, 'homeowner-step-1124-1', 'homeowner_step', 'homeowner', 'homeowner_step_waiting', [
    act('homeowner_step.mark_done', 'person_only', false, (item, m) => ({ pull: Number(m[1]), step: Number(m[2]) })),
  ], 'text', m => ({ kind: 'pull', n: Number(m[1]) })),
  row(/^homeowner-pr-(\d+)$/, 'homeowner-pr-5', 'homeowner_step', 'homeowner', 'needs_homeowner_label', [], 'text'),
  row(/^homeowner-(\d+)$/, 'homeowner-5', 'homeowner_step', 'homeowner', 'needs_homeowner_label', [], 'text'),
  row(/^cap-deadlock$/, 'cap-deadlock', 'stuck_change', 'homeowner', 'open_pr_cap_deadlock', [], 'action'),
  row(/^stale-mark-(\d+)$/, 'stale-mark-8', 'held_item', 'homeowner', 'stale_implemented_mark', [
    act('work_item.requeue', 'approval', true, BY_ISSUE),
  ]),
  row(/^dependency-malformed-(\d+)$/, 'dependency-malformed-1185', 'held_item', 'fault', 'malformed_prerequisite_line', [
    act('work_item.edit_prerequisites', 'direct', true, BY_ISSUE),
  ]),
  row(/^dependency-cycle-/, 'dependency-cycle-3-4', 'held_item', 'fault', 'prerequisite_cycle'),
  row(/^dependency-(?:notplanned|unlinked)-(\d+)-/, 'dependency-notplanned-6-20', 'held_item', 'homeowner', 'prerequisite_needs_repointing', [
    act('work_item.edit_prerequisites', 'direct', true, BY_ISSUE),
  ]),
  row(/^stalled-dependency-/, 'stalled-dependency-6', 'held_item', 'fault', 'prerequisite_stalled'),
  row(/^inbox-waiting$/, 'inbox-waiting', 'inbox_item', 'homeowner', 'inbox_waiting', [], 'text'),
  row(/^inbox(?:fail|refused)-/, 'inboxfail-abc', 'inbox_item', 'fault', 'inbox_card_failed'),
  row(/^noreviewer-refused-(\d+)$/, 'noreviewer-refused-7', 'stuck_change', 'fault', 'review_verdict_not_recorded'),
  row(/^noreviewer-(\d+)$/, 'noreviewer-7', 'stuck_change', 'fault', 'no_independent_reviewer'),
  row(/^rebase-lost-/, 'rebase-lost-abcd1234', 'stuck_change', 'fault', 'rebase_lost_work'),
  row(/^ci-/, 'ci-41', 'stuck_change', 'fault', 'ci_not_passing'),
  row(/^main-ci-red$/, 'main-ci-red', 'other', 'fault', 'main_ci_red', [act('ci.rerun_main', 'direct', true)]),   // issue #1375: the command is not built
  row(/^pause-/, 'pause-claude', 'stale_reading', 'unknown', 'allowance_reading_disagrees'),
  row(/^(?:no-tick|tick-failed|tick-stale)$/, 'tick-stale', 'host', 'fault', 'tick_not_running'),
  row(/^agentfault-/, 'agentfault-claude', 'host', 'fault', 'agent_parked'),
  row(/^selfcheck-host-pressure$/, 'selfcheck-host-pressure', 'host', 'fault', 'host_pressure'),
  row(/^selfcheck-/, 'selfcheck-job-abc', 'other', 'fault', 'self_check_failed'),
  row(/^(?:register-unreadable|unknown-job-records|status-issue-failed|alert-failed|alert-warning)$/, 'alert-failed', 'host', 'fault', 'host_reading_failed'),
  row(/^assignment-/, 'assignment-fault-refused', 'other', 'fault', 'assignment_refused'),
  row(/^(?:board-paused|paused-new-work)$/, 'board-paused', 'other', 'unknown', 'work_paused'),
  row(/^job-(.+)$/, 'job-aaaa', 'other', 'fault', 'job_stopped', [
    act('job.resume', 'direct', true, BY_JOB),
    act('job.close', 'approval', false, BY_JOB),
  ]),
]);

const UNCLASSIFIED = Object.freeze({ kind: 'other', attention: 'fault', reasonCode: 'unclassified', actions: [], step: null, target: null });

function renderAction(a, item, match, known) {
  const enabled = known.has(a.command);
  return {
    command: a.command,
    input: a.input ? a.input(item, match) : {},
    enabled,
    tier: a.tier,
    reversible: a.reversible,
    refusal_code: enabled ? null : 'not_built',
    refusal_text: enabled ? null : NOT_BUILT_TEXT,
  };
}

function stepTextOf(spec, item) {
  if (spec.attention !== 'homeowner' || !spec.step) return null;
  const preferred = spec.step === 'action' ? item.action : item.text;
  const text = typeof preferred === 'string' && preferred ? preferred : item.text;
  return typeof text === 'string' && text ? text : null;
}

// known: any iterable of command names (a Set, an array); anything else means none are built.
export function classify(item, known) {
  const safe = item && typeof item === 'object' ? item : {};
  const id = typeof safe.id === 'string' ? safe.id : '';
  const commands = new Set(known && typeof known[Symbol.iterator] === 'function' ? known : []);
  let spec = UNCLASSIFIED;
  let match = [];
  for (const candidate of TABLE) {
    const m = id.match(candidate.pattern);
    if (!m) continue;
    spec = candidate;
    match = m;
    break;
  }
  return {
    kind: spec.kind,
    attention: spec.attention,
    reason_code: spec.reasonCode,
    actions: spec.actions.map(a => renderAction(a, { ...safe, id }, match, commands)),
    step_text: stepTextOf(spec, safe),
    target: spec.target ? spec.target(match) : null,
  };
}

// The classified items that wait for the homeowner and give them nothing to do: no action and no step text.
// A disabled action does not count as nothing, but only a step text tells the homeowner what to do when every action is disabled.
export function findDeadEnds(classified) {
  return (classified || []).filter(c => c?.attention === 'homeowner' && !(c.actions?.length > 0) && !c.step_text);
}
