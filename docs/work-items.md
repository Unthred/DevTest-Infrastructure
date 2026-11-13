# Work item and pull request format

The one place that states how an issue (a work item) and its pull request are written. Whoever writes an issue, implements it, fixes it or reviews it follows this document, so the rules are the same whichever agent does the work. The issue layout is in [`work-item-template.md`](work-item-template.md); the rules for filling it in are here.

## Acceptance items

- Follow [the dependency declaration format](ai/dependency-format.md) when an issue needs prerequisites. It is the only format Foreman reads.

- Tag every acceptance item as **before PR** (listed under `## Wanted (before the PR)`) or **after install** (listed under `## After install (checked on Tower)`). An implement job can only meet the first kind.
- A check that needs the running system but no credential goes under a `## Live checks` heading, in the lines format `supervisor/livechecks.mjs` reads: `- GET /path -> 200` or `- POST /path -> 403 contains "text"`. A path is relative to the dashboard base URL, with no scheme, host or `..`; at most 10 lines. Foreman runs them after the install that contains the change.
- `Homeowner-only` is only for a credential, an approval or a physical act the agent cannot supply. The row states which one and why. A check that merely needs the installed system is not Homeowner-only: it is After install or a Live check.
- Name the tests. For each acceptance item say which test proves it, including any browser check, and give one real data example (an actual input and the output expected), not a description of one.
- Keep items small. Do not give an item files that another open item also changes; split the work or declare `Depends on:` instead.

## The requirements table in the pull request

- The description carries a `## Requirements check` table with exactly the columns `Requirement | Status | Evidence`.
- One row per acceptance item, and one row per carried follow-up the PR takes on.
- Evidence cites only lines the PR changes (file and line), plus the test or command that proves the row. A citation to a line the PR did not change is a wrong row.
- Check every claim in the description against the diff. Remove or fix a claim the code does not support.

## How the post condition reads the table

`supervisor/requirements-table.mjs` finds the heading `Requirements check` (any heading level, case ignored), reads the first three-column table below it and stops at the next heading. Rules for each row, from `supervisor/requirements-rows.mjs`:

| Status (case ignored, spaces or hyphens) | Accepted when |
|---|---|
| `Met` | Always; the evidence should be a file and line plus a test or command. |
| `Homeowner-only` | The evidence names the required credentials, approval or physical action (the words `credentials`, `approval` or `physical action`). It is refused whatever the evidence says when the requirement text itself has after-install wording (`after install`, `after deploy`, `once installed`): such a check is After install, not Homeowner-only. |
| `After install` | The evidence names who checks it: `homeowner` or `overseer`. It does not fail the post condition and becomes a Needs you step after install. A requirement with after-install wording belongs here. |
| `Not applicable` | Only for a conditional requirement (for example "when #1148 is merged") whose condition is not met. The evidence names the item (`#N`, or `issue`, `PR`, `pull request` or `item` with a number) and says it is `still open` or `not merged` (also `not yet merged`, `not closed`, `not installed`). |

Any other status, an empty cell, a missing heading, a wrong header or a table with no rows leaves the post condition unmet, and the refusal names the row. Items from the before-the-PR list must be `Met`, `Homeowner-only` or, for an unmet condition, `Not applicable`; never mark one After install to avoid finishing it. The rules above are those of `supervisor/requirements-rows.mjs` as of #1177 and #1184; if they change, change this section with them.

### Cite check (issue #1188)

After the shape check, `supervisor/requirements-cites.mjs` checks every Evidence cell against the pull request: a cited file exists in the head, a cited `file:line` is inside a changed hunk (test files are exempt), a named test appears in the cited test file, a cited command is an allowed verification command, and the row count equals the issue's items under Wanted, Requirements, Acceptance, Live checks, Before the PR, After install and Follow-ups. Run `node tools/check-requirement-cites.mjs` as the last step. A failed cite comes back as one list (row, cite, reason) in the same job, limited to 2 repairs, not a fix round, and review waits meanwhile.

## Who follows what

The implement, fix, CI fix and review prompts point at this document. The reviewer checks the pull request against it: a missing, malformed or unsupported row, a citation to an unchanged line, or an after-install item presented as met is a blocking finding.
