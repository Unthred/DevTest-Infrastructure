// The provider role a job kind occupies: implement, continue, fix, cifix -> implementer; review -> reviewer; rebase -> rebaser.
// Kept apart from team.mjs so the direct controls (issue #1164) can use it without importing the Team.
export const roleOfType = type => (type === 'review' ? 'reviewer' : type === 'rebase' ? 'rebaser' : type === 'inbox' ? 'inbox' : 'implementer');
