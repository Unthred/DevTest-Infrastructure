// Issue #1067: the only coding-standard text carried in agent prompts. Every agent turn re-reads the fixed prompt, so these stay short
// and point at docs/coding-standards.md instead of repeating it.
export const STANDARDS_STEP = 'Run node tools/ci/check-size.mjs and follow docs/coding-standards.md before opening the pull request or pushing a fix.';
export const STANDARDS_BLOCKING = 'new architectural deterioration in the changed code (docs/coding-standards.md; '
  + 'pre-existing debt the change did not worsen is a follow-up, never blocking)';
