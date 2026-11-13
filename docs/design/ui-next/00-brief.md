# 00. Brief: Foreman's interface, designed again from the data up

Read at commit `82806c9` of `Unthred/devtest-infrastructure` (12 Nov 2026). Claims about how Foreman works are marked **observed** (read in code or docs) or **inferred**. The current dashboard's renderer, UI scripts and CSS were not read.

## 1. The problem as I read it

Foreman already knows almost everything the homeowner needs. **Observed**: `buildView()` (`supervisor/dashboard.mjs`) assembles agents, plan, queues, budget, attention items, breaker, jobs, PRs, issues and verdicts into one view, and about forty attention items are raised for specific faults. The failures in real use were not missing data so much as three structural gaps:

1. **State is prose, not a value.** Reasons are sentences (`idleReason` returns `{ text, links }`; held work carries a `why` string). Nothing downstream can tell a homeowner wait from a fault, count them, or notice that a reason is absent. So four idle slots with four planned actions produced no signal: an absent reason is invisible when reasons are free text. **Observed**: `healthOf()` returns `needs_you` before it checks for `stuck`, so any waiting card hides a stall.
2. **Presentation and data are one thing.** The server renders HTML and fragments (`/api/next`, `/api/processes`), actions are form posts that redirect, and the overseer's MCP server reshapes `/api/view.json` in its own modules. Two readers of the same system see differently shaped truths, and a click reloads the page.
3. **Controls are attached to pages, not to things.** Whether an item has a usable control depends on which card type it became. Hence cards with only Park, or none.

So the redesign is mostly a contract: make every state a named value with an attention class and a reason code, attach the applicable commands to every entity, and let any number of thin clients draw it. The visual design then becomes simple, because the data already says what is loud and what is calm.

## 2. Users

| Reader | Context | What they need |
|---|---|---|
| Homeowner | One person. Phone in passing, desktop when working. Approves or rejects; does the things only he can do. | In five seconds: is it working, what needs me, what is stuck and why. Then act without losing his place. |
| Overseer | An AI agent reading over MCP, proposing and (once discussed) applying queue changes. | The same state as structured data; never having to dig for why nothing runs; commands that refuse clearly; its own actions read back. |
| Later readers | A wall display, a terminal, a phone app, another project's source (Azure DevOps, Home Assistant). | A small stable contract and nothing agent, source or project specific in it. |

## 3. The top questions the interface answers, in order

1. Is Foreman working right now? If not, since when and why?
2. What is waiting for me, and what is the one control for each?
3. What is wrong that nobody asked me about (faults), and what would fix it?
4. Are the agents able to work: allowance per window, how old the reading is, what happens next?
5. What will run next, and why is each planned action not running yet?
6. Where is each piece of work in its life: queued, implementing, review, fix, rebase, merge, install, verified?
7. What did it cost, and where was it wasted?
8. What did the overseer change, why, and how do I undo it?
9. What happened to the thing I approved?
10. Is the picture I am looking at current?

## 4. What I decided and why

| # | Decision | Why |
|---|---|---|
| 1 | The contract is the product; the web UI is its first client. | It is the only way a UI can be swapped, and the only way the overseer and the homeowner are guaranteed the same truth. Proven by a second client (`prototype-terminal/`, about 110 lines, no shared code). |
| 2 | Every state is a `condition`: state, attention (none, homeowner, fault, unknown), reason code, reason text, since. | One status language everywhere. Faults and homeowner waits can never be mixed because the core, not the client, says which is which. |
| 3 | A missing reason is the code `unrecorded` and is itself a fault. | Turns the worst failure (idle for hours, nothing said why) into the loudest thing on the screen, in every client. |
| 4 | Unknown is a value. An expired or unread window is `unknown` with a reason, never zero; a stale reading is flagged on the figure itself. | Removes "readings 3 to 9 hours old shown as current". |
| 5 | Every entity carries its `actions`, including disabled ones with the refusal they would get. | No dead ends by construction. A contract test fails a core that puts something under Needs you with nothing usable. |
| 6 | One command endpoint, one named command per control, with tiers (direct, approval, person only), idempotency, an audit entry for every attempt, and undo as data. | Follows issue #1164 and D-038, generalised so the homeowner's clicks and the overseer's commands are the same thing with different rights. |
| 7 | One event stream that says which models changed; clients refetch only those and patch in place. Connection, cursor and data freshness are three separate signals. | Actions apply in place, nothing reloads, and "behind" is distinguishable from "stale". |
| 8 | Stalled is a system state and a banner that sits above every screen until it clears. | He should never have to ask the overseer why nothing is running. |
| 9 | The app bar is one line: system state, then per agent a dot, the name, weekly % and 5 hour %. Everything else is behind a tap. | His stated wish; verified at 1280 and 390 px without wrapping. |
| 10 | Overview has two lists side by side: Needs you and Faults. Nothing else is a card. | Calm when healthy, loud only when action is needed; the two classes never share a list. |
| 11 | Lists are data grids with filter buttons that carry counts, saved views, sort, group, and three densities of view (cards, table, compact list). The Inbox default view is "Waiting for me". | 354 items become 12. The other 342 are one tap away with counts. |
| 12 | A decision proposal has a stable key; the register number is assigned at merge and is null until then. | D-040 became D-042 after he was told the number. |
| 13 | The new API lives in its own package (`supervisor/api/`) whose router discovers model and command modules by directory. | Build items add files and do not all edit one route table, so they do not collide or serialise behind hot files. |
| 14 | No framework and no runtime dependency for the first UI: static ES modules served by Foreman's own Node server. | The repo is Node built-ins only (**observed**); the prototype is about 400 lines of JS for six screens, the app bar and the side panel, which does not justify a build step. |

## 5. What is in this folder

| Path | What |
|---|---|
| `01-information-architecture.md` | Navigation, screens, links, questions per screen. |
| `02-journeys.md` | Eight step by step journeys. |
| `03-design-system.md` | Tokens, the status language, components, rules. |
| `04-api-contract.md`, `schemas/` | Queries, commands, events, versioning, mapping onto today's routes; 13 JSON Schemas and a dependency free validator. |
| `fixtures/` | Fixtures in the contract's shapes with the 12 Nov data, `mock-server.mjs` (plain Node) and `standin-server.ps1` (read only, for a Windows machine without Node). |
| `prototype/` | The clickable web prototype (plain HTML, CSS, JS; no build, no external network). `contract-check.html` runs the contract tests in the browser. |
| `prototype-terminal/` | The second client. |
| `contract-test.mjs` | Contract tests any client or core can run. |
| `05-build-plan.md` | 22 work items in the repository's format. |

### How to run it

```bash
node ui-next/fixtures/mock-server.mjs
```

Then open `http://127.0.0.1:8732/`, and in another terminal:

```bash
node ui-next/prototype-terminal/foreman-tui.mjs
```

```bash
node ui-next/contract-test.mjs http://127.0.0.1:8732
```

### What was verified and what was not

The machine this was written on has no Node (and no other JavaScript runtime outside a browser). So:

- **Verified in a browser** against `standin-server.ps1`, which serves the same fixtures over the same paths: all 14 contract checks pass (every fixture validates against its schema; invariants hold); the validator rejects a deliberately broken model; the prototype renders with no script errors at 1280 and 390 px in dark and light (the only console line is the expected 404 when the mock has no detail fixture for an item, which the panel handles); the app bar stays one 48 px line at both widths with no clipping; approve, bulk reject, undo from the audit, the direct control switch, the three Inbox views, saved views, filters, search (focus kept), the queue table and board, the side panel for PR #1192 and issue #1185, the jobs list filtered from the waste link, and the allowance screen all work, with scroll position kept after an action.
- **Not run**: `mock-server.mjs`, `contract-test.mjs` and `foreman-tui.mjs` themselves. They are written for Node 18 or later with built-ins only and were read through carefully, but they have not executed. The live parts that depend on the mock (state that persists across commands, refusals for the overseer actor, the real event stream) are therefore unverified. Run the three commands above on a machine with Node before relying on them.

### Fixture data: what is real and what is illustrative

Real, from the brief or from GitHub on 12 Nov: the agents' states and percentages, the claude weekly reset time, the 9 hour old codex reading, the four held planned actions and their recorded or missing reasons, issues #1169 and #1185 and their holds, rank 17 of 21, PR #1192's rounds, fix limit, finding and retry cap, job `60b46719` (kind, state, cause, total tokens, model), the 7 day waste totals, the Inbox counts by state and kind and the two example titles, the first pass and merge figures, every issue and PR number and title, PR head ids, and the eight requirements of #1164.

Illustrative (plausible, invented to fill the shape): idle start times, the link between the codex overlap holds and the two claude fixes, the other ranks, the other twelve jobs and all job ids except `60b46719`, the token split of that job, costs, the split of waste between the second and third cause, the generated Inbox titles and ids, the audit entries, review findings other than the line count one, slot split by role, the codex weekly reset time, the limit reset expiry day.

## 6. Overlap with open work

**Correction, 13 Nov.** Build plan item 3 (a hold record for every planned action) duplicated issue #1223, which merged on 12 Nov at 21:49 UTC and was already in the commit I read; I missed `supervisor/planledger.mjs`. The plan now marks item 3 withdrawn, and the contract document says the ledger exists. The contract and the prototype are unaffected: the code `unrecorded` is the ledger kind `unexplained`. What the 12 Nov stall still shows is the display gap, not the recording gap.

**Observed** on GitHub (open issues, 12 Nov): several items already aim at parts of this design on the current dashboard: #1218 Inboxacts, #1219 Inboxviews, #1220 Jobstable, #1221 Onebar, #1222 Idlebanner, #1224 Queuetable, #1169 Nodead, and for the backend #1164 Direct (PR #1192), #1226 Descround, #1229 Decfiles, #1240 Splitstuck. The build plan does not duplicate them silently: see the note at the top of `05-build-plan.md` and question 2 below.

## 7. Open questions for the homeowner (8), each with my recommended answer

1. **Does the new UI replace the current dashboard or run beside it first?**
   Recommended: beside it at `/ui/` until the app bar, stalled banner, Inbox and queue are in daily use, then make it the default and retire the HTML routes. Both read the same core, so there is no migration of data.

2. **What happens to the open dashboard items #1218 to #1224 and #1169?**
   Recommended: park #1219, #1220, #1221, #1222 and #1224 as superseded by build plan items 11, 15, 8, 9 and 14 (they build the same things on the renderer this plan retires). Keep #1218 and #1169 only if you want those fixes on the old dashboard in the next week; otherwise they are superseded by items 7 and 12 (Inbox controls) and item 4 (every item has a control). Backend items #1164, #1226, #1229, #1240 stay; the plan depends on them.

3. **May the overseer start a planned job that is held for an unrecorded reason (`job.start`, direct tier)?**
   Recommended: yes. It only starts work the planner already chose, every limit still applies (slots, allowance, breaker, review independence), it is audited with a reason, and it is the direct fix for the 12 Nov stall. New work still needs you.

4. **How long is an action undoable?**
   Recommended: an Inbox decision keeps its 30 seconds (after that the job may have started). Queue changes (rank, park, assignment, prerequisites) stay undoable until the item's state moves on; the audit screen shows which still can be.

5. **When is an allowance reading stale?**
   Recommended: after 60 minutes, or at once when its window's reset time has passed. A stale figure is shown with a marker and its age; an expired window shows "?" and never a number. The core should also probe a stale agent before it plans work for it (#1172 covers part).

6. **Where do saved views and layout live?**
   Recommended: in the browser first (no backend needed, item 11), then in the core per viewer (`viewer.save_view`) once a second device matters. Nothing important is hidden by default in either case.

7. **Should a stall notify you, or only show?**
   Recommended: show at once on every client; send one alert through the existing channel when a stall with an unrecorded reason lasts 30 minutes, and one more when it clears. A stall with a recorded, self-ending reason (waiting for the next tick) never alerts.

8. **Is a login needed before this is used from a phone outside the LAN?**
   Recommended: not for the LAN (keep Host, Origin and access proof, D-029). Do not expose it publicly; if phone access away from home matters, reach it over a VPN you already trust. The contract already separates actors by credential, so a real login can be added later without changing clients.
