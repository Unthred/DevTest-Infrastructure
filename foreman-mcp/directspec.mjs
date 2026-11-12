// Issue #1164: the direct controls the overseer may use, as the MCP server sees them: each name, whether its target is a job or an issue or pull
// request number, and the shape of its value. The server cannot import from supervisor/, so a test compares this with supervisor/directspec.mjs.
// Foreman applies these rules and audits each refusal; checkControl only checks the action name.
export const NUMBER_TARGET = /^[1-9]\d{0,8}$/;
export const JOB_TARGET = /^(?:[a-f0-9]{8}|[a-f0-9]{32})$/;
export const TARGETS = {
  start_job: 'job', pause_job: 'job', stop_job: 'job',
  park: 'number', unpark: 'number', remove_entry: 'number', set_rank: 'number', move_entry: 'number', set_priority: 'number',
    set_depends_on: 'number', assign: 'number', set_notes: 'number',
};
export const VALUES = {
  set_rank: /^[1-9]\d{0,3}$/,
  move_entry: /^(?:before|after) [1-9]\d{0,8}$/,
  set_priority: /^(?:high|normal|low)$/,
  set_depends_on: /^(?:none|#[1-9]\d{0,8}(?:, ?#[1-9]\d{0,8}){0,9})$/,
  assign: /^(?:none|[a-z][a-z0-9_-]{0,39})$/,
  set_notes: /^[^\r\n]{1,300}$/,
};
export const targetPattern = action => (TARGETS[action] === 'job' ? JOB_TARGET : NUMBER_TARGET);

const NAME = /^[a-z][a-z_]{0,29}$/;

// Checks the name of a `control` item. checkProposal has already refused unprintable, overlong or secret-shaped text. A target or value that is merely
// malformed (a Depends on line without "#", an agent written "Codex") goes on to Foreman, which refuses it with the reason and writes the refusal to the
// audit trail; the MCP account cannot write that file, so refusing here would leave the refusal out of the trail.
export function checkControl(item) {
  return NAME.test(item.action) ? { ok: true, item } : { ok: false, error: 'action must be a lower-case name' };
}

// What a finished control item changed, from the status file Foreman wrote: whether, and the state before and after.
export const controlOf = s => (s?.control ? { changed: s.control.changed ?? null, before: s.control.before ?? null, after: s.control.after ?? null,
  audit: s.control.audit ?? null } : null);
