# Allowance-aware scheduling (issue #56)

Status: implemented in source on `claude/issue-56-allowance-aware-scheduling`; not deployed (the installed supervisor is not upgraded). Code: `supervisor/budget.mjs` (pure), wired into the dispatcher (`supervisor/team.mjs`), the dashboard view and `team status`.

## What it reads
Only what the dispatcher already has, with no model call and no extra provider call:
- each agent's **latest allowance record** as the provider reported it and a job stored it (5-hour and weekly utilisation, reset times, credits/overage);
- the **dashboard snapshot history** (one reading per tick) for the recent burn rate;
- the supervisor's **job records** (token counts per job) for the cost of one job.

## Weekly burn, per agent and tick
- `used`: the weekly window's utilisation (the most used weekly window if a provider reports several). A reading whose window has already reset no longer counts.
- `rate`: the higher of the window average (`used / hours since the window started`) and the recent rate (rise between readings of the same window over the last `recent_hours`, needing two readings at least 2 h apart).
- `projected = used + rate × hours to reset`; `runsOutAt` when the rate would reach 100 %.
- **Cost of one job** (estimate, used for rule 4 and the reserve): the median rise in weekly use per token between consecutive job readings in this window, times the median tokens of the last ten jobs of that kind. Interactive use in between also counts, so the estimate is high, not low. With fewer than two samples the cost is *unknown*, and an unknown cost never holds a job back.

## Modes
| Mode | When | May start |
|---|---|---|
| `normal` | otherwise | every job type |
| `reviews_only` | `projected > projected_limit` (runs out before its reset at the current rate), **or** `used ≥ high_water` (85 %) with more than `high_water_min_hours` (24 h) to the reset | reviews and fixes on its own PRs: `review`, `fix`, `cifix`, `rebase`. No `implement`, no `continue` |
| `waiting` | a weekly or 5-hour window is used up (`≥ exhausted_at`), the provider reports the limit reached, or the provider reports **paid overage in use** | nothing; waits for the reset |

- **A reported limit counts without numbers.** "The provider reports the limit reached" means an exhausted status (`rejected`, `blocked`, `exhausted`, `limit_reached`) on the record or on any window, whether or not a window carries a numeric reading — the same evidence `allowance.mjs` treats as a usage limit. It waits until the latest reported reset time still ahead. If every reported reset time has passed, the limit has reset. With no reset time at all, it waits one hour from the reading (D-019's first conservative wait); the next launch then takes a fresh reading.
- **Hold until the reset.** Once an agent is `reviews_only` in a weekly window it stays so until that window resets, even if the projection improves. This stops it flapping and matches "when the allowance resets, ownership goes back".
- **Never overage or credits.** Nothing here enables overage or spends credits. Credits being available does not count as headroom. An agent with nothing left waits.
- **Rule 4.** A job whose estimated cost would take the agent to the weekly limit is not started; the planner falls through to a smaller job type (for example a review instead of an implementation), and if none fits, nothing starts. This is stricter than "if a smaller job is available": nothing knowingly runs into the limit.
- **Reserve for owed reviews.** Every non-review job must also leave room for the opposite-agent reviews still owed by this agent (open, non-draft PRs of other agents without its verdict on the current head), at the estimated review cost each. Reviews draw on that reserve.

## Reassignment
- When an agent is `reviews_only` or `waiting`, its **unstarted, unblocked implementation issues** go to an agent that is `normal`, whose weekly use is **known** (no proven headroom, no takeover) and whose role allows it (`budget.can_take_over`, default: every agent). The taker's own issues come first.
- The issue **keeps its owner** in `team.json` and on GitHub; the dispatcher changes no labels. The work runs on the taker's branch (`<taker>/issue-<n>-…`), so the owner (the opposite agent) reviews it and D-011 holds. The job prompt says so. The taker may continue its own draft of such an issue; the owner never continues another agent's branch.
- **Drafts are not reassigned**: a draft stays with its branch's author (another agent continuing it would later review its own work).
- When the owner's window resets, it is `normal` again and implements its own remaining issues; work already started by the taker stays with the taker's PR.
- **Ownership is a preference, not a lock (issue #104).** "Out" also covers an owner whose latest supervised job paused on a usage limit or whose provider reports a used-up window, even when its mode is still `normal`. Prerequisites owned by the out agent move the same way, so the queue behind them unblocks. A `reviews_only` or `waiting` taker takes nothing. Ready means open, prerequisites closed, not `needs-homeowner`, no PR (draft or not), no started or running job. One taker per issue per plan. The queue says "taken from X by Y: X has no allowance until …". Only issues an agent owns in the team config move this way; an issue no agent owns is never dispatched.
- Reviews stay opposite-agent. A reviewer that is `waiting` reviews nothing; the implementer keeps working on its other unblocked items.

## Cheaper re-reviews
Fix-round re-reviews are diff-scoped (#45). When the reviewer is low (not `normal`, or weekly use at or above `models.allowance_threshold`), a re-review uses the agent's `low` entry in the `models` table when one is configured (shipped: Claude `sonnet`/`low`, Codex effort `low`); a full review keeps the `review` entry. While low, escalation to the strong model is suppressed. See [model-routing.md](model-routing.md).

## Visibility
- `team status` has an **Allowance** section, for example `codex: reviews only until Wed 07:18 — weekly 92%, projected 184% at reset (3.5 days left, window average): runs out before the reset at the current rate`, and marks a planned job `(reassigned from codex for allowance)`.
- Dashboard: the Agents page and the Usage page show each agent's mode, the reason, the weekly projection and what is held back; the Next panel and the issue queue say "reassigned for allowance"; the jobs tables have a *Reassigned from* column.
- **Alerts**: one alert per mode change (`Allowance: <line>`), recorded as sent only when the channel accepted it, so a failed delivery is retried on the next tick. An agent's first `normal` reading is not announced.
- `team tick --dry-run` and the dashboard plan with the same modes but never record a change or alert.

## Configuration
`supervisor/team.json` → `budget` (each key optional; `team.local.json` may override any of them):

| Key | Shipped | Meaning |
|---|---|---|
| `enabled` | `true` | `false` makes every agent `normal` |
| `projected_limit` | `1` | projected weekly use at reset above which an agent is `reviews_only` (e.g. `0.9` for a 10 % margin) |
| `high_water` | `0.85` | weekly use at or above which … |
| `high_water_min_hours` | `24` | … with more than this many hours to the reset makes it `reviews_only` |
| `recent_hours` | `24` | readings used for the recent rate |
| `exhausted_at` | `0.995` | a window at or above this is used up (`waiting`) |
| `can_take_over` | `["claude", "codex"]` | agents whose role allows taking another agent's implementation work |

Unknown keys or out-of-range values make the tick fail closed, naming the key.

## Limits of the evidence
- The figures are the providers' own readings, as fresh as the newest job that recorded them. An agent that runs nothing reports nothing new; the homeowner's interactive use between readings is not seen until the next reading.
- The per-job cost is an estimate (see above). The exhausted-state allowance values are still not captured live (#15, D-019), so `waiting` on a reported limit relies on the same unverified shapes as `allowance.mjs`.
- Read-only check on Tower, 2026-10-31, against the real state root: Claude weekly 60 % with 4.6 days left and Codex 96 % with 3.8 days left both project above 100 % at reset, so with the shipped settings both would be `reviews_only` and no new implementation would start until a reset (reviews and own-PR fixes continue). The homeowner may prefer a different `projected_limit`.
