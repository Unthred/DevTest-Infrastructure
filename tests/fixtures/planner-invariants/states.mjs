const head = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];

const issue = (number, agent, labels = []) => ({
  number,
  title: `Issue ${number}`,
  state: 'OPEN',
  body: '',
  labels,
  agent,
});

const pull = (number, agent, issueNumber, extra = {}) => ({
  number,
  title: `PR ${number}`,
  headRefName: `${agent}/issue-${issueNumber}-fixture`,
  headRefOid: head(number),
  baseRefName: 'main',
  isDraft: false,
  mergeable: 'MERGEABLE',
  statusCheckRollup: green,
  labels: [],
  ...extra,
});

export const FIXTURE_STATES = [
  {
    name: 'current CHANGES blocks merge',
    pulls: [pull(10, 'claude', 1)],
    issues: [issue(1, 'claude')],
    verdicts: { [`10:${head(10)}`]: { verdict: 'CHANGES', reviewer: 'codex' } },
  },
  {
    name: 'breaker skips a conflicting rebase',
    pulls: [pull(11, 'claude', 1, { mergeable: 'CONFLICTING' })],
    issues: [issue(1, 'claude')],
    breaker: {
      halts: {
        'rebase:failed': { cause: 'rebase:failed', types: ['rebase'], subjects: ['pr:11'] },
      },
    },
  },
  {
    name: 'parked issue is not implemented',
    pulls: [],
    issues: [issue(1, 'claude', ['parked'])],
  },
  {
    name: 'unavailable agent receives no action',
    pulls: [],
    issues: [issue(1, 'claude'), issue(2, 'codex')],
    unavailableAgents: ['codex'],
  },
  {
    name: 'one merge action is emitted for one eligible PR',
    pulls: [pull(12, 'claude', 1)],
    issues: [issue(1, 'claude')],
    verdicts: { [`12:${head(12)}`]: { verdict: 'PASS', reviewer: 'codex', job: 'fixture-review' } },
  },
];

export const COMBINATION_SEED = 1110;

const next = seed => (seed * 1664525 + 1013904223) >>> 0;

export function seededStates({ seed = COMBINATION_SEED, count = 128 } = {}) {
  let value = seed;
  const states = [];
  for (let index = 0; index < count; index++) {
    value = next(value);
    const flags = value;
    const hasClaudePull = !!(flags & 4);
    const hasCodexPull = !!(flags & 8);
    const issues = [
      issue(1, 'claude', flags & 1 && !hasClaudePull ? ['parked'] : []),
      issue(2, 'codex', flags & 2 && !hasCodexPull ? ['parked'] : []),
    ];
    const pulls = [];
    const verdicts = {};
    for (const [number, agent, issueNumber, enabled] of [
      [20, 'claude', 1, hasClaudePull],
      [21, 'codex', 2, hasCodexPull],
    ]) {
      if (!enabled) continue;
      const conflicting = !!(flags & (number === 20 ? 16 : 32));
      const currentVerdict = flags & (number === 20 ? 64 : 128) ? 'CHANGES' : null;
      // A conflicting PR with CHANGES is a documented V2 gap, so this bounded generator does not claim it is safe yet.
      const verdict = conflicting && currentVerdict === 'CHANGES' ? null : currentVerdict;
      pulls.push(pull(number, agent, issueNumber, { mergeable: conflicting ? 'CONFLICTING' : 'MERGEABLE' }));
      if (verdict) verdicts[`${number}:${head(number)}`] = { verdict, reviewer: agent === 'claude' ? 'codex' : 'claude' };
    }
    const breaker = flags & 256 ? {
      halts: {
        'fix:failed': { cause: 'fix:failed', types: ['fix'], subjects: ['pr:20'] },
      },
    } : undefined;
    states.push({ name: `seeded-${index}`, seed, pulls, issues, verdicts, breaker });
  }
  return states;
}
