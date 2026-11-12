// Issue #1164: the direct controls the overseer may use, as the MCP server sees them: each name, whether its target is a job or an issue or pull
// request number, and the shape of its value. The server cannot import from supervisor/, so a test compares this with supervisor/directspec.mjs.
// This is only an early refusal: Foreman reads the same rules again, and anything outside this list never reaches it as a control.
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
const fail = error => ({ ok: false, error });
const TARGET_WORDS = { job: 'the 8-character job id (or the full id)', number: 'an issue or pull request number' };

// Checks a `control` item the way Foreman will, so the overseer learns at once. A name outside the direct list goes to Foreman, which refuses it
// with who decides it and writes the refusal to the audit trail, so the trail holds every refusal.
export function checkControl(item) {
  const { action, target, value } = item;
  if (!Object.hasOwn(TARGETS, action)) return NAME.test(action) ? { ok: true, item } : fail('action must be a lower-case name');
  if (!targetPattern(action).test(target)) return fail(`target must be ${TARGET_WORDS[TARGETS[action]]}`);
  if (VALUES[action] && !VALUES[action].test(value ?? '')) return fail(`${action} needs a valid value`);
  if (!VALUES[action] && value !== undefined) return fail(`${action} takes no value`);
  return { ok: true, item };
}

// What a finished control item changed, from the status file Foreman wrote: whether, and the state before and after.
export const controlOf = s => (s?.control ? { changed: s.control.changed ?? null, before: s.control.before ?? null, after: s.control.after ?? null,
  audit: s.control.audit ?? null } : null);
