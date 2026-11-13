// Issue #1167: the capacity learned for Claude (about 116.6M tokens a week from 2 windows) is far below what the job list implies
// (about 400M, range 280M to 850M). Set the hand-set capacity once, so the budget stops under-counting Claude. The homeowner can change it afterwards;
// a value already set is never touched.
export const description = 'Set budget.capacity for claude to about 400M tokens a week in team.local.json when none is set';
export const CLAUDE_CAPACITY = 400_000_000;

export function migrate(local) {
  if (!local || typeof local !== 'object' || Array.isArray(local)) return local;
  const budget = local.budget && typeof local.budget === 'object' && !Array.isArray(local.budget) ? local.budget : {};
  const capacity = budget.capacity && typeof budget.capacity === 'object' && !Array.isArray(budget.capacity) ? budget.capacity : {};
  if ('claude' in capacity) return local;
  return { ...local, budget: { ...budget, capacity: { ...capacity, claude: CLAUDE_CAPACITY } } };
}
