# Self upgrade: a commit the install tests refuse (issue #1368)

The supervisor installs main after a reviewed merge. The installer runs the validator and the tests first. When they refuse a commit, only that commit is blocked: nothing is rolled back and no latch is set. The rules below decide how often the commit is tried again and when the homeowner is asked.

## Attempts

- A commit refused by the validator or the tests gets **up to three further attempts**, so at most **four refused attempts** in total.
- A further attempt starts **at least 10 minutes** after the previous one, and only on one of these:
  - **A job end.** A job has ended since the previous attempt and no job is running now (the host is at its quietest).
  - **The 30 minute fallback.** 30 minutes have passed since the previous attempt and no job end started one (`PRECHECK_RETRY_MS` in `supervisor/upgrade.mjs`).
  - **The retry control** (below).
- Only a refusal by the validator or the tests counts. An environmental failure (clone, fetch, GitHub unreachable) keeps its own backoff and is never an attempt.
- Each refused attempt is one record in the install history (`team/upgrades.jsonl`, shown by `GET /api/v1/installs`) with its `attempt` number, and the install status carries the same number.
- When main moves, or the commit installs, the count starts again.

## The Needs you item

After the fourth refusal Foreman makes no further attempt for that commit and raises **one** Needs you item, `upgrade-blocked`, of attention class **fault**. It names the failing tests, says how many attempts were made and when, and offers one control, **Retry install now**. It clears by itself when the commit installs or main moves to a commit that installs.

Until then nothing appears: a commit that installs on a later attempt never raises the item.

## The control

`upgrade.retry_install` (`POST /api/v1/commands/upgrade.retry_install`, listed by `GET /api/v1/meta`) takes no input. It is audited like every command. It refuses with `nothing_blocked` when no install is blocked, and with `install_running` while an install step holds `upgrade.lock`. Otherwise it sets the request that `ai-supervisor self-upgrade install-now` sets (the next install skips its wait), marks the blocked commit for one attempt, and wakes the tick. The next tick makes exactly one attempt; if that attempt is refused as well, the item stays and the control may be used again.
