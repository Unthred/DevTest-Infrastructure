# Cooperative work protocol (issue #9)

How Claude, Codex and any registered provider (D-012) work in parallel without overwriting each other. It records existing rules (D-011, D-018, D-021, D-023, D-024) and the one new mechanical check, `tools/cooperation.mjs`. It does not change the live launcher: `ai-agent` and `ai-supervisor` are untouched, and any launcher change needs its own reviewed PR.

## Ownership
- **One owner per issue.** An issue is owned by the agent whose open branch or PR names it. A second branch for the same issue is refused.
- **One branch and one worktree per issue** (D-018): branch `<agent>/issue-<n>-<slug>`, worktree `DevTest-Infrastructure-<agent>-<n>` beside the main checkout. The directory name must agree with the branch.
- **One writer per worktree** (D-011). The supervisor enforces it with an exclusive lease on issue and worktree (`docs/supervisor.md`); a lease held by another job is a refusal, never a takeover. Never edit, reset, stash or clean another agent's worktree.
- Git fixtures in tests use independent clones or `git init`, never a linked worktree.

## Dependencies
Do not start an issue whose prerequisites are not closed (the rule the planner applies). The issue's **Prerequisites** line is authoritative; the project board is coordination only.

## Files only one branch may change at a time
Migrations (`supervisor/migrations*`), secret handling (`broker/`, `docs/secrets.md`, key and `.env` files), the image lock (`docker/images.lock.json`), the decision register and the handover. If another open PR already changes one of these files, wait for it to merge, then rebase. The handover is edited on main only (D-023).

## Merges
Only the dispatcher merges, one PR at a time, on the exact reviewed head with green checks. An agent never merges its own or any other PR. Review is by a fresh session on a different model (D-024).

## Check before you push
```
node tools/cooperation.mjs --branch "$(git branch --show-current)" --worktree "$PWD" --base origin/main \
  --others <(gh pr list --state open --json number,headRefName,files)
```
Exit 0: no conflict. Exit 1: findings are printed (bad branch or worktree name, a second owner of the issue, an exclusive file changed by another open PR). Exit 2: usage error or unreadable input; nothing was checked. The check is read-only and sends no secret.

## Before an agent exits
The issue and PR carry the four completion states, exact head SHA, tests run and blockers (PR description or issue comment). The handover file is not touched on the branch; it is updated on main after merge. The worktree is left clean and committed or pushed, and any lease is released by the supervisor once the job is terminal.

## Integration guidance (no live change)
- `AGENTS.md` links this protocol. The supervisor already provides leases, role slots and the merge-by-dispatcher rule.
- To wire the check into the launcher or CI, propose it as a separate reviewed PR; this one only adds the tool and tests.
