# Team dashboard (issue #32)

Status: implemented in source on `claude/issue-32-p0-team-dashboard`; **not deployed**, no screenshot yet (see Evidence).

One read-only page that shows what the agents are doing, so the homeowner need not run supervisor commands. It is part of the supervisor payload (`supervisor/dash*.mjs`), so the existing upgrade path installs it and history survives upgrades.

## What it shows
Needs attention (pinned, red) · Agents now · Queue per agent (the dispatcher's own `Team.plan()` run over cached data, plus a reason for every issue and PR) · Usage · Graphs · the last 50 events. All values come from the supervisor's job records, the team state, and the cache and history that the tick writes.

Attention rules: `needs-homeowner` issues; blocked or failed jobs (last 48 h, unless superseded by a newer job on the same issue); failed tick with time and redacted error; no tick for more than 10 minutes (or none ever); red CI on a non-draft open PR; an agent idle while the plan has work for it (same plan seen idle in snapshots spanning 9+ minutes, or the loop disabled); and **a `paused_limit` job on a `usage_limit` event while the provider's own newest allowance record shows no exhausted window** (the 13:15 case: 34% session, 18% week). With no allowance data the pause is flagged as unverifiable, not as wrong.

## Constraints and how they are met
- **Read-only:** GET and HEAD only (405 otherwise); no forms, no script, no controls. The dashboard modules import no process spawner, GitHub client or network client (a test asserts this, and another shows `gh`, `claude`, `codex`, `git` and `curl` are never started when the page loads).
- **Spends no tokens:** the page makes no GitHub or model call. The five-minute tick (`reconcile` → `team tick`) refreshes `dashboard/cache.json` (compact PR and issue data, no bodies or comments) and appends one snapshot to `dashboard/snapshots.jsonl` under the supervisor state root (`/mnt/cache/ai-supervisor/`). Retention: 35 days and 12,000 snapshots, trimmed about hourly, hard cap 16 MiB. The cache is also written when the loop is disabled or a tick errors, so "no tick for 10 minutes" is detectable; a disabled loop is reported as disabled, not stale. Dry-run ticks write nothing.
- **Usage is never estimated:** allowance windows come from the structured data of #21 (`job.allowance`), shown with the time the provider reported them (refreshed when a job ends, not live); otherwise "unknown". Tokens and the CLI's own cost estimate are read from the provider's structured `result` / `turn.completed` line (`supervisor/usage.mjs`: counts only, never message text) and labelled "estimate, not billing". A result line longer than the 16 KiB line bound is not parsed, so those tokens show as unknown.
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
