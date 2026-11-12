// Issue #1115: foreman_park, foreman_stop_job and foreman_unpark. park and stop_job write a `control` item that Foreman runs without a click
// (they only hold work back or stop a job); unpark writes an ordinary `action` item that waits for the homeowner's approval on the dashboard.
// These handlers write nothing but a proposal file, through the same inbox as foreman_propose; they cannot merge, approve or unpark.
const FINAL = new Set(['done', 'failed', 'refused', 'rejected']);
const REASON = { type: 'string', minLength: 1, maxLength: 300, description: 'why; recorded with who and when' };
const NUMBER = { type: 'integer', minimum: 1, maximum: 999999999 };
const schema = properties => ({ type: 'object', properties, required: [...Object.keys(properties)], additionalProperties: false });
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function controlTools({ inbox, wait = defaultWait, waitMs = 20000 }) {
  // Foreman runs a control item on its next pass (the inbox watcher wakes one). Wait briefly for the result so the overseer sees it at once.
  async function submit(item) {
    const sent = inbox.propose(item);
    const deadline = Date.now() + waitMs;
    for (;;) {
      let s = null;
      try { s = inbox.status(sent.id); } catch { /* not readable yet */ }
      if (s && FINAL.has(s.state)) return { ...sent, state: s.state, result: s.result ?? null, reason: s.state === 'done' ? null : s.reason ?? null };
      if (Date.now() >= deadline) return { ...sent, note: 'Foreman has not run it yet; read the outcome with foreman_proposal_status.' };
      await wait(1000);
    }
  }
  const control = (action, target, reason) => submit({ kind: 'control', title: `${action} ${target}`, action, target, reason });
  return [
    { name: 'foreman_park', description: 'Park one issue or pull request now: Foreman applies the existing parked label and the planner skips it. No click is needed. A running job on it is NOT stopped (the result says so; stop it with foreman_stop_job). An already parked or unknown number is refused or reported as unchanged. Needs a reason. Releasing is foreman_unpark.',
      inputSchema: schema({ number: NUMBER, reason: REASON }), annotations: WRITE, run: a => control('park', String(a.number), a.reason) },
    { name: 'foreman_stop_job', description: 'Stop one job now (the supported stop): it is marked stopped before its worker is signalled, will not restart, and uses no attempt. No click is needed. Give the 8-character job id from foreman_jobs. An already ended job is reported as such. Needs a reason.',
      inputSchema: schema({ id: { type: 'string', pattern: '^[a-f0-9]{8}$' }, reason: REASON }), annotations: WRITE, run: a => control('stop_job', String(a.id), a.reason) },
    { name: 'foreman_unpark', description: 'Ask to release a parked issue or pull request. This cannot release anything itself: it creates an Inbox action item that the homeowner approves with one click on the dashboard. Needs a reason. Read the outcome with foreman_proposal_status.',
      inputSchema: schema({ number: NUMBER, reason: REASON }), annotations: WRITE,
      run: a => { const target = String(a.number); return inbox.propose({ kind: 'action', title: `unpark ${target}`, action: 'unpark', target, reason: a.reason }); } },
    { name: 'foreman_release_agent', description: 'Ask to release an agent parked after an infrastructure fault (see infraFaults.parked in foreman_status), when you judge the cause benign. This cannot release anything itself: it creates an Inbox action item that the homeowner approves on the dashboard. Needs a reason. Read the outcome with foreman_proposal_status.',
      inputSchema: schema({ agent: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,11}$' }, reason: REASON }), annotations: WRITE,
      run: a => inbox.propose({ kind: 'action', title: `release_agent ${a.agent}`, action: 'release_agent', target: String(a.agent), reason: a.reason }) },
  ];
}
const defaultWait = ms => new Promise(r => setTimeout(r, ms));
