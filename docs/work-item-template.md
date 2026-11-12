# Work item template (issue #1177)

Every issue the overseer writes, and every issue an implement job reads, keeps two separate acceptance lists. An implement job can only meet the first; the second can only be checked once the change runs on Tower.

```
Optional prerequisite declaration: follow [the dependency declaration format](ai/dependency-format.md).

## What happened
...

## Wanted (before the PR)
Checks the pull request must meet before it opens. Each becomes one row of the PR's `## Requirements check` table and must be Met, with a file, line and a test or command.
1. ...

## After install (checked on Tower)
Checks that can only be made once the change is installed. Name who checks each one: homeowner or overseer.
1. <check> — After install, checked by: homeowner | overseer

## Tests
...
```

## How the PR table treats the lists

- Rows from "Wanted (before the PR)": status `Met`, or `Homeowner-only` when the evidence states the specific credentials, approval or physical action needed. Anything else keeps the `pr_opened` post condition unmet.
- A conditional row ("when #N is merged") whose condition is not met: status `Not applicable`, with evidence naming the item (for example `#1148`) and saying it is still open or not merged. A row whose condition is met must be `Met`.
- Rows from "After install": status `After install`, with the evidence naming the homeowner or overseer. They do not fail the post condition and they stay visible in the table. A PR whose only unmet rows are After install counts as delivered; no second attempt is spent on formatting.
- After the PR merges and installs, each After install row becomes a homeowner or overseer step that stays in Needs you until done (#1155).
- A refused table names the exact row, the allowed statuses and what to do. It never asks for a post install check to be finished before the PR.
- A second attempt after a post condition refusal starts with the refusal text and is told that finished work stays.

The row rules are in `supervisor/requirements-rows.mjs`.
