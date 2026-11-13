# 04. The Foreman contract, version 1

This is the UI neutral contract between the headless Foreman core and every client: the web UI, a phone app, a terminal program, a wall display, and the MCP server the overseer uses. The first web UI in `prototype/` is one client of it. `prototype-terminal/` is a second one that shares no code with the first.

Every statement about how Foreman works today is marked **observed** (read in code or docs at commit `82806c9`, 12 Nov 2026) or **inferred**.

## 1. Rules of the contract

1. **Three parts.** Queries (read models, `GET /api/v1/...`), commands (`POST /api/v1/commands/{name}`), events (`GET /api/v1/events`, server sent events).
2. **No presentation in the data.** No HTML, no colours, no CSS classes, no icons, no pre-formatted times or money. The client formats.
3. **Raw values with units in the field name.** `*_at` is a UTC ISO 8601 timestamp ending in `Z`. `*_seconds` is a whole number of seconds. `*_fraction` is 0 to 1. `tokens` are whole numbers. `*_pence` is whole pence sterling, with `cost_basis` saying whether it was really billed. The client shows Europe/London time and pounds.
4. **One status language.** Every state is a `condition` object (see `schemas/common.schema.json`):

   | Field | Meaning |
   |---|---|
   | `state` | A named value, for example `running`, `held`, `stalled`, `waiting_for_homeowner`. The vocabulary is listed in the `meta` model with a `group` per state, so a client can draw a state it has never seen. |
   | `attention` | `none`, `homeowner`, `fault` or `unknown`. This is how the core says "this waits for a person by design" versus "this is wrong" versus "I cannot tell". A client never mixes `homeowner` with `fault` and never draws `unknown` as fine. |
   | `reason_code` | A stable machine code, for example `prerequisite_open`, `malformed_prerequisite_line`, `file_overlap_hold`, `unrecorded`. Codes are only ever added within a version. |
   | `reason_text` | The sentence only the core can write. Plain text. |
   | `since` | When the state began, or null. |

   A reason the core did not record is the code `unrecorded`, never an empty value. That makes "Foreman does not know why" a visible fault instead of a blank.
5. **Unknown is a value.** A window, cost or reading the core does not have is `null` with `state: "unknown"` and a reason. It is never `0`.
6. **Every control is data.** An entity carries `actions`: the commands that apply to it now, each with its inputs, its tier, whether it is reversible, and, when it is disabled, the refusal the command would return. A client draws one button per action and never has to work out what is allowed. The contract tests fail a core that lists something under `needs_you` with no enabled action, no step and no list behind it.
7. **Ids.** People see 8 character ids (`id`); the full id is beside it (`full_id`). Commands accept either where it is unambiguous (**observed**: issue #1164 requirement 8).
8. **General nouns.** A `ref` has `kind`, `key`, `label`, `source`, `project`, `url`. Work items are `work_item` (an issue, a ticket, a Home Assistant change) and `change` (a pull request or its equivalent). Agents are rows with an `id`, a `provider` and `roles`. No agent, source or project name appears in the contract or in client logic.

## 2. Envelope

Every read model is wrapped the same way:

```json
{
  "contract": "1.0",
  "model": "appbar",
  "generated_at": "2026-11-12T22:04:00Z",
  "freshness": { "state": "fresh", "tick_at": "2026-11-12T22:00:07Z", "age_seconds": 233, "stale_after_seconds": 600, "reason_code": null, "reason_text": null },
  "cursor": "e-000412",
  "data": { }
}
```

- `freshness` is about the data, not the connection: when the last tick finished and whether that is too old. **Observed** today: `view.freshness` (`supervisor/dashboard.mjs` `freshness()`) and `view.pageData` (`supervisor/dashserver.mjs` `pageData()`: `builtAt`, `ageMs`, `stale`, `behindWrite`, `refreshing`, `failed`). The contract merges them into one object.
- `cursor` is the id of the last event already reflected in the model. A client opens the event stream with it and misses nothing.

## 3. Queries

Legend for "Today": **yes** means the value is served now (file and route named); **partly** means the data exists but in a different shape or as text only; **no** means it is missing, with the backend requirement.

### 3.1 `GET /api/v1/meta` (schema `meta.schema.json`, fixture `fixtures/meta.json`)

What this core offers: the contract version, the read models with their paths and schemas, the state vocabulary with groups, the command catalogue (name, tier, whether a reason is required, undo command, inputs, refusal codes) and the event types. A client can build its whole command layer from it.

| Field | Today |
|---|---|
| `models`, `states`, `events` | no. New: a static table in the core, checked by contract tests. |
| `commands` | partly. **Observed**: the Inbox action table (`supervisor/inbox.mjs` `ACTIONS`, `CONTROLS`), decision card controls (`supervisor/decisiontable.mjs` `CONTROLS`) and the write routes in `supervisor/dashserver.mjs`. There is no single catalogue. |

### 3.2 `GET /api/v1/appbar` (schema `appbar.schema.json`, fixture `fixtures/appbar.json`)

The one line every client shows first. Small on purpose (about 3 KB) so a wall display or watch can poll it alone.

| Field | Today |
|---|---|
| `system` (condition) | partly. **Observed**: `view.health` (`healthOf()` in `supervisor/dashboard.mjs`) gives `needs_you`, `stuck`, `unknown`, `paused`, `running`, `idle` with a label and a severity. Missing: a `stalled` state when slots are idle with planned work, with its reason code. `healthOf` returns `needs_you` before `stuck`, so a stall is hidden behind any waiting card (**observed**, line order in `healthOf`). |
| `counts.needs_you`, `counts.inbox_waiting` | yes. `view.panels.needsYou.length`, `view.panels.inbox` (`/api/view.json`). |
| `counts.faults`, `counts.stalled_agents`, `counts.planned_held` | no. Backend: split attention items by `attention` (3.3) and count idle agents with planned work. |
| `slots` | partly. **Observed**: `view.slots` (`roleSlots()`), `view.capacity`. The total of 4 is a config value. |
| `tick` | yes. `view.nextTick` (`tickCountdown()`: `scheduled`, `starting`, `running`, `overdue`). |
| `agents[].condition` | partly. **Observed**: `view.agents[].state` and `idleReason` as `{ text, links }` (`idleReason()` in `supervisor/dashboard.mjs`). Missing: the reason code. The causes exist as a vocabulary in `supervisor/idlecause.mjs` (`IDLE_CAUSES`, including `unrecorded` and `named-hold`), but the view only carries text. |
| `agents[].weekly`, `short`, `reading` | yes. **Observed**: `allowanceItems(view)` in `supervisor/appbaralloc.mjs` already returns `{ state: known or unknown, used, level, resetsAt }` per window plus `ageMinutes`, `stale`, `maxAgeMinutes`, read from `view.budget[agent].reading`. The contract keeps this shape with unit names. |
| `breaker` | yes. `view.breaker.halt` (`breakerHaltView`). |
| `direct_control` | no. Backend: the switch of issue #1164 requirement 6. |
| `version` | yes. `view.version` (installed, running, main, behind, latched). |

Example (shortened):

```json
"agents": [{ "id": "codex", "display_name": "codex", "provider": "codex", "roles": ["implementer"],
  "condition": { "state": "paused", "attention": "fault", "reason_code": "file_overlap_hold", "reason_text": "Paused with 2 planned actions held by a file overlap hold.", "since": "2026-11-12T18:52:00Z" },
  "weekly": { "state": "known", "used_fraction": 0.31, "level": "normal", "resets_at": "2026-11-16T09:00:00Z", "window_seconds": 604800, "reason_code": null, "reason_text": null },
  "short": { "state": "unknown", "used_fraction": null, "level": null, "resets_at": null, "window_seconds": 18000, "reason_code": "window_expired_no_reading", "reason_text": "5 hour window has reset; no new reading yet" },
  "reading": { "read_at": "2026-11-12T13:02:00Z", "age_seconds": 32520, "stale": true, "max_age_seconds": 3600 }, "running_jobs": 0 }]
```

### 3.3 `GET /api/v1/overview` (schema `overview.schema.json`, fixture `fixtures/overview.json`)

Answers the five second questions: is it working, what needs me, what is stuck and why.

| Field | Today |
|---|---|
| `verdict` | as `appbar.system`. |
| `stalls[]` (agent, `idle_seconds`, condition, planned actions, actions) | partly. **Observed**: `view.agents[].idleReason`, `view.plan`, `view.panels.next` with `why` text from `nextWhyFields()` (`supervisor/holdreason.mjs`: `heldBy`, `reassignReason`), the `foreman-idle` attention item raised after `idle_minutes` (`team.idleItem`, used in `buildView`), and the 24 hour `view.idleCauses` report. Also **observed** (correction, 13 Nov): issue #1223 merged on 12 Nov at 21:49 UTC and is in this commit. `view.planned` is now a ledger (`supervisor/planledger.mjs`): one row per planned action with `outcome` (launched or held), a `kind` from a fixed list (`slot`, `lease`, `overlap`, `allowance`, `reading_stale`, `retry_cap`, `order_guard`, `error`, `breaker`, `upgrade`, `host_pressure`, `admission`, `unexplained`) and the reason text; an action with no reason is `unexplained` and is raised as a Needs you item. So the hold record exists. The contract code `unrecorded` is that kind `unexplained`. Still missing: `since` per hold (kept only for unexplained holds), `held_by` as a structured reference (the overlap text names both sides by number), and the grouping per idle agent. |
| `needs_you[]` and `faults[]` | partly. **Observed**: `view.attention[]` items `{ id, text, ref, severity, action, since }` and the consolidated `view.panels.needsYou` (`consolidateNeedsYou`, `supervisor/needsyou.mjs`); decision rows carry a `card` with controls (`supervisor/decisiontable.mjs`). Severity is `action`, `warning`, `info`; a malformed prerequisite is an info item. Missing: the `attention` class (homeowner or fault), a stable `kind`, and `actions` on every item. Backend: classify each attention id once in one table (id prefix to kind, attention, commands). |
| `needs_you[].step_text` (homeowner steps) | partly. **Observed**: `afterInstallAttention` (`supervisor/afterinstall-view.mjs`) and the `needs-homeowner` label on issues and PRs (`needsHomeowner` on rows). No done control. |
| `slots.by_role` | yes. `view.slots` (`roleSlots()`). |
| `planned[]` | partly, as above (text reason only). |
| `pipeline[]` | partly. Derivable from `view.prs[].status`, `stage`, `view.issues`, `view.queues`; no stage counts are served. |
| `headline` | yes. `view.headline` (`supervisor/headline.mjs`, also MCP `foreman_headline`): windows with first pass figures and merges. |
| `waste` with `top_cause` | partly. **Observed**: `/api/waste.json` (`wasteByCause` in `supervisor/mcpreads.mjs`) gives jobs, tokens and `costGbpEquivalent` per cause and per day. Missing: how many distinct changes a cause hit, and the share. Both are sums over records the core already has (`state.breaker.waste`). |
| `host` | yes. `view.hostPressure` (`hostPressureView`: hold, reason, measures with value, limit, tripped). |

### 3.4 `GET /api/v1/queue` and `GET /api/v1/work-items/{key}` (schemas `queue.schema.json`, `work-item.schema.json`; fixtures `queue.json`, `work-item-change-1192.json`)

Query parameters for the list: `stage`, `attention`, `type`, `agent`, `q`, `sort`, `limit`, `cursor`.

| Field | Today |
|---|---|
| `items[].number`, `title`, `url`, `agent`, labels | yes. `view.issues[]`, `view.prs[]` (`dashExtras()` in `supervisor/dashboard.mjs`); search via `/api/issues.json`. |
| `rank`, `rank_of` | partly. **Observed**: `view.queues` and the review order (MCP `foreman_review_order`); no rank number on the issue row. Backend: the planner's one ranking (D-036) written per item. |
| `stage` | partly. PRs have `status` (draft, open, merged) and `stage` after merge (merged, installed, verified); fixing and rebasing are implied by the plan. |
| `condition` for a held item | partly. `view.issues[].reason` (text from queues or exclusions), `heldIssues()` gives `waits` and `ends` text. Missing: the code. A malformed prerequisite line is detected (`supervisor/dependencies.mjs` `parseDependsOn`, `malformed`) but surfaces as an info item. Backend: `reason_code: malformed_prerequisite_line`, `attention: fault`. |
| `prerequisites` (`line_state`, `raw_line`, `declared`, `open`) | partly. `dependsOn`, `blockedBy` are served; `line_state` and the raw line are not. |
| `estimated_start_at` | yes. `view.estimates` (`estimateQueue`, `supervisor/estimate.mjs`). |
| `change.review_rounds`, `fix_rounds`, `rebase_attempts`, `verdict`, `checks`, `head` | yes. `view.prs[]`: `reviewRounds`, `fixRounds`, `rebaseRounds`, `verdict`, `checks`, `head`. |
| `change.fix_limit` | partly. Config (`limits.max_fix_attempts`, `supervisor/team.json`), not on the row. |
| detail: `reviews[].findings[]` | partly. `view.verdicts[]` has findings as text (first 240 characters, up to 20). Missing: `blocking` and `scope` (code or description only). Backend: keep the structured finding from the verdict file (`contracts/verdict.v1.schema.json`). |
| detail: `requirements[]`, `expected_files[]` | partly. **Observed**: the requirements table is parsed for the PR post condition (`supervisor/requirements-table.mjs`) and files are predicted from the issue text (`supervisor/team.mjs`, overlap hold); neither is served. |
| detail: `rebase.capped`, `cause_code` | partly. Retry caps show as attention items (`stoppedAttention`); rebase refusals are text notices. |
| detail: `split` | partly. `state.splits` with `drafting`, `proposed` (**observed** in `laterOf()`); the park and propose flow is open issue #1240. |
| detail: `decision_proposal.key` and `number` | partly. **Observed**: proposals are found by diffing `docs/DECISIONS.md` between main and the PR head (`pendingProposals()`, `supervisor/decisions.mjs` `proposalsAdded`), so the only identifier is the D number in the PR, which can change (D-040 became D-042). Backend: a stable key per proposal (open issue #1229 makes each proposal its own file; the file name is the key); the register number is assigned at merge and is null until then. |
| detail: `jobs[]`, `timeline[]` | yes. `view.prs[].jobs`, `timeline`; `view.issueTimelines`; MCP `foreman_item_timeline`. |

### 3.5 `GET /api/v1/inbox` and `GET /api/v1/inbox/{id}` (schema `inbox.schema.json`, fixture `inbox.json`, 354 items)

Query parameters: `state`, `kind` (comma separated), `q`, `sort`, `limit`, `cursor`, `detail=1`. `facets` always counts the whole Inbox so filter buttons can show counts.

| Field | Today |
|---|---|
| `id`, `kind`, `title`, `state`, age | yes. `/api/inbox.json` (`supervisor/inbox-api.mjs`): `{ count, cards: [{ id, kind, title, state, ageMinutes }] }`. |
| state names | partly. **Observed** internal states: `pending`, `approved`, `running`, `posting`, `done`, `failed`, `refused`, `rejected` (`supervisor/inbox.mjs`). Contract: `pending` becomes `waiting_for_approval`; `posting` is reported as `running`. |
| `why`, `will_text`, `body_text` | yes for waiting items. `pendingCards()` returns `why`, `will`, `text` (in `view.panels.inbox`). Final items keep only the title (the item file is removed once final). |
| `decided_at`, `undo_until`, `result_text`, `reason_text`, `job_id` | yes. Status records (`decidedAt`, `result`, `reason`, `job`); `decidedCards()` gives `undoUntil` (30 seconds, `UNDO_MS`). |
| `reason_code` | no. Refusal and failure reasons are sentences. Backend: a code beside each reason in `validateItem`, `scan` and `finish`. |
| `kind: decision` | partly. Decision rows come from Needs you items (`toDecisionRows()` in `supervisor/approvals.mjs`), not from the Inbox store; the approvals list merges both. The contract serves them in one list. |
| `facets`, `page` | no. Backend: counts over `allStatuses()`; a cursor. Note **observed**: final items are deleted after 14 days (`LIMITS.keepDays`) and at most 30 can wait at once (`LIMITS.pending`). |
| `parked`, `actions` | no. Open issue #1218. |

### 3.6 `GET /api/v1/jobs`, `GET /api/v1/jobs/{id}`, `GET /api/v1/jobs/{id}/transcript` (schema `jobs.schema.json`, fixture `jobs.json`)

| Field | Today |
|---|---|
| `id`, `full_id`, `kind`, `agent`, `model`, `effort`, status, `attempts`, `started_at`, duration, `has_transcript` | yes. `view.jobs[]` (300 newest) and `view.olderJobs[]` (2,000 more), rows built by `rowOf()` in `dashExtras()`. |
| `role` | yes for running jobs (`view.agents[].jobs[].role`), derivable from kind for the rest. |
| `tokens` | yes. `tokens`, `inTokens`, `outTokens`. |
| `cost_pence`, `cost_basis` | partly. `cost` is `usage.costUsdEstimate` in US dollars; the rate is `view.display.gbpPerUsd` (default 0.75, `supervisor/money.mjs`). Contract: pence, converted in the core, labelled usage equivalent or billed. |
| `cause_code`, `cause_text` | partly. **Observed**: the cause exists (`incompleteReason.cause`, `stopKey()` in `supervisor/failcause.mjs`; `/api/jobs/{id}/outcome.json`; `/api/failure-causes.json`) but is not on the job row. Backend: add it to the row. |
| `trigger` | partly. Pass triggers are recorded per tick (`PASS_TRIGGERS` in `supervisor/idlecause.mjs`: schedule, job-end, install, inbox, approve), not per job. |
| transcript | yes. `/api/jobs/{id}/transcript.json` and the live stream `/api/jobs/{id}/events` (full 32 character id only today). |
| `actions` | no. Stop, resume and close exist as Inbox actions and controls; not attached to the row. |

### 3.7 `GET /api/v1/allowance` (schema `allowance.schema.json`, fixture `allowance.json`)

| Field | Today |
|---|---|
| per agent windows and reading | yes, as 3.2. |
| `mode`, `mode_reason_text`, `projected_fraction`, `runs_out_at` | yes. `view.budget[agent]` (`budgetView()` in `supervisor/budgetview.mjs`): `mode`, `reason`, `projected`, `runsOutAt`, `ratePerHour`, `capacity`. |
| `limit_resets[]` with advice | yes. `withLimitResets()` (`supervisor/resetsentries.mjs`, `supervisor/resetsview.mjs` `helpsForeman`) adds them to the view; written by `POST /limit-resets`. |
| `credit` (monthly credit agent) | no. Issue #1140 is parked; `view.budget[agent].creditsAvailable` exists. |
| `waste.by_cause[]` | partly, as 3.3. |
| `currency` | yes. `view.display.gbpPerUsd`. |

### 3.8 `GET /api/v1/audit` (schema `audit.schema.json`, fixture `audit.json`)

Every command from every client, applied or refused, with actor, client, target, input, reason, before, after, outcome and its undo.

| Field | Today |
|---|---|
| control records (who, when, why, result) | partly. **Observed**: `controls` on `/api/view.json` (`controlRecords()` in `supervisor/controlactions.mjs`): `{ id, action, target, by, reason, state, changed, at, result }` for park and stop_job only. The Inbox audit log (`<inbox>/audit.jsonl`) records time, id, event, kind and a content hash, never content. |
| `before`, `after`, `undo`, homeowner actions, refusals | no. Backend: issue #1164 requirement 2 (audit trail with before and after state) and requirement 5 (undo). |
| `direct_control` switch | no. Issue #1164 requirement 6. |

### 3.9 Read models specified here, with schemas still to write (build plan items 15 to 19)

| Model and path | Contents | Today |
|---|---|---|
| `decisions` `/api/v1/decisions` | Register entries: `key`, `number`, `title`, `state` (proposed, approved, rejected, superseded), `superseded_by`, the change that proposes it, `actions`. | partly. `docs/DECISIONS.md` parsed by `supervisor/decisions.mjs` `parseRegister`; `pendingProposals()`. |
| `incidents` `/api/v1/incidents` | Breaker halts now (cause, scope, subjects, cost in pence, who can resume) and history; post mortems. | yes. `view.breaker`, `/api/breaker.json`, `/api/failure-causes.json`, `view.robustness`. |
| `installs` `/api/v1/installs` | Installed, running and main versions; each install with result; live check results per merged change; the upgrade latch with its reason; refusals. | yes. `/api/installs.json`, `view.version`, the latch and refusal attention items in `buildView`, `supervisor/livechecks.mjs`, `afterinstall` records. |
| `host` `/api/v1/host` | Disk, memory, swap measures with value, limit, tripped; holds; recorder samples. | yes. `view.hostPressure`, `/api/diagnostics.json`, the Health page data (`healthData()` in `supervisor/dashserver.mjs`). |
| `reports` `/api/v1/reports` | Reports and digests: name, size in bytes, saved at, complete (finished marker present), the Inbox item that produced it. | partly. **Observed**: the MCP reads the reports folder itself (`foreman-mcp/reports.mjs`); the dashboard does not serve it. |
| `notifications` `/api/v1/notifications` | Alerts sent to the homeowner: time, text, delivered or failed, the item they concern, read marker. | yes. `/api/alerts.json` (`supervisor/alertsview.mjs`), `view.since`, `POST /mark-read`. |
| `ticks` `/api/v1/ticks` | Recent ticks with trigger, duration, warnings, what each started or held. | yes. `/api/ticks.json`. |
| `config` `/api/v1/config` | Effective configuration, redacted. | yes. `/api/config.json`. |

## 4. Commands

`POST /api/v1/commands/{name}` with the body of `schemas/command-request.schema.json`:

```json
{ "input": { "key": "issue-1185", "prerequisites": [1156] }, "reason": "The line was inside a sentence.", "idempotency_key": "9b2f6c1e7a504d3fb1c2", "expected": null, "dry_run": false }
```

The reply always has the shape of `schemas/command-result.schema.json`:

```json
{ "ok": true, "command": "work_item.edit_prerequisites", "outcome": "applied", "audit_id": "d03e8c41", "refusal_code": null, "refusal_text": null,
  "result": { "target": { "kind": "work_item", "key": "issue-1185", "label": "#1185" }, "condition": { "state": "queued", "attention": "none", "reason_code": null, "reason_text": null, "since": "2026-11-12T22:06:10Z" } },
  "undo": { "command": "work_item.edit_prerequisites", "input": { "key": "issue-1185", "raw_line": "V2 item 36. Decision cards. Depends on: #1156. Related: #1169." }, "until": null }, "cursor": "e-000431" }
```

Rules, modelled on the direct control design (**observed**: issue #1164 requirements 1 to 8; D-038 in `docs/DECISIONS.md` for park and stop without a click; D-031 and D-029 for the Inbox and write protection):

- **One named command per control.** No free form command, path or argument (**observed** rule for Inbox actions in `supervisor/inbox.mjs`).
- **Actor.** The core derives the actor from the credential, never from the body: the dashboard access proof is the homeowner, the MCP account is the overseer, the core itself is `foreman`.
- **Tiers.**
  - `direct`: the overseer may run it while direct control is on, with a reason. Acts only on work already queued or running.
  - `approval`: the overseer may only propose it (it becomes an Inbox item); the homeowner runs it directly.
  - `person_only`: needs a person's click (**observed** for the breaker: `POST /breaker-resume` checks same origin user click markers and refuses supervised processes, D-034).
- **Validation and refusal.** A refusal changes nothing, returns HTTP 409 with `refusal_code` and `refusal_text`, and is audited. Codes common to all commands: `unknown_command`, `malformed_request`, `missing_input`, `reason_required`, `needs_homeowner`, `direct_control_off`, `stale_view`, `cooldown`, `unreachable`.
- **Idempotent.** The same `idempotency_key` returns the first result. A command whose target is already in the wanted state returns `no_change` (**observed** behaviour of park in `supervisor/controlactions.mjs`).
- **Outcome.** `applied` (done now), `accepted` (recorded; the next tick applies it, as the Inbox and breaker requests work today), `no_change`, `refused`.
- **Resulting state.** The reply carries the entity's new `condition`, so a client updates in place with no reload and no refetch.
- **Audit.** Every command, applied or refused, writes one audit entry (3.8).
- **Undo.** A reversible command returns its undo command with inputs and a time limit where there is one. `audit.undo` reverses any audit entry that is still reversible and refuses with `state_moved_on` when the entity has changed since.
- **Limits that no command can cross** (**observed**, #1164 requirement 7): no command widens a limit, bypasses a review gate, or lets a proposer approve its own proposal.

### Command catalogue

The machine readable catalogue is `fixtures/meta.json` (`data.commands`, 42 commands), with inputs and refusal codes per command and where each exists today. Summary:

| Command | Tier | Reason | Undo | Today |
|---|---|---|---|---|
| `inbox.approve`, `inbox.reject` | person_only | no | `inbox.undo_decision` (30 s) | yes: `POST /inbox` (`decide()` in `supervisor/inbox.mjs`) |
| `inbox.undo_decision` | person_only | no | none | yes: `POST /inbox` decision=undo |
| `inbox.bulk_decide` | person_only | no | per item | partly: Approve all sends one request per item (`approveAllIds`) |
| `inbox.requeue`, `inbox.park`, `inbox.unpark`, `inbox.dismiss` | person_only | no | park and unpark undo each other | no (open issue #1218) |
| `inbox.propose` | direct | yes | `inbox.withdraw` | yes: MCP `foreman_propose` |
| `inbox.withdraw` | direct | yes | none | no (parked issue #1141, superseded by #1164) |
| `work_item.park` | direct | yes | `work_item.unpark` | yes: control item `park` (D-038) |
| `work_item.unpark` | direct | yes | `work_item.park` | partly: an approved action today; direct under #1164 |
| `work_item.set_rank`, `set_priority`, `assign`, `edit_prerequisites`, `remove_from_queue` | direct | yes | the same command with the old value | no (#1164) |
| `work_item.requeue` | approval | yes | none | yes: Inbox action `reopen` |
| `work_item.clear_retry_cap`, `new_review_attempt` | approval | yes | none | yes: Inbox actions |
| `work_item.allow_fix_round` | approval | yes | none | partly: decision card control; open issue #1157 |
| `work_item.fix_description` | approval | yes | none | no (open issue #1226) |
| `work_item.accept_split`, `reject_split` | approval | no | none | no (open issue #1240) |
| `job.start` (a planned action only), `job.pause` | direct | yes | `job.stop`, `job.resume` | no (#1164) |
| `job.resume` | direct | yes | `job.pause` | partly: Inbox action `resume_job` |
| `job.stop` | direct | yes | `job.resume` | yes: control item `stop_job` |
| `job.close` | approval | yes | none | yes: Inbox action `close_job` |
| `agent.refresh_allowance` | direct | no | none | yes: `POST /probe/{agent}`, 5 minute cooldown |
| `agent.pause`, `agent.resume` | direct | yes | each other | partly: Inbox action `release_agent` |
| `allowance.record_limit_reset` | person_only | no | remove | yes: `POST /limit-resets` |
| `breaker.resume` | person_only | no | none | yes: `POST /breaker-resume` |
| `upgrade.clear_latch` | person_only | yes | none | partly: terminal only; open issue #1160 |
| `decision.approve`, `decision.reject` | person_only | reject only | none | yes: `POST /decision` |
| `homeowner_step.mark_done` | person_only | no | reopen | no |
| `direct_control.set` | person_only | no | itself | no (#1164 requirement 6) |
| `audit.undo` | person_only | no | none | no (#1164 requirement 5) |
| `notifications.mark_read` | person_only | no | none | yes: `POST /mark-read` |
| `viewer.save_view` | person_only | no | delete | no (layouts live in the browser's local storage today) |

The undo commands `allowance.remove_limit_reset`, `homeowner_step.reopen` and `viewer.delete_view` are named in the catalogue and must be added to it before the commands that point at them ship.

## 5. Events

`GET /api/v1/events` is a server sent event stream. Each event's SSE `id` is a monotonic event id, its SSE `event` is the type, and its data matches `schemas/event.schema.json` (examples in `fixtures/events.json`).

| Type | Meaning | Client action |
|---|---|---|
| `hello` | Stream open; says the contract version. | Mark the connection live. |
| `heartbeat` | Every 10 to 15 seconds, with the current `freshness`. | Reset the "behind" timer; update the stale banner. |
| `model_changed` | `models: [...]` changed (for example after a tick). | Refetch only those models; patch rows by key. |
| `entity_changed` | One entity changed; carries its `ref` and new `condition`. | Replace that row or card in place. |
| `command_applied` | A command from any client was applied or refused; carries `actor`, `command`, `audit_id`, `models`. | Refetch the listed models; show "changed by the overseer" where it matters. |
| `freshness_changed` | The data became stale or fresh again. | Show or clear the stale banner. |
| `resync_required` | The client's cursor is older than the server's buffer. | Refetch everything, then continue. |

How a client knows it is behind or the data is stale, three separate signals:

1. **Connection**: no `hello` or `heartbeat` for 35 seconds means the client is behind. It says so and keeps showing the last data, marked.
2. **Cursor**: a reconnect sends `Last-Event-ID`. The core replays what was missed or sends `resync_required`.
3. **Data freshness**: `freshness.state` is `stale` when no tick has finished within `stale_after_seconds`. This is true even on a perfect connection.

**Observed** today: two streams exist. `/api/jobs/{id}/events` streams transcript entries with the entry sequence as the event id, so a reconnect resumes without gaps. `/api/approvals/events` polls every 3 seconds and sends `changed` with a count when the set of waiting ids changes (`supervisor/approvals-stream.mjs`); heartbeat comment every 15 seconds; at most 12 streams (`SSE_MAX_STREAMS`). Pages otherwise poll and swap HTML. The contract keeps the transcript stream as it is (moved to `/api/v1/jobs/{id}/events`) and replaces the approvals stream and the page polling with the one change stream. Backend: the tick and every command append to a small event log in the state root; the stream tails it. The cap on open streams stays.

## 6. Versioning and compatibility

- The major version is in the path (`/api/v1`). Every reply carries `contract: "1.N"` and the header `Foreman-Contract: 1.N`.
- Within a major version changes are additive only: new optional fields, new models, new commands, new event types, new states (each with a `group`), new reason codes. Nothing is renamed, removed or changes meaning.
- Clients must ignore fields, event types and states they do not know, and draw an unknown state by its `group`.
- A breaking change is a new path (`/api/v2`) served beside v1 for at least one installed release, so a client can be swapped without a flag day.
- `GET /api/v1/schemas/{name}.schema.json` serves the JSON Schema for every read model, the command request and result, and the event. The schemas for 1.N are closed (`additionalProperties: false`) so tests catch typos; the schema for 1.N+1 is a superset.
- **Contract tests** (`contract-test.mjs`, and the same checks in the browser at `prototype/contract-check.html`): every read model validates against its schema; the invariants in `schemas/validate.mjs` hold (no dead ends, faults and homeowner waits are not mixed, an unknown window has no figure, an overseer command has a reason, a refusal has a code); every action offered is in the catalogue; a dry run returns a command result; an unknown command and a malformed request are refused. The same file runs against the fixtures, the mock core and the real core, and any client can run it before it trusts a core.

## 7. The MCP server as one more client

**Observed**: `foreman-mcp/` reads `/api/view.json` and the other JSON routes over HTTP GET with a cache (`foreman-mcp/source.mjs`), reshapes them in its own modules (`planview.mjs`, `dependencyview.mjs`, `budgetfigures.mjs`, `insights.mjs` and others), reads the reports folder itself, and writes proposal files into the Inbox `items/` directory (D-031). It has its own prerequisite parser module (`foreman-mcp/dependency-parser.mjs`; **inferred** to duplicate `supervisor/dependencies.mjs`, since the MCP imports nothing from `supervisor/`).

Under the contract the MCP server becomes a thin client: each read tool is one read model, each act tool is one command. What it needs:

| Need | Contract part |
|---|---|
| The same state the homeowner sees, as structured data | Every read model. `foreman_status` is `appbar` plus `overview`; `foreman_plan` and `foreman_why_blocked` are `overview.planned`, `overview.stalls` and `queue`; `foreman_inbox_items` is `inbox`; `foreman_jobs` is `jobs`; `foreman_budget` and `foreman_waste` are `allowance`; `foreman_installs`, `foreman_breaker_history`, `foreman_host`, `foreman_alerts`, `foreman_ticks`, `foreman_config`, `foreman_reports` are the models in 3.9. |
| Never having to dig for why nothing runs | `overview.stalls[]` with `reason_code`, and `unrecorded` when the core has none. The overseer reads the same banner the homeowner sees. |
| Direct control | The `direct` tier commands with a required reason, `direct_control_off` when the switch is off, and `audit` to read its own actions back (#1164 requirements 1, 2, 6). |
| Proposals | `inbox.propose` and `inbox.withdraw`, with refusal codes at submit time instead of a later refused status. |
| Bounded output | `limit` and `cursor` on every list, and a `fields` parameter (a comma separated list of top level `data` fields) so a tool can ask for a small answer. |
| Its own actor | A credential that the core maps to the actor `overseer`. Today the MCP account can only write item files; the contract needs an HTTP credential for it that is refused for `approval` and `person_only` commands. |
| Stable identifiers | 8 character ids accepted everywhere; a decision `key` that does not change. |

What goes away: the MCP's own reshaping of the view, its copy of the parser, and its direct reads of files. One implementation of each rule, in the core.

## 8. Mapping onto what exists

| Today (**observed** in `supervisor/dashserver.mjs`) | Under the contract |
|---|---|
| `GET /api/view.json`: the whole view from `buildView()` in one payload (agents, queues, plan, budget, attention, breaker, usage, graphs, panels, 300 plus 2,000 jobs, PRs, issues, verdicts, supervisor, version) with epoch millisecond times and text reasons | **Changes.** Split into the read models of section 3, each built from the same `buildView()` result by a small pure adapter. Kept unchanged as a legacy route until the MCP and tests have moved, then retired. |
| `GET /api/inbox.json` | **Changes** into `/api/v1/inbox` (adds facets, paging, reasons, actions). |
| `GET /api/jobs/{id}/transcript.json`, `/events`, `/outcome.json` | **Kept**, moved under `/api/v1/jobs/{id}/...`, short ids accepted, outcome merged into the job detail. |
| `GET /api/approvals/events` | **Retired**, replaced by `/api/v1/events`. |
| `GET /api/discarded.json`, `installs.json`, `breaker.json`, `diagnostics.json`, `failure-causes.json`, `waste.json`, `issues.json`, `alerts.json`, `tests.json`, `ticks.json`, `config.json` | **Kept as data**, re-served as the models in 3.7 and 3.9 with the envelope and unit names. |
| `GET /api/next`, `GET /api/processes` (HTML fragments) | **Retired.** `appbar.tick` replaces the first; a `processes` list in the `host` model replaces the second. |
| Page routes rendered by `supervisor/dashrender.mjs` (HTML) | **Retired** once the new UI serves every screen; until then both run side by side (`/` old, `/ui/` new). |
| `POST /inbox` (form or JSON, access proof, cooldown) | **Changes** into `inbox.approve`, `inbox.reject`, `inbox.undo_decision`. |
| `POST /decision` | **Changes** into `decision.*` and the `work_item.*` decision commands. |
| `POST /breaker-resume` | **Changes** into `breaker.resume`, same person only checks. |
| `POST /probe/{agent}` | **Changes** into `agent.refresh_allowance`, same cooldown. |
| `POST /limit-resets` | **Changes** into `allowance.record_limit_reset` and its undo. |
| `POST /mark-read`, `POST /watch` | **Change** into `notifications.mark_read` and `viewer.save_view` (a watch list is a saved view). |
| Inbox `control` items written as files by the MCP (park, stop_job) | **Change** into `work_item.park` and `job.stop` over HTTP with the overseer credential. |
| Host, Origin, access proof, cooldowns (D-029) | **Kept** for every command. The proof moves from a hidden form field to a request header. |
| **Added** | `meta`, `appbar`, `overview`, `queue`, `work-items/{key}`, `audit`, `decisions`, `reports`, `events`, `schemas`, the command endpoint, the catalogue, the audit log with undo, the direct control switch, reason codes, hold records for planned actions. |

## 9. Missing backend, in one list

1. Hold records for planned actions exist since #1223 (`view.planned`); still needed are `since` per hold and a structured `held_by`.
2. Reason codes beside every reason text (idle, held, refused, failed, stopped).
3. An `attention` class and a `kind` on every attention item, and actions on every item.
4. A `stalled` system state that is not hidden by waiting cards.
5. Rank per work item; stage per work item and change.
6. `line_state` and the raw prerequisite line on the item; a malformed line is a fault.
7. Structured findings (`blocking`, `scope`) and the requirements table per change.
8. A stable decision proposal key.
9. Job row: cause code, trigger, cost in pence with its basis.
10. Waste: distinct changes hit and share per cause.
11. Inbox: facets, paging, reason codes, park, requeue, dismiss.
12. The command endpoint, the catalogue, idempotency keys, the audit log with before and after, undo, and the direct control switch.
13. The event log and the change stream.
14. A credential for the MCP account over HTTP, mapped to the actor `overseer`.
15. Reports served by the core.
