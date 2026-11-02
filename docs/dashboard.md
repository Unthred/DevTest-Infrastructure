# Team dashboard (issue #32)

Status: implemented in source on `claude/issue-32-p0-team-dashboard`; **not deployed**, no screenshot yet (see Evidence).

One read-only page that shows what the agents are doing, so the homeowner need not run supervisor commands. It is part of the supervisor payload (`supervisor/dash*.mjs`), so the existing upgrade path installs it and history survives upgrades.

## What it shows
Needs attention (pinned, red) · Agents now · Queue per agent (the dispatcher's own `Team.plan()` run over cached data, plus a reason for every issue and PR) · Usage · Graphs · the last 50 events. All values come from the supervisor's job records, the team state, and the cache and history that the tick writes.

Attention rules: `needs-homeowner` issues; blocked or failed jobs (last 48 h, unless superseded by a newer job on the same issue); failed tick with time and redacted error; no tick for more than 10 minutes (or none ever); red CI on a non-draft open PR; an agent idle while the plan has work for it (same plan seen idle in snapshots spanning 9+ minutes, or the loop disabled); and **a `paused_limit` job on a `usage_limit` event while the provider's own newest allowance record shows no exhausted window** (the 13:15 case: 34% session, 18% week). With no allowance data the pause is flagged as unverifiable, not as wrong.

## Constraints and how they are met
- **Read-only:** GET and HEAD only (405 otherwise) except the one Mark as read form POST to `/mark-read`. The dashboard modules import no process spawner, GitHub client or network client (a test asserts this, and another shows `gh`, `claude`, `codex`, `git` and `curl` are never started when the page loads).
- **Spends no tokens:** the page makes no GitHub or model call. The five-minute tick (`reconcile` → `team tick`) refreshes `dashboard/cache.json` (compact PR and issue data, no bodies or comments) and appends one snapshot to `dashboard/snapshots.jsonl` under the supervisor state root (`/mnt/cache/ai-supervisor/`). Retention: 35 days and 12,000 snapshots, trimmed about hourly, hard cap 16 MiB. The cache is also written when the loop is disabled or a tick errors, so "no tick for 10 minutes" is detectable; a disabled loop is reported as disabled, not stale. Dry-run ticks write nothing.
- **Usage is never estimated:** allowance windows come from the structured data of #21 (`job.allowance`) and, for Codex, from a model-free probe (below); each card shows the **last known reading with its age and source**. "Unknown" appears only when no reading was ever reported.
- **Stale and missing readings (issue #75).** One rule everywhere (`windowExpired` in `supervisor/allowance.mjs`): a window whose provider-reported reset time has passed is *expired*. It is greyed on the card ("reset 1h 17m ago; current use unknown"), never counts as evidence of a limit or of capacity in the Warnings rule, is ignored by model routing, and is not drawn on the chart past its reset: the line ends at the last sample before the reset, an *Expected reset* marker sits at the reported time, and a later reading starts a new segment. A record with no windows (Codex at the moment it hits its limit reports `primary: null, secondary: null`, captured as `tests/fixtures/allowance/codex-0.166.0-exec-limit-hit.token_count.json`) is status `unknown`, not a reading, and never hides an older reading. A limit pause shows "Limit reached, resets <time>" with its basis: the reset time reported with the limit, else the reset of a full, current window in the last reading, else "reset time not reported", plus when the supervisor retries. The Warnings rule ignores a capacity reading taken before the pause, and says when the full window has reset since ("the limit may be over"), always quoting the last reading and its age.
- **Model-free probe (Codex only).** Each tick reads the newest twelve Codex rollout files of the last two days (`~/.codex/sessions`, tails only, `token_count` `rate_limits` counts only, never message text) and keeps the newest record that has windows in `dashboard/cache.json` (`probes`), timed by the record itself. Codex writes these records for every session on Tower, so a paused agent's reading refreshes whenever any Codex session runs. It cannot see usage made elsewhere. Claude Code has no model-free source (its limits arrive only in a live `stream-json` run), so a Claude reading refreshes only when a Claude job runs, and is marked expired once its reset passes. Tokens and the CLI's own cost estimate are read from the provider's structured `result` / `turn.completed` line (`supervisor/usage.mjs`: counts only, never message text) and labelled "estimate, not billing". A result line longer than the 16 KiB line bound is not parsed, so those tokens show as unknown.
- **No secrets:** every free-text value passes `redact()` (emails, token shapes, bearer values, long opaque strings). Prompts, session ids and raw output are never read.
- **Hosting:** Node built-ins only. Binds to **one private LAN IPv4 address** (RFC 1918, not network or broadcast); wildcard, loopback, public addresses and names are refused. The Host header must equal `<address>:<port>` (DNS-rebinding guard). Self-contained: inline SVG and CSS, a 60 s page refresh (driven by the page script so an in-place table address is kept; a `<noscript>` meta refresh without script), strict CSP (`default-src 'none'`).
- Merge history for the graphs (`mergeLog`: PR, issue, agent, start and merge times) is recorded in the team state from this change on; earlier merges are absent, and the graphs say "no data yet" rather than guess.

## Running it (not applied by this change)
Default port **8731**. Choose the Tower LAN address explicitly (it is not guessed):
```
node /mnt/cache/ai-supervisor/current/supervisor/cli.mjs dashboard serve --host <TOWER_LAN_IPV4> --port 8731
```
Approved persistent mechanism, for the homeowner to install: a User Scripts entry "At Startup of Array" that runs the line above in the background (`nohup ... &`, one instance; check with `ss -ltn | grep 8731`). Stop it with `pkill -f 'dashboard serve'`. Nothing here is installed by the PR.

## Remote access (separate homeowner approval; documented, not applied)
Exposing the page through HAProxy or any remote path is a firewall/remote-access change that needs fresh explicit approval. If approved: terminate TLS and authenticate at HAProxy, proxy to `<TOWER_LAN_IPV4>:8731`, and pass `Host: <TOWER_LAN_IPV4>:8731` upstream (the server rejects other Host values), or extend the Host allow-list in `supervisor/dashserver.mjs` in the same change.

## Evidence
See the handover and the PR. A live screenshot needs the browser runtime of #5 (PR #27, not merged) on Tower; it has not been captured.

## v2 (issue #54)
Seven navigable pages with drill-downs, a status bar, sortable and paginated tables with footers, larger charts with range selector, legend toggles and expand, and movable cards. See [dashboard-design.md](dashboard-design.md). View model additions: `health`, `freshness`, `nextTickAt`, `version` (from `team/upgrades.jsonl`), `panels` (needs you, warnings, next), `jobs`, `verdicts`, `prs`, `issues`; attention items carry a `severity`.

## Supervisor area and copy buttons (issue #72)
Everything the overseer used to check by hand on Tower, on the page. Source: `supervisor/suphealth.mjs` (read-only: it reads files only and starts no `git`, `gh` or model process).

| Card | Source | Amber / red when |
|---|---|---|
| Version | `current` symlink (installed), `config.repo_path` `refs/remotes/origin/main` (as of the upgrader's last fetch), `team/upgrades.jsonl` (last result and reason), `team/self-upgrade.json` `prechecked` (latched targets with when they latched), `team/self-upgrade.latch`, the last tick's `selfUpgrade` step | amber: pre-check failed, not eligible, upgrader changed, diverged, origin/main latched; red: rollback latch, rolled back, rollback failed |
| Last tick | `reconcile.log` (both formats: `<time> tick` + JSON line, and the installer's `<time> rc=<n> <output>`) | red: no tick for more than two five-minute intervals, or the tick failed; amber: a skipped item or no result line |
| Leases | `leases/*` grouped by job, with agent, kind, age | red: a lease whose job is missing, completed or stopped (stale; blocks new jobs); amber: held by a blocked/failed job |
| Errors | non-JSON lines, `team.error`, self-upgrade errors, skipped reasons and non-zero `rc` in `reconcile.log` since the later of the install time and the last upgrade/rollback record | amber: any; red: the latest tick still has one |
| Local repo drift | `config.repo_path` `refs/heads/main` vs `refs/remotes/origin/main`, checked-out branch | amber: different, or not on `main` (relevant until #69) |

Drill-downs: `/supervisor/ticks` (one row per tick, sortable, filterable, paginated; `ticks.open=<time>` expands a row to every ingested verdict, action, skipped item and error) and `/supervisor/upgrades` (`team/upgrades.jsonl`, newest first). The reconcile log is read from its last 2 MiB only.

Copy buttons (all pages): next to every command shown, job and commit IDs (the full value is copied), and error messages. "Copy for overseer" on each Action needed item and each health card copies a plain-text block: what is wrong, the job record summary (status, kind, provider, ref, attempts, last event, postcondition), the PR's latest review verdict, and related `reconcile.log` lines. Worktree paths, prompts, session ids, postcondition tickets and provider output are never included. Log text passes through `redact()` plus IPv4 removal. The Action needed command for a job is now `ai-supervisor status <id>` (there is no `job` command).

The page is served over plain HTTP on the LAN, which is not a secure context, so the Clipboard API is usually unavailable. The script copies through a selected textarea and `execCommand('copy')`; if that fails it opens a dialog with the text selected. The button shows "Copied" (or "Select and copy") for 1.6 s and announces it through a live region. The buttons are hidden until the script runs. Phone: 44 px copy targets, full-width overseer buttons, stacked facts.

Gate: `tests/dashboard-supervisor.test.mjs` (unit, handler and fake-DOM tests); on Tower, `ionice -c 3 nice -n 19 node tests/supervisor-page-smoke.mjs` renders the pages from a fixture and runs the #6 layout audit at all eight standard widths in the pinned Playwright container (evidence under `/mnt/cache/appdata/devtest-infrastructure/evidence/issue-72/`).

## Estimated finish time (issue #156)

Each queued issue and open PR shows `est. HH:MM–HH:MM` (p50–p90) on the Next panel, the Work queues and the agent queue table, and `team status` prints the same text under "Estimated finish". Hovering shows the basis. The estimate is computed by `supervisor/estimate.mjs` from Foreman's own records only (no model or GitHub call):

- Step durations (implement, continue, review, fix, ci-fix, rebase) are the recorded `updatedAt - createdAt` of completed jobs; "CI" is the gap between a producing job ending and the next review of that PR starting. Percentiles are nearest-rank.
- Fix rounds: the chance is the share of reviewed PRs that got a CHANGES verdict. The p50 path includes a fix round (fix, CI, re-review) at 50% or more, the p90 path at 10% or more.
- Items are placed in queue order into the role slots and the overall cap; running jobs hold their slot for the rest of their typical time; the merge happens on the next tick.
- If an agent is out of allowance, or its forecast runs out before a step would start, that step moves to the reset time and the estimate says "(after Wed 07:18 reset)".
  A forecast stands for running out completely, so it holds every step, reviews included, to the reset. An agent in `reviews_only` mode keeps its review, fix, CI fix and rebase steps and only its implement and continue steps move.
- Known waits are listed with their own time: CI running, the allowance reset, and the self-upgrade rate limit ("upgrade waiting, next try 22:30").
- A step type with fewer than 5 recorded jobs shows "no estimate yet" rather than a guess.

## Needs you panel (issue #141)

The panel lists every open item that needs the homeowner, derived from the cache and job records on each render, so a card clears as soon as its cause does. Sources today: open issues and PRs labelled `needs-homeowner`; PRs at the fix limit (still rejected) or the review limit; blocked or failed jobs whose issue or PR is still open; a rebase that dropped commits; a failed config migration; a failed tick; and open issues that are in no agent's queue. A red-CI warning on a PR at the fix limit becomes the fix-limit card. Each card carries `text` (what happened), `tried`, `decision` (the one action) and `links` (PR, job). The header shows `Needs you (N)` instead of Idle while any card is open. When the event log (#100, #106) lands it replaces the sources and keeps this card shape.

A fix-limit or review-limit card is held back while a final job for that PR is still active: a `review`, `fix`, `cifix` or `rebase` job that is queued, running, `paused_limit` or `paused_manual` (issue #184). The card returns as soon as the job reaches a terminal status (`completed`, `failed`, `blocked` or `stopped`), so the hold cannot stick. A paused job is not hidden meanwhile: it stays on its agent card with a paused marker, and the header reads `Paused` unless a higher-ranked state (Needs you, Stuck, Unknown) applies. A job left paused by hand therefore delays the limit card but never leaves the page without a signal; the job will still use its attempt when resumed. Tests cover each status and kind and the return of the card.

## Stale server after a self-upgrade (issue #155)

A verified supervisor self-upgrade also restarts the dashboard server: the upgrade step finds the `cli.mjs dashboard serve` process (never a worker, tick or job), stops it, starts the same `--host` and `--port` from the new version, and records `dashboard_restarted` (or `dashboard_restart_failed`, with an alert) in `team/upgrades.jsonl`. If no dashboard server is running it does nothing. This code lives in `supervisor/upgrade.mjs`, an upgrader path, so the first deployment is by hand.

Until the server is on the installed version, the Warnings panel shows "Dashboard is running <old>, Foreman is on <new>; what you see may be out of date." The server re-reads `team.local.json` on every request (a bad edit keeps the last good configuration). A job record whose status this version does not know, or that cannot be parsed, shows the agent as **Unknown**, never Idle.

## Polish part 2 (issue #61)

- **Collapse cards:** double-click a card header, or use its chevron (touch and keyboard; shown once the script runs). The header stays. The state is saved with the layout, per breakpoint and page, in this browser; "Reset layout" clears it. A link to something inside a collapsed card opens the card.
- **Tables update in place:** sorting, the filter box, paging and the page-size selector fetch the same address and swap only that table's rows, footer and pager. The scroll position and focus stay, the address bar follows (`replaceState`) so every state is still bookmarkable, and a failed update falls back to a normal navigation with the scroll position stored for the new address. Each control change touches only that table's `<id>.*` parameters.
- **Filters are live:** typing filters after a 250 ms pause across number (`#41` works), title, agent and status. The footer shows "n of m".
- **No Apply button:** the page-size selector applies on change; Enter in the filter box applies at once. Without script the filter still works with Enter; the page-size selector needs the script.
- **Back to top:** a 44 px button appears after scrolling down; smooth unless the viewer prefers reduced motion; on a phone and with a bottom dock it sits above the tab bar.
- **Status colours:** the version pill reads *Up to date* (green), *Deploy needed* or *Restart needed* (amber, with the versions), *Upgrade failed* (rolled back) or *Upgrade latched* (red). The same rule feeds the System page.
- **Clickable header pills:** health, last tick, data, team loop and version each link to what explains them (`/system#att-<id>` for a Needs-you item, `/supervisor#c-h-tick`, `/supervisor#c-h-version`, `/system#c-sys`). The target card or item is outlined with `:target`.
- The script now makes one same-origin GET (the table update above); it still sends nothing.

## Since you were last here (issue #253)
A panel at the top of Overview summarises PRs merged, PRs opened, reviews (PASS / changes), issues completed, jobs failed or blocked, what needs you now, and tokens used. Every item is number + title (naming.mjs). It is built from the job records, merge log and verdicts the supervisor already keeps (`supervisor/since.mjs`): no model call, no GitHub call. Opened PRs are counted from finished implement/continue jobs; completed issues from the merge log.

- **Range:** `?since=visit` (default), `24h` or `today` (UTC day). With no marker yet, "since last visit" shows the last 24 h and says so.
- **Marker:** `dashboard/last-seen.json` on the server. It moves only when Mark as read is pressed (a same-origin form POST to `/mark-read`, no script needed), never on page load. It is set to the time the page was built, never moves backwards, and rejects a missing or foreign `Origin`, a bad host, and a future time. It is the dashboard's only write; every other request stays GET/HEAD.
- **Copy summary** puts the plain-text summary on the clipboard (same copy mechanism as issue #72). The layout is responsive and works on a phone.
