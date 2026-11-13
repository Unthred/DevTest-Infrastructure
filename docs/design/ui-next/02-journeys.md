# 02. Journeys

Each step names the read model or command behind it. Data is the 12 Nov 2026 fixture set.

## 1. Morning check (phone, about 20 seconds when healthy)

1. He opens the UI. The app bar loads first (`appbar`, about 3 KB): state chip, then `claude 14% · 1%`, `codex 31% · ?`.
2. **Healthy day**: the state chip reads "Running" with a round dot, the banner zone is empty, the Overview shows "Nothing waits for you" and "No faults", four slot boxes with some filled, yesterday's merges and first pass rate. He closes it.
3. **12 Nov**: the state chip is a red triangle "Stalled", and the banner under it says "Stalled: nothing is running. All 4 slots are idle and 4 planned actions are held. Nothing has started for 3 hours 23 minutes." He does not need to scroll or ask anyone.
4. The Inbox tab shows 12 in the "you" style. Overview lists six things that need him, each with its control, and four faults, separately.
5. He taps the codex chip: weekly 31% "as last read", 5 hour "Unknown: 5 hour window has reset; no new reading yet", "Reading is 9h 2m old". One button: Refresh reading (`agent.refresh_allowance`).

## 2. An agent stalled

1. Trigger: a tick ends with an idle agent and a planned action for it that did not start. The core writes a hold record per action; an action with none is `unrecorded` (`overview.stalls`). The stream sends `model_changed` for `appbar` and `overview`.
2. Every open client changes within a second: the state chip becomes "Stalled", the banner appears on whatever screen is open. Nothing reloads.
3. The banner (on Overview) shows one card per idle agent:
   - **claude idle for 3h 23m**: "No reason recorded. Foreman planned 2 actions for this agent and started neither." Fix PR #1180, Fix PR #1175. Buttons: Start fix on PR #1180, Start fix on PR #1175 (`job.start`, direct tier, reason required).
   - **codex idle for 3h 12m**: "File overlap hold. Both planned actions are held because they would edit files that the planned fixes of PR #1180 and PR #1175 claim, and those fixes have not started." Each action says what holds it (`held_by`). So the chain is visible: codex waits on claude's fixes, which wait on nothing recorded.
4. He taps Start fix on PR #1180, types a reason, confirms. The reply carries the new state; the slot box fills, the planned action leaves the banner, a toast offers Undo (`job.stop`). When the fix starts, the overlap hold on PR #1139 has a live holder, so it is an ordinary wait and no longer a fault.
5. If he does nothing, the overseer sees the identical `overview.stalls` over MCP and (with direct control on) can send the same command with a reason; he sees it arrive as "Start now by overseer" in the Audit and as a `command_applied` event.
6. The banner clears by itself when no agent is idle with planned work. One alert is sent if an unrecorded stall lasts 30 minutes (open question 7).

## 3. Approving an Inbox batch

1. He taps Inbox (12). The default saved view "Waiting for me" shows 12 of 354. Filter buttons show the rest with counts: Done 281, Failed 14, Refused 21, Rejected 24, Running 2.
2. Cards view: each card states what approving does ("Start one supervised Foreman job... It cannot merge, approve, write a review verdict or widen its own limits."). He taps a title to read the full text in the side panel; the list behind keeps its place.
3. He approves one: the button answers at once, the card leaves the view, the count becomes 11 everywhere (tab, heading, Overview), and a toast says "Approve: Applied (audit ...)" with Undo for 30 seconds (`inbox.approve`, `inbox.undo_decision`). No reload, scroll position kept.
4. For the routine ones he switches to List view, taps "Select all waiting items shown", unticks two decisions he wants to read, and taps Approve 9 (`inbox.bulk_decide`; the prototype sends one `inbox.approve` per item). A toast reports "Approve: 9 of 9 applied"; a refusal for any one names it and the reason, and that item stays.
5. He rejects one by mistake. Undo on the toast returns it to waiting.
6. Later he taps Failed 14: each shows its reason and code ("The job stopped at the 15 minute Inbox cap before it saved its report") and has Requeue and Dismiss, so a failed item is never a dead end.
7. Search "Driftcheck" with the "All" view finds "Rules drift check read only Driftcheck" (done) with its result and its job id; the id chip copies `f28ef9de`.

## 4. A PR stuck at the fix limit

1. Overview "Needs you" shows "PR #1192 reached the fix limit (3) after 4 review rounds. Fix limit reached: 1 blocking finding remains and it is about the description only: the description gives a wrong line count. The rebase is also capped after 2 attempts with the same cause."
2. Controls on that item, in order of how little they cost:
   - **Fix the description** (`work_item.fix_description`): edits the PR description, no fix round, then one review.
   - **Accept split**: disabled, with the reason "No split has been proposed for this PR yet." When Foreman has parked the PR and drafted a split (open issue #1240), the parts are listed in the panel and the button is live.
   - **Allow one more fix round**, **Clear retry cap**, **Park**.
3. He taps Details. The panel shows the four review rounds with each finding marked blocking or not and its scope, fix 3 of 3, rebase 2 attempts capped with the cause "Rebase refused: the result would lose changes", the eight requirements with 7 met, the four jobs with tokens, and the timeline.
4. The same panel shows the decision proposal the PR carries, by its stable key, with "register number not assigned until it merges". Approving it (`decision.approve`) refers to the key, so the approval can never name a number that later changes.
5. He taps Fix the description, gives a reason, confirms. The item leaves "Needs you" when the core accepts it; if the next review passes, the PR moves to ready to merge without a fix round or a rebase.

## 5. An install that failed verification

1. After a merge, Foreman installs and runs the item's live checks. A check fails. The core raises a fault (not a homeowner wait): state `failed`, reason code `live_check_failed`, text naming the line, for example `GET /api/v1/appbar -> 200 contains "agents"` answered 404.
2. All clients: the state chip shows the fault triangle, Overview "Faults" gains "Install of 82806c9 failed verification", with the change it came from and the check that failed.
3. He opens the System screen (`installs`): installed, running and main versions; the install's steps; each live check with expected and actual; whether the upgrade latch is on and why.
4. If Foreman rolled back, the latch is on: "Automatic upgrades are paused: the upgrade was rolled back (reason). Merged work is not installed until the latch is cleared." Control: Clear latch (`upgrade.clear_latch`, a person only, reason required), enabled only when a fix has merged or he chooses to retry.
5. The merged change's stage stays `merged`, not `installed` or `verified`, in the Queue, so the pipeline counts stay honest.
6. A homeowner only step from the item (a credential, a physical act) appears under "Needs you" with its text and Mark done, and stays there until he marks it.

## 6. Allowance running out

1. The app bar figure for an agent passes the high water mark: the weekly figure gains the "High" level (shape and word in the popover, a thicker meter); at "Near limit" the agent's dot changes to the fault shape if work is planned that it cannot take.
2. Allowance screen: weekly and 5 hour meters, "Projected at reset 104%", "Runs out Sun 15 Nov 21:00", the scheduling mode and its reason ("Conserve: only finishing work is started").
3. Limit resets: "3 × weekly for claude (fable), expire 31 Mar 2027" with advice from the core ("Use one now: weekly is exhausted with 3 days left and 6 PRs are waiting" or "Not needed now"). Using one is his act outside Foreman; he records it with `allowance.record_limit_reset`.
4. The credit agent line shows its state, budget and spend in pounds; it takes held work only when plan agents are held.
5. If a reading goes stale meanwhile, the figures keep their last value marked "as last read" with the age; an expired window shows "?" and "Unknown". He can press Refresh reading; a cooldown refusal says when it will be allowed.
6. Waste by cause sits on the same screen: 59 rebase jobs, 86.0M tokens in 7 days, 78% from "Rebase refused: lost changes" across 28 PRs. A tap opens those jobs. He never has to ask the overseer to dig for it.

## 7. The overseer uses direct control and the homeowner undoes it

1. The overseer reads `queue` over MCP and sends `work_item.assign` for #1166 to codex with the reason "codex weekly allowance is at 31% with spare capacity."
2. The core checks: known command, tier `direct`, direct control on, reason present, target valid, review independence not broken. It applies, writes an audit entry (actor overseer, client mcp, before `agent: none`, after `agent: codex`, the undo command) and emits `command_applied`.
3. His open Queue shows the agent change in place. The Audit tab lists it at the top.
4. He disagrees (the codex reading is 9 hours old). In Audit he presses Undo on that row (`audit.undo`). The assignment returns to none, the row reads "Undone by f6b20d58", and a new entry records his undo with his reason.
5. The overseer, on its next read of `audit`, sees its action was undone and why.
6. A command outside its rights is refused and still audited: "work_item.clear_retry_cap by overseer: Refused. Clearing a retry cap needs the homeowner. Propose it instead; nothing was changed."
7. To stop all of it he flips the one switch on the Audit screen (`direct_control.set`). From then every direct command from the overseer returns `direct_control_off`, and the MCP is back to read and propose.

## 8. Swapping the web UI for another client

1. A new client needs only the base URL. It reads `GET /api/v1/meta`: contract version, read model paths, schemas, the state vocabulary with groups, the command catalogue, the event types.
2. It runs `contract-test.mjs <url>` (or its own port of it) and refuses to start against a core whose major version it does not know.
3. It draws from read models only. The terminal client in `prototype-terminal/` does this in about 110 lines: `meta` for state groups, `appbar` for the one line, `overview.stalls` for the banner, `/events` to redraw. It shares no code with the web prototype and formats times, percentages and durations itself.
4. It sends the same named commands and gets the same refusals; its actions appear in the same audit with its client name.
5. Both clients can run at once; each sees the other's commands through the event stream.
6. Replacing the web UI is then a matter of serving different static files (or none): the core, the MCP server and the other clients are untouched. A change the new client needs from the core arrives as an additive 1.N field, checked by the contract tests.
