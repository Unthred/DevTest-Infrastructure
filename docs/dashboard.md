# Team dashboard (issue #32)

Status: implemented in source on `claude/issue-32-p0-team-dashboard`; **not deployed**, no screenshot yet (see Evidence).

One read-only page that shows what the agents are doing, so the homeowner need not run supervisor commands. It is part of the supervisor payload (`supervisor/dash*.mjs`), so the existing upgrade path installs it and history survives upgrades.

## What it shows
Needs attention (pinned, red) · Agents now · Queue per agent (the dispatcher's own `Team.plan()` run over cached data, plus a reason for every issue and PR) · Usage · Graphs · the last 50 events. All values come from the supervisor's job records, the team state, and the cache and history that the tick writes.

Attention rules: `needs-homeowner` issues; blocked or failed jobs (last 48 h, unless superseded by a newer job on the same issue); failed tick with time and redacted error; no tick for more than 10 minutes (or none ever); red CI on a non-draft open PR; an agent idle while the plan has work for it (same plan seen idle in snapshots spanning 9+ minutes, or the loop disabled); and **a `paused_limit` job on a `usage_limit` event while the provider's own newest allowance record shows no exhausted window** (the 13:15 case: 34% session, 18% week). With no allowance data the pause is flagged as unverifiable, not as wrong.

## Constraints and how they are met
- **Read-only:** GET and HEAD only (405 otherwise); no forms, no script, no controls. The dashboard modules import no process spawner, GitHub client or network client (a test asserts this, and another shows `gh`, `claude`, `codex`, `git` and `curl` are never started when the page loads).
- **Spends no tokens:** the page makes no GitHub or model call. The five-minute tick (`reconcile` → `team tick`) refreshes `dashboard/cache.json` (compact PR and issue data, no bodies or comments) and appends one snapshot to `dashboard/snapshots.jsonl` under the supervisor state root (`/mnt/cache/ai-supervisor/`). Retention: 35 days and 12,000 snapshots, trimmed about hourly, hard cap 16 MiB. The cache is also written when the loop is disabled or a tick errors, so "no tick for 10 minutes" is detectable; a disabled loop is reported as disabled, not stale. Dry-run ticks write nothing.
- **Usage is never estimated:** allowance windows come from the structured data of #21 (`job.allowance`) and, for Codex, from a model-free probe (below); each card shows the **last known reading with its age and source**. "Unknown" appears only when no reading was ever reported.
- **Stale and missing readings (issue #75).** One rule everywhere (`windowExpired` in `supervisor/allowance.mjs`): a window whose provider-reported reset time has passed is *expired*. It is greyed on the card ("reset 1h 17m ago; current use unknown"), never counts as evidence of a limit or of capacity in the Warnings rule, is ignored by model routing, and is not drawn on the chart past its reset: the line ends at the last sample before the reset, an *Expected reset* marker sits at the reported time, and a later reading starts a new segment. A record with no windows (Codex at the moment it hits its limit reports `primary: null, secondary: null`, captured as `tests/fixtures/allowance/codex-0.166.0-exec-limit-hit.token_count.json`) is status `unknown`, not a reading, and never hides an older reading. A limit pause shows "Limit reached, resets <time>" with its basis: the reset time reported with the limit, else the reset of a full, current window in the last reading, else "reset time not reported", plus when the supervisor retries. The Warnings rule ignores a capacity reading taken before the pause, and says when the full window has reset since ("the limit may be over"), always quoting the last reading and its age.
- **Model-free probe (Codex only).** Each tick reads the newest twelve Codex rollout files of the last two days (`~/.codex/sessions`, tails only, `token_count` `rate_limits` counts only, never message text) and keeps the newest record that has windows in `dashboard/cache.json` (`probes`), timed by the record itself. Codex writes these records for every session on Tower, so a paused agent's reading refreshes whenever any Codex session runs. It cannot see usage made elsewhere. Claude Code has no model-free source (its limits arrive only in a live `stream-json` run), so a Claude reading refreshes only when a Claude job runs, and is marked expired once its reset passes. Tokens and the CLI's own cost estimate are read from the provider's structured `result` / `turn.completed` line (`supervisor/usage.mjs`: counts only, never message text) and labelled "estimate, not billing". A result line longer than the 16 KiB line bound is not parsed, so those tokens show as unknown.
- **No secrets:** every free-text value passes `redact()` (emails, token shapes, bearer values, long opaque strings). Prompts, session ids and raw output are never read.
- **Hosting:** Node built-ins only. Binds to **one private LAN IPv4 address** (RFC 1918, not network or broadcast); wildcard, loopback, public addresses and names are refused. The Host header must equal `<address>:<port>` (DNS-rebinding guard). Self-contained: inline SVG and CSS, a `<meta refresh>` every 60 s, strict CSP (`default-src 'none'`).
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
