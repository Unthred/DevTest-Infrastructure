# 01. Information architecture

## 1. Shape

Three fixed layers sit above every screen, in this order, and never move:

1. **App bar** (one line): system state, one item per agent, live indicator. Read model: `appbar`.
2. **Banner zone**: empty when healthy. Holds, at most, the stale data banner, the "connection is behind" banner, and the stalled banner. They show on every screen, so a stall cannot be missed by being on the wrong tab.
3. **Screen**: one of the screens below. Any item on any screen opens the **side panel** (a drawer on desktop, a full screen sheet on phone) with everything known about it and every control that applies.

Navigation is a rail on desktop (≥ 761 px) and a bottom tab bar on phone. The same six destinations in both; counts on the tabs are links to the filtered list.

```
App bar      [state] [agent · wk% · 5h%] [agent · wk% · 5h%]            [live]
Banner zone  (stalled / stale / behind, only when true)
Rail/Tabs    Overview · Queue · Inbox · Jobs · Allowance · Audit · (System · Reports, later)
Screen       ...                                             | Side panel
```

## 2. Screen inventory

| Screen | Read model | Prototype | Questions it answers |
|---|---|---|---|
| App bar (all screens) | `appbar` | yes | Is it working? Can each agent work (weekly %, 5 hour %, how old is the reading)? Is this picture live? |
| Stalled banner (all screens) | `overview.stalls` | yes | Why is nothing running? Which agent, for how long, what is planned, what holds each action, what can I press? |
| Overview | `overview` | yes | What needs me? What is wrong? What runs next and why not yet? How did the last 24 hours go (first pass rate, merges)? Where was allowance wasted? |
| Queue | `queue`, `work_item` | yes (table, board) | Where is every issue and PR? Rank, stage, agent, prerequisites, why held or skipped, estimated start. Which PRs are stuck? |
| Work item panel | `work_item` | yes | Everything about one item: state and reason, controls, requirements table, expected files, checks, review rounds and findings, fix rounds against the limit, rebase attempts and cap, split, decision proposal, jobs, timeline. |
| Inbox | `inbox` | yes (cards, table, list) | What waits for my approval? What became of what I approved? What failed or was refused and why? |
| Jobs | `jobs` | yes | Every job: kind, agent, model, cause, tokens, cost, duration, transcript, and what can be done with it. |
| Allowance | `allowance` | yes | Per agent: weekly and 5 hour windows, reading age, scheduling mode, projection. Limit resets and advice. The credit agent. Waste by cause. |
| Audit | `audit` | yes | What did the overseer (or I) change, why, with what result? What can be undone? Is direct control on? |
| System | `decisions`, `incidents`, `installs`, `host` | no (specified) | Decision register and proposals. Breaker halts by cause and who can resume. Installed version, install history, live checks, the upgrade latch. Disk, memory, swap holds. |
| Reports | `reports`, `notifications` | no (specified) | Reports and digests the overseer wrote (complete or not), post mortems, alerts sent and whether they were delivered. |

## 3. How screens link

Every number is a link to the list behind it, with the filter applied (the link is the filter, so it can be bookmarked and shared with the overseer as a path).

| From | To |
|---|---|
| App bar state chip | Overview |
| App bar agent chip | Popover (windows, reading age, roles), then Allowance |
| Tab count "Inbox 12" | Inbox filtered to waiting for approval |
| Overview "12 Inbox items wait" | `#/inbox?state=waiting_for_approval` |
| Overview fault "Rebase jobs wasted 67.1M tokens" | `#/jobs?kind=rebase&cause=rebase_refused_lost_changes` |
| Overview pipeline chip "Fixing 4" | `#/queue?stage=fixing` |
| Overview waste tile | Jobs filtered by the top cause |
| Stalled banner planned action | Work item panel for that PR |
| Queue row or board tile | Work item panel |
| Work item panel job | Job panel |
| Job panel target | Work item panel |
| Inbox item with a job | Job panel |
| Allowance waste row | Jobs filtered by that cause |
| Audit row | Audit entry panel (input, before, after, undo) |
| Any id chip | Copies the 8 character id |

## 4. What goes where: faults, waits and everything else

| Class (from `condition.attention`) | Where it shows | Never |
|---|---|---|
| `homeowner` | Overview "Needs you", Inbox default view, tab counts in the "you" style | In the Faults list |
| `fault` | Stalled banner (if it stops work), Overview "Faults", the item's own row | In "Needs you", or as an info line |
| `unknown` | On the figure itself (marker, age), stale banner if it affects everything | As zero, as "OK", or silently |
| `none` | Only in lists and panels | On the Overview as a card |

The rule for the Overview: an item appears there only if it has `attention` of `homeowner` or `fault`. A homeowner item must have a usable control, a stated step, or a list behind its count; otherwise the contract tests fail and it does not ship.

## 5. Coverage of the sixteen workflows

| # | Workflow | Screen | States (named values) | Failure and its control |
|---|---|---|---|---|
| 1 | Intake and planning | Queue | `queued`, `held` (`prerequisite_open`, `malformed_prerequisite_line`, `finish_before_starting`, `file_overlap_hold`), `parked` | Malformed line: fault with "Fix prerequisites" (`work_item.edit_prerequisites`). Wrong order: `work_item.set_rank`. Wrong agent: `work_item.assign`. |
| 2 | Implement | Work item panel | stage `implementing`; requirements `met`, `not_met`, `pending`; checks `passing`, `failing`, `pending` | Failing checks or unmet rows are shown per row; `job.stop`, `job.resume`. |
| 3 | Review | Work item panel, Overview headline | verdict `pass`, `changes`; findings with `blocking` and `scope` | Refused verdict (independence): fault with `work_item.new_review_attempt`. First pass rate links to the reviewed changes. |
| 4 | Fix rounds and the limit | Overview "Needs you", Work item panel | `stuck_at_fix_limit` | Description only finding: `work_item.fix_description`. Otherwise `work_item.accept_split`, `work_item.allow_fix_round`, `work_item.park`. |
| 5 | Rebase | Work item panel, Jobs, Allowance waste | job `failed` with `rebase_refused_lost_changes`; `capped` | `work_item.clear_retry_cap` (homeowner). Repeated refusals appear as waste by cause without asking. |
| 6 | Merge, upgrade, install, verify | System | stages `ready_to_merge`, `merged`, `installed`, `verified`; install `failed`; latch on | Failed verification: fault naming the live check line. Latch: `upgrade.clear_latch`. |
| 7 | Inbox | Inbox | `waiting_for_approval`, `approved`, `running`, `done`, `failed`, `refused`, `rejected` | `inbox.approve`, `reject`, `undo_decision`, `park`, `requeue`, `dismiss`, `bulk_decide`. |
| 8 | Decision register | System, Work item panel | `proposed`, `approved`, `rejected`, `superseded` | `decision.approve`, `decision.reject`; stable key, number only after merge. |
| 9 | Allowance and budget | App bar, Allowance | window `known` or `unknown`; reading `stale`; mode | `agent.refresh_allowance`; `allowance.record_limit_reset`; credit agent state. |
| 10 | Breaker and incidents | Banner zone, System | `clear`, `halted` (by cause) | `breaker.resume` (a person only). History with cost. |
| 11 | Stalls and holds | Banner zone, Overview | `stalled`; hold with `reason_code` or `unrecorded`; `held_by` shows a chain or cycle | `job.start` on a planned action; the control for whatever holds it. |
| 12 | Direct control | Audit | outcome `applied`, `refused`, `undone` | `audit.undo`; `direct_control.set` (the one switch). |
| 13 | Jobs | Jobs, Job panel | `running`, `paused`, `completed`, `failed`, `blocked`, `stopped` | `job.stop`, `job.resume`, `job.close`. |
| 14 | Host health | System, Overview host line | `ok`, hold by measure | Shows the measure, its value and limit; no control beyond freeing space (a homeowner step). |
| 15 | Reports and notifications | Reports | complete or incomplete (finished marker) | An incomplete report is a fault on its Inbox item with `inbox.requeue`. |
| 16 | Homeowner steps | Overview "Needs you" | `waiting_for_homeowner` with `step_text` | `homeowner_step.mark_done`; stays until done. |

## 6. Per viewer layout

- Remembered per viewer: theme, density, the view type per list (cards, table, list), sort, group, saved views.
- Not customisable: the app bar, the banner zone, and the two Overview lists. Nothing important can be hidden.
- Filters set by following a link apply to that visit and are shown as a removable chip, so a filtered list never looks like the whole list.
