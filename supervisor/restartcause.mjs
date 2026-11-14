// Issue #1423: every restart of a job records who or what did it and which command, Inbox item or rule. A caller that gives no cause is
// recorded as "cause not given" so the gap is visible in the job's events, and a test lists the callers so none can omit it.
export const WHO = ['homeowner command', 'Inbox action', 'Foreman rule', 'worker recovery'];
export const CAUSE_NOT_GIVEN = Object.freeze({ who: 'cause not given', which: 'cause not given' });

const short = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 80);

// A cause is { who, which }; anything else (missing, wrong who, empty which) is recorded as not given.
export function normalizeCause(cause) {
  if (!cause || typeof cause !== 'object' || !WHO.includes(cause.who) || !short(cause.which).trim()) return { ...CAUSE_NOT_GIVEN };
  return { who: cause.who, which: short(cause.which).trim() };
}

// The callers in the code, by name, so each call site stays short and the listing test can recognise them.
export const CAUSE = Object.freeze({
  homeownerResume: { who: 'homeowner command', which: 'resume' },
  inboxResume: { who: 'Inbox action', which: 'resume_job' },
  transientRule: { who: 'Foreman rule', which: 'resumeTransient' },
  autoRestart: { who: 'worker recovery', which: 'auto-restart after a usage limit' },
});

// How an event's stored cause is shown (job outcome): an event from before this record existed says so.
export const shownCause = c => (c && typeof c.who === 'string' && typeof c.which === 'string' ? { who: c.who.slice(0, 40), which: c.which.slice(0, 80) } : { who: 'cause not recorded', which: 'cause not recorded' });

// Why the transient rule leaves a rebase alone: its record holds a refusal or an agent stop, and a retry ends the same way.
export const refusedRebaseWhy = reason => `the rebase ended with a recorded ${reason === 'agent-stop' ? 'agent stop' : 'refusal'} (${String(reason).slice(0, 40)}); a retry gives the same result`;
