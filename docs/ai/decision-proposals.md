# Proposing a decision (issue #1229)

A decision proposal is its own file, so two pull requests that propose different decisions never touch the same file.

## Proposing
- Add `docs/decisions/<issue>-<slug>.md`, for example `docs/decisions/1164-queue-control.md`: the number of the source issue and a short lower-case slug. Do not take a `D-` number and do not edit `docs/DECISIONS.md`: it is frozen, and CI fails a pull request that adds an entry to it.
- The file has a `# Title` heading and exactly one each of these lines: `- Status: agent-proposal`, `- Date: YYYY-MM-DD`, `- Source:`, `- Decision:`, `- Rationale:`, `- Rejected:`, `- Superseded-by: none`. There is no `Number` line.
- Until the homeowner approves it, refer to the decision by its file name without `.md` (`1164-queue-control`) in cards, comments and approval text. That name never changes.
- Never edit `docs/decisions/INDEX.md`; it is generated.

## Approving
- The homeowner comments on the pull request, as the repository owner, a line `homeowner-approval: 1164-queue-control`.
- Every Foreman pass (`supervisor/decisionapprove.mjs`, called from `Team.tickPass`) looks at the proposals on main that are still `agent-proposal`, reads the owner's comments on the open or merged pull requests of their source issue, and for an owner-approved name commits the result to main from a throwaway clone (fast-forward push, never forced) and comments on the approving pull request. A proposal is numbered once it is on main; a failure is recorded as a skipped step and retried on the next pass. The step is the same as running `node tools/decisions.mjs approve 1164-queue-control <comments.json>` by hand (`REPO_OWNER` names the approver); an approval comment with no URL is refused. It sets `Status: homeowner-approved`, appends the approval link to `Source`, assigns the next free D number once (above every number in `docs/DECISIONS.md` and every numbered file) as a `- Number: D-0NN` line, and regenerates `docs/decisions/INDEX.md`. Running it again changes nothing.
- `node tools/decisions.mjs index --check` fails when the index is stale; `node tools/validate-project.mjs` runs the same check.

## What CI and Foreman check
- `tools/ci/validate-decision-status.mjs` applies the register rules to the files: an agent cannot add or change a file to `homeowner-approved` without the owner's recorded approval linked from `Source`, a number is assigned once and never reused, and a file is never deleted.
- The Needs you card for a proposal shows the file name to approve by, never a number.
