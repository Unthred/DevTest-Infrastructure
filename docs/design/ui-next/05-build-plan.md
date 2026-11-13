# 05. Build plan

Twenty two small work items, in the repository work item format (`AGENTS.md` section 2 "Work item format" and `docs/work-item-template.md`, read at commit `82806c9`).

## How to use this plan

- **Order.** Contract first (items 1 to 7), then the app bar, the stalled banner and the Inbox (8 to 12), then the rest (13 to 22).
- **Prerequisites.** These items have no issue numbers yet, and Foreman accepts a prerequisite declaration only as a comma separated list of issue numbers on its own line. So no item body below contains one. The table that follows gives the prerequisites by plan label. When an item is raised, the overseer adds the declaration line with the real numbers of the items already raised, and leaves the line out when there is none.
- **Files.** Each item names only the files it edits, because Foreman reads every path in an item as a claim on that file. New code lives in two new packages, `supervisor/api/` (pure adapters from the existing view to the contract, the router, commands, audit, events) and `supervisor/ui/` (static files for the first client). The router loads every module in `supervisor/api/models/` and `supervisor/api/commands/` by directory listing, so adding a read model or a command adds files and edits no shared table. Only item 1 and item 22 touch the dashboard server file; no item touches the team loop file.
- **After install rows.** Each is checked by the overseer (through the live checks and the MCP) unless the row names the homeowner.
- **Tests.** Unit and contract tests run under `node --test`. Browser tests follow the existing pattern (a `tests/*-browser.mjs` script run by `npm run test:e2e:dashboard` in the pinned Playwright image) against synthetic fixture state.
- **Overlap with open issues** (observed on GitHub, 12 Nov): #1219, #1220, #1221, #1222, #1224 build on the renderer this plan retires and are superseded by items 11, 15, 8, 9 and 14 if the homeowner agrees (brief, question 2). Items 17 and 18 extend #1164 (PR #1192) and must not start until it merges. Item 13 uses #1229 (stable decision keys) and item 5 uses #1240 (split proposals) when they have merged; each has a row that says what happens when they have not.

| Label | Item | Prerequisites (plan labels) |
|---|---|---|
| 1 | Contract router, envelope and meta | none |
| 2 | App bar read model | 1 |
| 3 | Withdrawn (delivered by #1223) | not to be raised |
| 4 | Attention items carry kind, class and controls | 1 |
| 5 | Overview read model with stalls | 2, 4 |
| 6 | Change stream | 1 |
| 7 | Command endpoint, audit log and Inbox decisions | 1, 6 |
| 8 | Web shell and one line app bar | 2, 6 |
| 9 | Stalled banner and Overview screen | 5, 8 |
| 10 | Inbox read model | 1 |
| 11 | Inbox screen | 7, 8, 10 |
| 12 | Inbox park, requeue, dismiss and bulk | 7, 10 |
| 13 | Queue and work item read models | 4 |
| 14 | Queue screen and side panel | 8, 13 |
| 15 | Jobs read model and screen | 8 |
| 16 | Allowance read model and screen | 2, 8 |
| 17 | Queue commands with undo | 7, 13, and #1164 merged |
| 18 | Audit screen and the direct control switch | 8, 17 |
| 19 | Decisions, incidents and installs | 4, 8 |
| 20 | Host, reports and notifications | 8 |
| 21 | MCP server reads the contract | 5, 10, 13 |
| 22 | New UI becomes the default | 9, 11, 14, 15, 16, 18 |

---

## Item 1. Contract router with envelope, meta model and schema serving Contractbase

### What happened
Every client reads one large view and reshapes it. There is no versioned contract, so a second interface cannot be built and the overseer sees a different shape from the homeowner.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | A router answers every path under `/api/v1/` and is mounted by one delegation line in the dashboard server; all other routes behave as before. | before PR |
| 2 | The router loads read model modules from `supervisor/api/models/` by directory listing; a module exports `name`, `path`, `schema` and a pure `build(view, context)`. | before PR |
| 3 | Every reply is wrapped in the envelope (`contract`, `model`, `generated_at`, `freshness`, `cursor`, `data`) with UTC timestamps ending in Z, and carries the header `Foreman-Contract`. | before PR |
| 4 | `GET /api/v1/meta` lists the models, the state vocabulary with a group per state, the command catalogue and the event types. | before PR |
| 5 | `GET /api/v1/schemas/{name}` serves each JSON Schema; an unknown name answers 404 as JSON. | before PR |
| 6 | A dependency free validator checks a value against a schema and is used by the contract tests. | before PR |
| 7 | The meta model answers on the installed dashboard. | after install |

### Tests
- `tests/api-contract.test.mjs` (new): starts the real dashboard handler on fixture state, requests `/api/v1/meta` and validates it against its schema; asserts the header; asserts a 404 JSON body for `/api/v1/nope`; asserts `/api/view.json` is unchanged. Invalid input: a schema name with `..` answers 404. Real data example: the state `waiting_for_approval` is present with group `waiting`.

## Live checks
- GET /api/v1/meta -> 200 contains "waiting_for_approval"
- GET /api/v1/schemas/common.schema.json -> 200 contains "condition"
- GET /api/v1/nope -> 404 contains "not_found"

### Files
`supervisor/api/router.mjs`, `supervisor/api/envelope.mjs`, `supervisor/api/validate.mjs`, `supervisor/api/models/meta.mjs`, `supervisor/api/schemas/common.schema.json`, `supervisor/api/schemas/meta.schema.json`, `supervisor/dashserver.mjs`, `tests/api-contract.test.mjs`, `docs/api-contract.md`

---

## Item 2. App bar read model with allowance windows that can be unknown Barmodel

### What happened
Allowance readings 3 to 9 hours old were shown as if current, and the app bar grew to two rows. The data for a correct one line bar exists in the view but is not served on its own.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | `GET /api/v1/appbar` returns system state, counts, slots, tick, one entry per configured agent, breaker and version, matching its schema. | before PR |
| 2 | Each agent has `weekly` and `short` windows with `state` known or unknown; an unknown window has a null figure and a reason code; an expired window is unknown. | before PR |
| 3 | Each agent has `reading` with `read_at`, `age_seconds`, `stale` and `max_age_seconds`. | before PR |
| 4 | No agent name appears in the code; entries follow the configured agent list. | before PR |
| 5 | The reply is under 8 KB for four agents. | before PR |
| 6 | The model answers on the installed dashboard with the live agents. | after install |

### Tests
- `tests/api-appbar.test.mjs` (new): through the real handler. Valid: a fresh reading. Boundary: a reading exactly at its maximum age. Invalid: no reading at all gives two unknown windows. Real data example: agent `codex`, weekly 0.31, 5 hour window expired, reading 32,520 seconds old gives `short.state` unknown with `window_expired_no_reading` and `reading.stale` true; agent `claude` weekly 0.14 resetting `2026-11-19T04:00:00Z`.

## Live checks
- GET /api/v1/appbar -> 200 contains "used_fraction"
- GET /api/v1/appbar -> 200 contains "max_age_seconds"

### Files
`supervisor/api/models/appbar.mjs`, `supervisor/api/schemas/appbar.schema.json`, `tests/api-appbar.test.mjs`

---

## Item 3. Withdrawn: already delivered by issue 1223

Correction made on 13 Nov before anything was proposed. Issue #1223 (Resume check failure logs its message and every unlaunched plan item records why Holdwhy) merged on 12 Nov at 21:49 UTC. It already records, for every planned action a pass does not start, one reason kind from a fixed list, with the kind `unexplained` when there is none, and raises that as a Needs you item. This item would have duplicated it and must not be raised.

What is left (when each hold began, and what holds it as a reference and not only as text) is small and is covered by item 5 requirement 2, which reads the existing ledger.

---

## Item 4. Attention items carry a kind, an attention class and usable controls Attclass

### What happened
Cards appeared in Needs you with no usable control or only Park, and a malformed prerequisite line that held issues for hours was shown as an info line. Severity alone cannot separate a homeowner wait from a fault.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | One table maps every attention id pattern to `kind`, `attention` (homeowner or fault or unknown), a reason code and the commands that apply. | before PR |
| 2 | An id that matches no row is classed `fault` with the code `unclassified`, so a new item can never be silent. | before PR |
| 3 | A malformed prerequisite line is `fault` with `malformed_prerequisite_line` and the action `work_item.edit_prerequisites`. | before PR |
| 4 | Every item classed `homeowner` has at least one enabled action or a step text; a test fails otherwise. | before PR |
| 5 | A disabled action carries the refusal code and text the command would return. | before PR |

### Tests
- `tests/api-attention.test.mjs` (new): classifies the attention list built by the real view builder from fixture state. Valid: a fix limit item is `homeowner` with actions. Boundary: an item with only a disabled action and a step text passes. Invalid: an unknown id becomes `unclassified` fault. Real data example: issue 1185 as it was on 12 Nov, with its prerequisite declaration written inside a sentence (naming 1156), is classed fault with the edit action; PR 1192 at fix limit 3 is classed homeowner.

### Files
`supervisor/api/attention.mjs`, `tests/api-attention.test.mjs`

---

## Item 5. Overview read model with stalls, needs you and faults kept apart Overviewmodel

### What happened
He had to ask the overseer why nothing was running. The overview must answer in one read: is it working, what needs me, what is stuck and why.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | `GET /api/v1/overview` matches its schema with `verdict`, `stalls`, `needs_you`, `faults`, `slots`, `planned`, `pipeline`, `headline`, `waste`, `host`. | before PR |
| 2 | `stalls` has one entry per agent that is idle with a planned action, built from the planned action ledger the pass already writes: idle seconds, each held action with its kind as the reason code (`unexplained` served as `unrecorded`), when the hold began, what holds it as a reference where the ledger names it, and the actions that apply. | before PR |
| 3 | `verdict.state` is `stalled` whenever `stalls` is not empty, whatever else is waiting. | before PR |
| 4 | `needs_you` holds only homeowner class items and `faults` only fault and unknown class items. | before PR |
| 5 | `waste.top_cause` gives the share of wasted tokens and the number of distinct changes hit. | before PR |
| 6 | A stuck change lists a split action; it is enabled only when a split has been proposed, otherwise disabled with `no_split_proposed`. | before PR |
| 7 | The appbar model takes `system` and the fault and stall counts from the same function. | before PR |
| 8 | On Tower the model answers and its counts equal the appbar counts. | after install |

### Tests
- `tests/api-overview.test.mjs` (new): through the real handler. Valid: one running job and no stall gives verdict `running`. Boundary: a stall plus six waiting cards still gives `stalled`. Invalid: missing snapshot gives verdict `unknown`, never `ok`. Real data example: four slots, zero in use, the four planned actions of 12 Nov give two stall entries; waste of 59 rebase jobs and 86,000,000 tokens with 67,080,000 from lost changes across 28 PRs gives fraction 0.78.

## Live checks
- GET /api/v1/overview -> 200 contains "needs_you"
- GET /api/v1/overview -> 200 contains "stalls"

### Files
`supervisor/api/models/overview.mjs`, `supervisor/api/schemas/overview.schema.json`, `supervisor/api/models/appbar.mjs`, `tests/api-overview.test.mjs`

---

## Item 6. One change stream that says which read models changed Changestream

### What happened
Pages poll and swap HTML, and a click reloaded the page and lost his place. Clients need to be told what changed and to know when they are behind.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | The core appends an event to a bounded log in the state root when a pass ends and when a command is applied or refused. | before PR |
| 2 | `GET /api/v1/events` streams events as server sent events with a monotonic id, a `hello` first and a `heartbeat` with the data freshness at least every 15 seconds. | before PR |
| 3 | A reconnect with `Last-Event-ID` replays missed events; an id older than the log gets `resync_required`. | before PR |
| 4 | Events match the event schema; `model_changed` names the models. | before PR |
| 5 | The existing cap on open streams applies; over the cap answers 503 with a retry time. | before PR |
| 6 | The stream answers on Tower. | after install |

### Tests
- `tests/api-events.test.mjs` (new): opens the real handler's stream. Valid: appending an event delivers it. Boundary: reconnect at the last id delivers nothing twice. Invalid: an id older than the log gives `resync_required`; a thirteenth stream gets 503. Real data example: the event `{ "type": "model_changed", "models": ["appbar", "overview"] }`.

### Files
`supervisor/api/events.mjs`, `supervisor/api/eventlog.mjs`, `supervisor/api/schemas/event.schema.json`, `tests/api-events.test.mjs`

---

## Item 7. Command endpoint with audit log and the Inbox decisions as named commands Commandbase

### What happened
Each control is a separate form post with its own reply shape, and a Park click reloaded the page. Controls need one shape, one audit trail and a reply that carries the new state.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | `POST /api/v1/commands/{name}` accepts the request schema and always answers with the result schema; command modules are loaded from `supervisor/api/commands/` by directory listing. | before PR |
| 2 | The existing write protection (host, origin, access proof, cooldown) applies to every command; the proof is read from a request header. | before PR |
| 3 | `inbox.approve`, `inbox.reject` and `inbox.undo_decision` call the existing Inbox decision functions and return the item's new state and the undo command with its time limit. | before PR |
| 4 | A refusal answers 409 with a stable code and the reason, and changes nothing. | before PR |
| 5 | The same idempotency key returns the first result without a second effect. | before PR |
| 6 | Every command, applied or refused, appends one audit entry (actor, client, command, target, input, reason, before, after, outcome, undo) and one event. | before PR |
| 7 | `GET /api/v1/audit` returns the entries, newest first, matching its schema. | before PR |
| 8 | Approving one Inbox item through the command on Tower starts its job. | after install |

### Tests
- `tests/api-commands.test.mjs` (new): through the real handler with a temporary Inbox folder. Valid: approve then undo inside 30 seconds returns to waiting. Boundary: undo at 31 seconds is refused with `undo_window_passed`. Invalid: unknown command, missing key, bad proof, approving a done item (`wrong_state`). Real data example: a waiting prompt item titled `Rules drift check read only Driftcheck`.

## Live checks
- GET /api/v1/audit -> 200 contains "entries"
- POST /api/v1/commands/inbox.approve -> 403 contains "refused"

### Files
`supervisor/api/commands.mjs`, `supervisor/api/audit.mjs`, `supervisor/api/commands/inbox-decide.mjs`, `supervisor/api/models/audit.mjs`, `supervisor/api/schemas/audit.schema.json`, `supervisor/api/schemas/command-request.schema.json`, `supervisor/api/schemas/command-result.schema.json`, `tests/api-commands.test.mjs`

---

## Item 8. Web shell with a one line app bar served under ui Oneline

### What happened
The app bar became two rows when allowance lines were added. He wants one minimal line: per agent the name, a status dot, weekly % and 5 hour %, with details on hover or tap.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | Static files in `supervisor/ui/` are served under `/ui/` from a fixed allow list built from that folder at start; no path from the request is joined to a directory. | before PR |
| 2 | The page reads only `/api/v1/` and uses no inline script, no external network and no build step. | before PR |
| 3 | The app bar is one line 48 px high at 1280 px and at 390 px with two agents; it never wraps. | before PR |
| 4 | Each agent shows a status shape, its name, weekly % and 5 hour %; an unknown window shows a question mark and no number; a stale reading marks both figures and shows its age. | before PR |
| 5 | Tapping an agent opens a popover with both windows, reset times, reading age and roles. | before PR |
| 6 | The bar updates from the change stream without a reload and shows Live, Reconnecting or Behind. | before PR |
| 7 | Dark and light themes and a density setting are remembered per viewer; an automated accessibility check reports no contrast failure. | before PR |
| 8 | The page loads on Tower at `/ui/`. | after install |

### Tests
- `tests/ui-appbar-browser.mjs` (new, Playwright): loads `/ui/` at 1280 and 390 wide. Asserts bar height 48 and no horizontal overflow; asserts the text of the second agent contains `31%` and `?` and `9h`; opens the popover and finds `5 hour window has reset; no new reading yet`; pushes a `model_changed` event and asserts the figure changes with no navigation. Real data example: the 12 Nov appbar fixture (claude 14% and 1%; codex 31%, 5 hour unknown, reading 9 hours old).

## Live checks
- GET /ui/ -> 200 contains "appbar"
- GET /ui/app.mjs -> 200

### Files
`supervisor/api/static.mjs`, `supervisor/ui/index.html`, `supervisor/ui/app.css`, `supervisor/ui/app.mjs`, `supervisor/ui/client.mjs`, `supervisor/ui/status.mjs`, `supervisor/ui/appbar.mjs`, `tests/ui-appbar-browser.mjs`

---

## Item 9. Stalled banner on every screen and the Overview screen Stalledbanner

### What happened
All four slots sat idle for hours with four planned actions and nothing on screen said so.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | When the overview has a stall, a banner shows above every screen with the idle time and the core's sentence. | before PR |
| 2 | On the Overview the banner lists each idle agent, each planned action, its hold reason or the words No reason recorded, what holds it, and the controls. | before PR |
| 3 | The Overview shows Needs you and Faults as two separate lists; every item shows its controls; a disabled control shows why. | before PR |
| 4 | Every count and headline number links to its list with the filter applied. | before PR |
| 5 | A stale data banner shows when freshness is stale; a healthy overview shows no banner and no coloured card. | before PR |
| 6 | The banner appears and clears from the change stream with no reload. | before PR |
| 7 | On Tower, with an agent idle and work planned, the banner is visible within one pass. | after install |

### Tests
- `tests/ui-stalled-browser.mjs` (new, Playwright): with the 12 Nov overview fixture asserts the banner text `Nothing has started for 3 hours 23 minutes`, the words `No reason recorded` beside `PR #1180`, and `Held by PR #1180` beside `PR #1139`; navigates to the Inbox and asserts the banner is still present; swaps to a healthy fixture through an event and asserts the banner is gone; clicks the waste number and asserts the jobs list is filtered by `rebase_refused_lost_changes`.

### Files
`supervisor/ui/banner.mjs`, `supervisor/ui/overview.mjs`, `tests/ui-stalled-browser.mjs`

---

## Item 10. Inbox read model with counts by state and kind, paging and reason codes Inboxmodel

### What happened
354 Inbox items were one long card list. A client cannot offer filters with counts without the counts.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | `GET /api/v1/inbox` matches its schema and accepts `state`, `kind`, `q`, `sort`, `limit`, `cursor`. | before PR |
| 2 | `facets` counts the whole Inbox by state and by kind whatever the filter. | before PR |
| 3 | The stored state `pending` is served as `waiting_for_approval` and `posting` as `running`. | before PR |
| 4 | Decision rows and Inbox proposals are served in the one list with kind `decision` for the former. | before PR |
| 5 | A refused or failed item carries a reason code beside its text. | before PR |
| 6 | Each waiting item lists its actions. | before PR |
| 7 | The 8 character id and the full id are both present; `q` matches either and the title. | before PR |
| 8 | The model answers on Tower with the live count. | after install |

### Tests
- `tests/api-inbox.test.mjs` (new): through the real handler with a temporary Inbox folder of 354 status records. Valid: `state=waiting_for_approval` returns 12 and facets still total 354. Boundary: `limit=1` returns a cursor that continues. Invalid: an unknown state value returns an empty page, not an error page. Real data example: `q=Driftcheck` returns the done item `Rules drift check read only Driftcheck`.

## Live checks
- GET /api/v1/inbox?limit=1 -> 200 contains "facets"

### Files
`supervisor/api/models/inbox.mjs`, `supervisor/api/schemas/inbox.schema.json`, `tests/api-inbox.test.mjs`

---

## Item 11. Inbox screen with card, table and list views, filters with counts and saved views Inboxscreen

### What happened
354 items as one long card list with a search box and two dropdowns; an action reloaded the page and lost his place.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | The Inbox opens on the saved view Waiting for me. | before PR |
| 2 | Filter buttons for each state and kind show counts and can be combined; search matches id and title. | before PR |
| 3 | The list can be shown as cards, a table or a compact list, sorted and grouped; the choice is remembered. | before PR |
| 4 | Approve and Reject apply in place: the row updates, counts update everywhere, scroll and filters stay, and a toast offers Undo for the allowed time. | before PR |
| 5 | A refusal shows the reason on a toast and leaves the item unchanged. | before PR |
| 6 | Any item opens a side panel with its text, what approving does, result, reason and job. | before PR |
| 7 | The viewer can save the current filters as a named view. | before PR |
| 8 | A shared list component provides the filter chips, view switch and paging for later screens. | before PR |
| 9 | On Tower one waiting item is approved from the list view on a phone with no reload. | after install |

### Tests
- `tests/ui-inbox-browser.mjs` (new, Playwright): with the 354 item fixture asserts the heading `12 of 354`; switches the three views and counts 12 rows in each; scrolls, approves the first item, asserts the heading `11 of 354`, the tab count 11 and an unchanged scroll position and URL; presses Undo and asserts 12; filters Failed and asserts 14; searches `Driftcheck` in the All view and asserts one row. Runs at 1280 and 390 wide.

### Files
`supervisor/ui/listview.mjs`, `supervisor/ui/inbox.mjs`, `supervisor/ui/panel.mjs`, `supervisor/ui/toast.mjs`, `tests/ui-inbox-browser.mjs`

---

## Item 12. Inbox park, requeue, dismiss and bulk decide commands Inboxmore

### What happened
A failed Inbox item had no control and simply expired. Twelve routine approvals took twelve separate clicks.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | `inbox.park` and `inbox.unpark` mark a waiting item parked without deciding it; each is the undo of the other. | before PR |
| 2 | `inbox.requeue` returns a failed or rejected item to waiting when its content is still available, and refuses with `content_gone` otherwise. | before PR |
| 3 | `inbox.dismiss` ends a failed item with a recorded result. | before PR |
| 4 | `inbox.bulk_decide` applies one decision to a list of ids, returns a result per id, and refuses more than 30 ids. | before PR |
| 5 | Each is audited and emits an event; a failed item lists requeue and dismiss as its actions. | before PR |
| 6 | The screen shows a bulk bar when items are selected and reports how many were applied. | before PR |

### Tests
- `tests/api-inbox-more.test.mjs` (new): through the real command endpoint. Valid: park then unpark. Boundary: bulk of exactly 30. Invalid: bulk of 31, requeue of a done item, dismiss of a waiting item. Real data example: a failed prompt with the reason `The job stopped at the 15 minute Inbox cap before it saved its report`.
- `tests/ui-inbox-bulk-browser.mjs` (new, Playwright): selects all 12 waiting items, rejects them, asserts `0 of 354` in the waiting view and the toast `12 of 12 applied`.

### Files
`supervisor/api/commands/inbox-more.mjs`, `supervisor/inboxpark.mjs`, `supervisor/ui/bulkbar.mjs`, `tests/api-inbox-more.test.mjs`, `tests/ui-inbox-bulk-browser.mjs`

---

## Item 13. Queue and work item read models with rank, stage and prerequisite line state Queuemodel

### What happened
Issues were held for hours because a prerequisite line was malformed, and nothing showed rank, stage and hold reason together.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | `GET /api/v1/queue` matches its schema: every open issue and change with rank, stage, condition, agent, prerequisites and estimated start. | before PR |
| 2 | `prerequisites.line_state` is none, ok or malformed, with the raw line; a malformed line gives a fault condition. | before PR |
| 3 | A held item carries the reason code from the hold records. | before PR |
| 4 | `GET /api/v1/work-items/{key}` matches its schema: requirements table rows, expected files, checks, review rounds with findings marked blocking and by scope, fix rounds against the limit, rebase attempts and cap, split, jobs and timeline. | before PR |
| 5 | A decision proposal is identified by a stable key; the register number is null until merged. When proposals are not yet separate files the key is derived from the proposal title. | before PR |
| 6 | An unknown key answers 404 as JSON. | before PR |
| 7 | The queue model answers on Tower. | after install |

### Tests
- `tests/api-queue.test.mjs` (new): through the real handler. Valid: issue 1169 at rank 17 of 21 held with `prerequisite_open` naming 1157. Boundary: an item with no prerequisite line has `line_state` none. Invalid: issue 1185 with an inline declaration has `line_state` malformed and attention fault. Real data example for the detail: PR 1192 with 4 review rounds, fix 3 of 3, rebase 2 attempts capped, one blocking finding with scope `description_only`.

## Live checks
- GET /api/v1/queue -> 200 contains "line_state"
- GET /api/v1/work-items/issue-0 -> 404 contains "not_found"

### Files
`supervisor/api/models/queue.mjs`, `supervisor/api/models/work-item.mjs`, `supervisor/api/schemas/queue.schema.json`, `supervisor/api/schemas/work-item.schema.json`, `tests/api-queue.test.mjs`

---

## Item 14. Queue screen as table and board with the work item side panel Queuescreen

### What happened
There was no single place to see every issue and PR with its rank, stage and the reason it is not moving.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | The Queue shows a table (rank, item, stage, state and reason, agent, prerequisites, rounds) and a board with one column per stage. | before PR |
| 2 | Filter buttons with counts: all, needs you, faults, held, parked, changes, issues; search by number or title. | before PR |
| 3 | A held item with no recorded reason reads Held, no reason recorded in the fault style; a malformed line reads Malformed. | before PR |
| 4 | A row or tile opens the side panel with everything in the work item model and its controls. | before PR |
| 5 | Links with a stage or filter in the address open the list already filtered, shown as a removable chip. | before PR |
| 6 | At 390 px secondary columns are hidden and remain in the panel. | before PR |

### Tests
- `tests/ui-queue-browser.mjs` (new, Playwright): asserts 37 rows with the 12 Nov fixture; the row for `#1169` shows `17 of 21` and `Waiting for #1157`; the row for `#1185` shows `Malformed`; switches to the board and asserts the Fixing column count 4; opens `PR #1192` and finds `Reviews (4 rounds)` and `not assigned until it merges`.

### Files
`supervisor/ui/queue.mjs`, `supervisor/ui/workitem.mjs`, `tests/ui-queue-browser.mjs`

---

## Item 15. Jobs read model and screen with cause, tokens, cost in pence and duration Jobsall

### What happened
Rebase jobs wasted 67M tokens over 7 days on one refusal cause, visible only by asking the overseer to dig.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | `GET /api/v1/jobs` matches its schema and accepts `status`, `kind`, `agent`, `cause`, `target`, `limit`, `cursor`. | before PR |
| 2 | Each job has kind, role, agent, model, a condition, a cause code and text, tokens in and out, cost in pence with its basis, start, end, duration, attempts and whether a transcript exists. | before PR |
| 3 | A job with no cost figure has a null cost and basis unknown, never zero; totals say what they exclude. | before PR |
| 4 | The transcript routes accept the 8 character id and refuse an ambiguous one. | before PR |
| 5 | The Jobs screen is a table with filters by state group, kind and cause, and a side panel with the applicable controls. | before PR |
| 6 | The model answers on Tower. | after install |

### Tests
- `tests/api-jobs.test.mjs` (new): Valid: a completed job. Boundary: a running job has a null end. Invalid: an ambiguous 8 character prefix answers 409. Real data example: job `60b46719`, rebase of PR 1180, blocked, cause `postcondition_not_met`, 3,427,984 tokens, model sonnet.
- `tests/ui-jobs-browser.mjs` (new, Playwright): opens the jobs list by the address with `cause=rebase_refused_lost_changes`, asserts only rebase rows and the removable cause chip; opens `60b46719` and finds `3,427,984`.

## Live checks
- GET /api/v1/jobs?limit=1 -> 200 contains "cause_code"

### Files
`supervisor/api/models/jobs.mjs`, `supervisor/api/schemas/jobs.schema.json`, `supervisor/ui/jobs.mjs`, `tests/api-jobs.test.mjs`, `tests/ui-jobs-browser.mjs`

---

## Item 16. Allowance read model and screen with waste by cause Allowanceview

### What happened
Readings were shown without their age, and waste by cause was only reachable through the overseer.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | `GET /api/v1/allowance` matches its schema: per agent windows, reading, scheduling mode with a reason code, projection, limit resets with advice, the credit agent or null, and waste by cause. | before PR |
| 2 | Each waste cause has jobs, tokens, cost in pence, the number of distinct changes hit and its share. | before PR |
| 3 | The screen shows two meters per agent; an unknown window is hatched with its reason; a stale reading shows its age beside the figure. | before PR |
| 4 | A waste row links to the jobs with that cause. | before PR |
| 5 | Refresh reading sends `agent.refresh_allowance` and shows a cooldown refusal with the time it will be allowed. | before PR |
| 6 | The model answers on Tower with a reading age for every agent. | after install |

### Tests
- `tests/api-allowance.test.mjs` (new): Valid: two agents with fresh readings. Boundary: a reading one second past its maximum age is stale. Invalid: no waste records gives an empty list and zero totals marked as counted, not unknown. Real data example: 59 rebase jobs, 86,000,000 tokens over 7 days, top cause share 0.78 across 28 changes.
- `tests/ui-allowance-browser.mjs` (new, Playwright): finds `Unknown: 5 hour window has reset; no new reading yet` and `Reading is 9h 2m old`; clicks the top waste row and lands on the filtered jobs list.

## Live checks
- GET /api/v1/allowance -> 200 contains "by_cause"

### Files
`supervisor/api/models/allowance.mjs`, `supervisor/api/schemas/allowance.schema.json`, `supervisor/api/commands/agent-refresh.mjs`, `supervisor/ui/allowance.mjs`, `tests/api-allowance.test.mjs`, `tests/ui-allowance-browser.mjs`

---

## Item 17. Queue commands with before and after state and an undo for each Queuecommands

### What happened
The direct control work (issue 1164) gives the overseer queue actions. The homeowner must be able to see each one and reverse it, and his own controls should be the same commands.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | The commands `work_item.park`, `work_item.unpark`, `work_item.set_rank`, `work_item.assign`, `work_item.edit_prerequisites`, `job.start`, `job.pause`, `job.resume` and `job.stop` call the direct control functions and return the new state. | before PR |
| 2 | Each records before and after state and its undo command in the audit entry. | before PR |
| 3 | The overseer actor needs a reason, is refused `needs_homeowner` for every command outside the direct tier, and is refused `direct_control_off` when the switch is off. | before PR |
| 4 | `job.start` starts only an action the planner has planned and applies every limit (slots, allowance, breaker, host pressure, review independence); each has its own refusal code. | before PR |
| 5 | `audit.undo` reverses an entry that is still reversible and refuses with `state_moved_on` or `already_undone` otherwise. | before PR |
| 6 | `direct_control.set` is accepted only from the homeowner and is itself audited. | before PR |
| 7 | No command widens a limit, bypasses a review gate or approves its sender's own proposal; a test per restricted action proves the refusal. | before PR |
| 8 | On Tower the overseer parks one issue with a reason and the homeowner undoes it. | after install |

### Tests
- `tests/api-queue-commands.test.mjs` (new): through the real command endpoint. Valid: set rank of issue 1238 from 6 to 1, then undo returns 6. Boundary: rank 1 and the last rank. Invalid: rank 0, an unknown agent, a prerequisite that makes a cycle, every command with the switch off, `work_item.clear_retry_cap` from the overseer. Real data example: `work_item.edit_prerequisites` on issue 1185 with `[1156]` changes `line_state` from malformed to ok.

### Files
`supervisor/api/commands/queue.mjs`, `supervisor/api/commands/jobs.mjs`, `supervisor/api/commands/direct-control.mjs`, `supervisor/api/commands/audit-undo.mjs`, `tests/api-queue-commands.test.mjs`

---

## Item 18. Audit screen with undo on every reversible action and the one switch Auditscreen

### What happened
Direct control needs an audit trail the homeowner can read, an undo on every reversible action, and one switch that turns it off.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | The Audit screen lists every command with time, actor, command, target, reason, before and after, and outcome; filters for overseer, homeowner, refused and can be undone. | before PR |
| 2 | A reversible entry has an Undo button; after undo the row reads undone and names the entry that undid it. | before PR |
| 3 | A refused entry shows the refusal text. | before PR |
| 4 | One switch shows whether direct control is on, who changed it and when; changing it asks for confirmation and applies in place. | before PR |
| 5 | A command applied by the overseer appears without a reload. | before PR |
| 6 | On Tower the switch is turned off and a direct command from the overseer is refused. | after install |

### Tests
- `tests/ui-audit-browser.mjs` (new, Playwright): with the 12 Nov audit fixture asserts 10 rows; presses Undo on `work_item.set_rank` for `#1238` and asserts the row reads undone; finds `Clearing a retry cap needs the homeowner`; turns the switch off through the dialog and asserts it reads Off with no navigation.

### Files
`supervisor/ui/audit.mjs`, `tests/ui-audit-browser.mjs`

---

## Item 19. Decisions, incidents and installs read models with a System screen Systemview

### What happened
A decision number changed after he was told it (D-040 became D-042), and breaker halts, installs and the latch are spread over several pages.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | `GET /api/v1/decisions` lists register entries and proposals with a stable key, a number that is null until merged, title, state and the change that proposes it. | before PR |
| 2 | `GET /api/v1/incidents` lists breaker halts by cause with scope, subjects, cost in pence, since, and the resume action marked as needing a person; plus history. | before PR |
| 3 | `GET /api/v1/installs` gives installed, running and main versions, each install with its result, live check results per change with expected and actual, and the latch with its reason and clear action. | before PR |
| 4 | Each model has a schema and is covered by the contract tests. | before PR |
| 5 | The System screen shows the three with their controls; a failed live check names the check line. | before PR |
| 6 | The three models answer on Tower. | after install |

### Tests
- `tests/api-system.test.mjs` (new): Valid: a clear breaker and a verified install. Boundary: a proposal with no number. Invalid: an unreadable register gives state unknown with a reason, not an empty list. Real data example: an approval recorded against the key of the proposal in PR 1192 still resolves after the register number changes from D-040 to D-042.
- `tests/ui-system-browser.mjs` (new, Playwright): finds the proposal by key with the words `not assigned until it merges`.

## Live checks
- GET /api/v1/decisions -> 200 contains "key"
- GET /api/v1/incidents -> 200 contains "halts"
- GET /api/v1/installs -> 200 contains "installed"

### Files
`supervisor/api/models/decisions.mjs`, `supervisor/api/models/incidents.mjs`, `supervisor/api/models/installs.mjs`, `supervisor/api/schemas/decisions.schema.json`, `supervisor/api/schemas/incidents.schema.json`, `supervisor/api/schemas/installs.schema.json`, `supervisor/ui/system.mjs`, `tests/api-system.test.mjs`, `tests/ui-system-browser.mjs`

---

## Item 20. Host, reports and notifications read models with a Reports screen Reportsview

### What happened
Reports and digests the overseer writes are readable only over MCP, and alerts sent to the homeowner have no screen.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | `GET /api/v1/host` gives each measure (disk, memory, swap) with value, limit, unit, whether it holds starts, and the current hold with its reason. | before PR |
| 2 | `GET /api/v1/reports` lists reports with name, size in bytes, saved time, whether the finished marker is the last line, and the Inbox item that produced it. | before PR |
| 3 | `GET /api/v1/reports/{name}` returns one report as plain text with the same redaction as other output; a name with a path separator is refused. | before PR |
| 4 | `GET /api/v1/notifications` lists alerts with time, text, delivered or failed and the item concerned. | before PR |
| 5 | The Reports screen lists reports and alerts; an incomplete report is marked and links to its Inbox item. | before PR |
| 6 | The three models answer on Tower. | after install |

### Tests
- `tests/api-reports.test.mjs` (new): Valid: a complete report. Boundary: an empty reports folder gives an empty list. Invalid: a report whose last line is not the finished marker is `complete: false`; a name containing `..` answers 404. Real data example: a report whose last line is `<!-- foreman-report: finished -->`.

## Live checks
- GET /api/v1/host -> 200 contains "measures"
- GET /api/v1/reports -> 200 contains "complete"
- GET /api/v1/notifications -> 200 contains "delivered"

### Files
`supervisor/api/models/host.mjs`, `supervisor/api/models/reports.mjs`, `supervisor/api/models/notifications.mjs`, `supervisor/api/schemas/host.schema.json`, `supervisor/api/schemas/reports.schema.json`, `supervisor/api/schemas/notifications.schema.json`, `supervisor/ui/reports.mjs`, `tests/api-reports.test.mjs`

---

## Item 21. The MCP server reads the contract so the overseer sees what the homeowner sees Mcpcontract

### What happened
The MCP server reshapes the large view in its own modules, so the overseer and the homeowner can see different answers, and the overseer had to dig to learn why nothing was running.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | A contract source in the MCP package fetches read models from `/api/v1/` with the same cache, size cap and timeout rules as the existing source, and refuses a core whose major version is not 1. | before PR |
| 2 | `foreman_status`, `foreman_plan`, `foreman_why_blocked`, `foreman_needs_you` and `foreman_inbox_items` answer from the appbar, overview, queue and inbox models and return the conditions unchanged (state, attention, reason code, reason text). | before PR |
| 3 | `foreman_status` leads with the stall entries when there are any. | before PR |
| 4 | A `fields` argument limits a tool answer to the named top level fields. | before PR |
| 5 | The tools keep their names and stay inside their output bounds. | before PR |
| 6 | From the overseer session, `foreman_status` shows the same stall text as the web banner. | after install |

### Tests
- `tests/mcp-contract.test.mjs` (new): calls the real tool handlers against a stub core serving the 12 Nov fixtures. Valid: `foreman_status` returns two stall entries with the codes `unrecorded` and `file_overlap_hold`. Boundary: `fields` naming one field returns only it. Invalid: a core answering contract `2.0` is refused with a clear message; an unreachable core serves the last good copy marked stale.

### Files
`foreman-mcp/contract-source.mjs`, `foreman-mcp/tools.mjs`, `tests/mcp-contract.test.mjs`, `docs/foreman-mcp.md`

---

## Item 22. The new UI becomes the default and the HTML fragment routes are retired Newdefault

### What happened
Two interfaces running side by side is a transition, not an end state. Once the new one covers daily use, the old pages and fragment routes are dead weight.

### Requirements
| # | Requirement | When |
|---|---|---|
| 1 | `/` redirects to `/ui/`; the old pages remain reachable under `/classic/` for one release. | before PR |
| 2 | The HTML fragment routes for the next tick and the process list are removed; their data is in the appbar and host models. | before PR |
| 3 | The approvals event stream is removed; the change stream replaces it. | before PR |
| 4 | The form post routes answer with a pointer to the command endpoint for one release, then are removed in a later item. | before PR |
| 5 | The large view route stays for the tests and tools that still read it and is marked legacy in the docs. | before PR |
| 6 | On Tower the homeowner confirms on a phone and a desktop that the app bar, the stalled banner, the Inbox, the queue, jobs, allowance and audit all work before the old pages are removed. | after install |

### Tests
- `tests/ui-default-browser.mjs` (new, Playwright): loads `/` and lands on `/ui/`; loads `/classic/` and gets the old overview; requests the removed fragment routes and gets 404; runs the app bar and Inbox assertions of items 8 and 11 from the root address.

## Live checks
- GET /ui/ -> 200 contains "appbar"
- GET /api/next -> 404
- GET /api/v1/appbar -> 200 contains "agents"

### Files
`supervisor/dashserver.mjs`, `docs/dashboard.md`, `tests/ui-default-browser.mjs`

---

## How the first UI is served, and with what

**Served by Foreman's own Node dashboard server on the LAN.** The server (`supervisor/dashserver.mjs`, observed) is Node built-ins only, binds one private LAN address, and already serves a fixed list of static files by name. The new UI uses the same pattern through one delegation line added in item 1:

- `/api/v1/*` goes to the contract router; `/ui/*` goes to a static handler with an allow list built from the `supervisor/ui/` folder at start, so no request path is ever joined to a directory.
- The existing response headers stay, including the content security policy (`default-src 'none'; script-src 'self'; connect-src 'self'`). The new UI has no inline script and no external request, so it fits the policy unchanged. It needs `style-src 'self'` only.
- The existing write protection (Host, Origin, access proof, cooldowns, D-029) covers the command endpoint. The proof is delivered to the page as it is today and sent back in a header.
- Old and new run side by side (`/` and `/ui/`) until item 22, reading the same state. Self upgrade, rollback and the dashboard watchdog are unchanged because it is the same process.

**Front end: plain ES modules, no framework, no build step, no runtime dependency.**

| Choice | Why |
|---|---|
| No framework | The whole prototype (six screens, app bar, panel, commands, live updates) is under 400 lines of JS. The contract does the hard part: the client is a mapping from conditions and actions to markup. A framework would add a build step, a dependency to audit and upgrade, and a larger surface for the self upgrade to verify. |
| No build step | Files are served as written. A reviewer reads exactly what runs; a hotfix is one file; the pinned Playwright image is the only tooling. |
| One small keyed list helper (in repo, about 60 lines) | To replace only changed rows so focus, selection and open rows survive live updates. This is the one place a library would normally be used; it is small enough to own. |
| JSON Schema checked by an in repo validator (about 100 lines, in `schemas/validate.mjs` here) | Keeps the "built-ins only" rule. The schemas stay inside the subset it supports; contract tests enforce that. |
| Dev only: Playwright, already used by the repository's browser checks | No new tool. |
| Storage: `localStorage` for per viewer layout first | No backend needed; moves to the core later (`viewer.save_view`). |

If the UI later outgrows this (many more screens, complex forms), the contract means it can be rewritten in anything without touching the core. That is the point of building the contract first.
