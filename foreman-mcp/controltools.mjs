// Issues #1115 and #1164: the overseer's direct controls, one MCP tool each, every one with a required reason. Each writes a `control` proposal file
// through the same inbox as foreman_propose; Foreman validates the target, applies it on its next pass without a click, and writes who, what, target,
// before and after, reason and time to the audit trail. The tool waits briefly for the outcome and returns it, including the resulting state.
// These handlers write nothing but a proposal file. Merging, approving, closing, limits and restarts have no tool; the dashboard switch turns all of these off.
const FINAL = new Set(['done', 'failed', 'refused', 'rejected']);
const REASON = { type: 'string', minLength: 1, maxLength: 300, description: 'why; recorded with who and when' };
const NUMBER = { type: 'integer', minimum: 1, maximum: 999999999, description: 'the issue or pull request number' };
const JOB = { type: 'string', pattern: '^(?:[a-f0-9]{8}|[a-f0-9]{32})$', description: 'the 8-character job id from foreman_jobs, or the full id' };
const schema = properties => ({ type: 'object', properties, required: [...Object.keys(properties)], additionalProperties: false });
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const TAIL = ' Needs a reason. Repeating it changes nothing and reports the same state.'
  + ' Refused with a reason if the target is the wrong state, unknown, or the action would breach a limit.';

// name, action, arguments (besides reason), how the value is made from the arguments, description. One row per control.
const TOOLS = [
  ['foreman_start_job', 'start_job', { id: JOB }, null,
    'Start or resume one paused, blocked, failed or waiting job now, under the same checks as the homeowner\'s resume (allowance, breaker, free slot).'],
  ['foreman_pause_job', 'pause_job', { id: JOB }, null, 'Pause one running or queued job. Undo it with foreman_start_job.'],
  ['foreman_stop_job', 'stop_job', { id: JOB }, null, 'Stop one job (the supported stop): it will not restart and uses no attempt.'],
  ['foreman_park', 'park', { number: NUMBER }, null,
    'Park one issue or pull request: the planner skips it. A running job on it is not stopped (stop it with foreman_stop_job).'],
  ['foreman_unpark', 'unpark', { number: NUMBER }, null, 'Release a parked issue or pull request so the planner may take it again.'],
  ['foreman_remove_entry', 'remove_entry', { number: NUMBER }, null,
    'Remove one queued issue from the queue without closing it: the issue stays open and is parked.'],
  ['foreman_set_rank', 'set_rank', { number: NUMBER, rank: { type: 'integer', minimum: 1, maximum: 9999,
    description: '1 is the front of the queue' } }, a => String(a.rank),
    'Set the rank of one queued issue in the planner\'s queue. The priority tier is applied after the rank, and the result says where it really sits.'],
  ['foreman_move_entry', 'move_entry', { number: NUMBER, place: { enum: ['before', 'after'] }, other: NUMBER }, a => `${a.place} ${a.other}`,
    'Move one queued issue before or after another queued issue.'],
  ['foreman_set_priority', 'set_priority', { number: NUMBER, priority: { enum: ['high', 'normal', 'low'] } }, a => a.priority,
    'Set the priority tier of one queued issue.'],
  ['foreman_set_depends_on', 'set_depends_on', { number: NUMBER, depends_on: { type: 'string', maxLength: 120,
    description: '"none" or a list such as "#12, #15"' } }, a => a.depends_on,
    'Set what one queued issue waits for, replacing the Depends on line of the issue for the planner (the issue text on GitHub is not edited).'],
  ['foreman_assign', 'assign', { number: NUMBER, agent: { type: 'string', maxLength: 40, description: 'an agent name, or "none" to clear' } }, a => a.agent,
    'Assign one queued issue to one agent (the planner offers it to that agent only), or clear the assignment.'],
  ['foreman_set_notes', 'set_notes', { number: NUMBER, notes: { type: 'string', maxLength: 300, description: 'one line' } }, a => a.notes,
    'Set the notes kept with one queued issue.'],
];
const targetOf = a => String(a.number ?? a.id);

export function controlTools({ inbox, wait = defaultWait, waitMs = 20000 }) {
  // Foreman runs a control item on its next pass (the inbox watcher wakes one). Wait briefly for the result so the overseer sees it at once.
  async function submit(item) {
    const sent = inbox.propose(item);
    const deadline = Date.now() + waitMs;
    for (;;) {
      let s = null;
      try { s = inbox.status(sent.id); } catch { /* not readable yet */ }
      if (s && FINAL.has(s.state)) return { ...sent, state: s.state, result: s.result ?? null, reason: s.state === 'done' ? null : s.reason ?? null,
        resulting: inbox.controlResult?.(sent.id) ?? null };
      if (Date.now() >= deadline) return { ...sent, note: 'Foreman has not run it yet; read the outcome with foreman_proposal_status.' };
      await wait(1000);
    }
  }
  return TOOLS.map(([name, action, props, valueOf, description]) => ({
    name, description: description + TAIL, inputSchema: schema({ ...props, reason: REASON }), annotations: WRITE,
    run: a => submit({ kind: 'control', title: `${action} ${targetOf(a)}`.slice(0, 200), action, target: targetOf(a), reason: a.reason,
      ...(valueOf ? { value: valueOf(a) } : {}) }),
  }));
}
const defaultWait = ms => new Promise(r => setTimeout(r, ms));
