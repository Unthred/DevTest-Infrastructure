// Issue #1312: the fixture liveboard model of the browser check, built from the real examples of the issue. step 'first' has three waiting
// entries and one running job; step 'started' has the third waiting entry (review of pull request 1244) running in claude/opus instead.
const known = (used, resetsAt, seconds) => ({ state: 'known', used_fraction: used, level: 'normal', resets_at: resetsAt, window_seconds: seconds, reason_code: null, reason_text: null });
const unknownWindow = { state: 'unknown', used_fraction: null, level: null, resets_at: null, window_seconds: 18000, reason_code: 'window_expired_no_reading', reason_text: '5 hour window has reset' };
const condition = state => ({ state, attention: 'none', reason_code: null, reason_text: null, since: null });
const reading = age => ({ read_at: '2026-11-13T11:00:00Z', age_seconds: age, stale: false, max_age_seconds: 3600 });

const AGENTS = [
  { id: 'claude', display_name: 'claude', condition: condition('idle'), weekly: known(0.14, '2026-11-19T04:00:00Z', 604800), short: known(0.01, '2026-11-13T15:10:00Z', 18000),
    reading: reading(360), out_until: null, out_reason: null },
  { id: 'codex', display_name: 'codex', condition: condition('paused'), weekly: known(0.31, '2026-11-16T09:00:00Z', 604800), short: unknownWindow,
    reading: reading(32520), out_until: '2026-11-12T14:09:00Z', out_reason: 'usage limit' },
];
const LANES = [
  { id: 'claude/sonnet', agent: 'claude', model: 'sonnet', job_types: ['implement'] },
  { id: 'claude/opus', agent: 'claude', model: 'opus', job_types: ['review'] },
  { id: 'codex/gpt-5', agent: 'codex', model: 'gpt-5', job_types: ['implement'] },
];
const landed = (id, lane, type, number, title, laps, box, endedAt, tokens, pence) => ({
  job_id: id, lane_id: lane, job_type: type, number, title, laps, ended_at: endedAt, box, tokens, cost_pence: pence,
});
const LANDED = [
  landed('6ff7be3f', 'claude/opus', 'review', 1244, 'Review of pull request 1244', 1, 'changes_asked', '2026-11-13T08:45:00Z', 5000, 125),
  landed('db849b9f', 'codex/gpt-5', 'implement', 1166, 'Allowance refresh for the planner', 0, 'needs_you', '2026-11-12T14:09:00Z', 900, 12),
  landed('aaaa1307', 'claude/sonnet', 'implement', 1307, 'Outcomes read model', 0, 'to_review', '2026-11-13T09:00:00Z', 1000, 30),
  landed('bbbb1306', 'claude/sonnet', 'implement', 1306, 'Closed issues with no recorded reason', 0, 'needs_you', '2026-11-13T07:00:00Z', null, null),
];
const COUNTS = { merged: 0, passed: 0, to_review: 1, changes_asked: 1, done: 0, out_of_allowance: 0, failed: 0, stopped: 0, needs_you: 2 };
const waiting = (place, number, title, type, tied, held) => ({ place, number, title, job_type: type, tied_agent: tied, held });

export function boardFixture(now, step) {
  const started = ago => new Date(now - ago * 1000).toISOString();
  const queue = [
    waiting(1, 1313, 'Boardmotion', 'implement', 'claude', null),
    waiting(2, 1166, 'Allowance refresh for the planner', 'implement', 'codex', { kind: 'allowance_hold', reason: 'codex is out of allowance until 14:09' }),
    waiting(3, 1244, 'Review of pull request 1244', 'review', null, null),
  ];
  const running = [{ job_id: 'run00001', lane_id: 'claude/sonnet', job_type: 'implement', number: 1312, title: 'Live board screen', laps: 0, started_at: started(60), typical_seconds: 300 }];
  if (step === 'started') {
    queue.pop();
    running.push({ job_id: 'run00002', lane_id: 'claude/opus', job_type: 'review', number: 1244, title: 'Review of pull request 1244', laps: 1, started_at: started(5), typical_seconds: null });
  }
  return { agents: AGENTS, lanes: LANES, waiting: queue, running, landed: LANDED, counts: COUNTS, truncated: false, skipped_jobs: 0 };
}
