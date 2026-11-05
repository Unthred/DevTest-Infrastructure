# Foreman MCP server (read-only, for the overseer)

Issue #569, decision D-030 (an agent proposal until the homeowner approves it). A small stdio MCP server that lets the overseer read Foreman's state from Claude desktop, over SSH to a restricted Tower account. It reads; it never writes. Posting to GitHub stays with issue #124.

## What it is
- `foreman-mcp/` holds the server: `server.mjs` (stdio entry), `protocol.mjs` (JSON-RPC and MCP), `tools.mjs`, `source.mjs`, `redact.mjs`, `calllog.mjs` and `launcher.sh`. It imports nothing from `supervisor/` and uses no npm packages.
- It is a separate process from the dashboard. It reads the dashboard's existing `/api/view.json` (a GET, cached for 20 seconds, capped at 48 MB, 10 second timeout) and `/proc`. The account cannot read Foreman's state directory, and nothing widens that.
- Tools: `foreman_status`, `foreman_review_order` (the planner's own queue, with the reason each pull request waits, is held or is not queued), `foreman_why_blocked` (a PR or an issue), `foreman_jobs` (records, tokens and cost; no transcripts), `foreman_plan`, `foreman_host` (load, memory and swap) and `foreman_reports` (reports left by hand-run sessions; see below).
- There is no live planner dry run. `team tick --dry-run` needs the state root, which the account cannot read, and may contend for the tick lock. `foreman_plan` shows the plan the dashboard computed from the same code on the last tick.
- Output is capped at 24,000 characters per result and 30 calls a minute. Secret-shaped text (tokens, keys, `Bearer` values, URL passwords, `password=` pairs, private keys) is replaced by `[redacted]` in every result and in the call log. No model is called and no usage is spent. Cost figures are the provider CLI's usage estimates, not charges.
- Every call is logged (time, tool, redacted arguments, duration, outcome) to the account's own file, rotated at 256 KB. That is the only file it writes. The launcher runs Node with `--permission`, so reads are limited to the server directory, `/proc`, the configuration file and the log directory, and writes to the log directory only.

## Session reports (`foreman_reports`, issue #612)
Hand-run Tower sessions can leave a final report for the overseer in one fixed folder, so the homeowner no longer carries it by hand. Raw session logs are never exposed: they can hold secrets. With no argument the tool lists the reports (name, time, size), newest first; with a name it returns that one report as text.
- **Folder:** `reportsDir` in the server configuration (and `REPORTS_DIR` in `launcher.env`, which gives the launcher read access to it). Create it owned by root with group `foreman-mcp`, directory mode 750, files mode 640 (group-readable). Only the owner writes. The server never writes there.
- **Names:** one path component, letters, digits, dot, dash and underscore, at most 80 characters, ending `.md` or `.txt`, and not starting with a dot. Anything else, including separators, `..`, absolute paths and encoded forms, is refused. Files that do not match are not listed.
- **Symbolic links** are never followed: they are not listed, and opening one is refused (`O_NOFOLLOW`).
- **Size:** at most 256 KB is read from a file; a result over the output limit (24,000 characters) is cut with a marker `[truncated: N more characters not shown]`. The existing secret redaction is applied to the text, and each call is logged like every other tool.

## Install (on Tower, as root; needs the homeowner's approval of D-030)
1. Copy `foreman-mcp/` to a persistent directory owned by root and read-only to the account, outside every Foreman checkout and not on the RAM disk, for example `<install dir>/foreman-mcp`. Record the commit it came from in a `VERSION` file beside it.
2. Write the configuration, owned by root and readable by the account: `{ "viewUrl": "http://<dashboard host>:<port>/api/view.json", "logFile": "<account home>/logs/calls.log" }`. Use the address the dashboard serves on; it is not kept in Git.
3. Write `launcher.env` beside `launcher.sh`: `NODE_BIN=<absolute node>`, `CONFIG_FILE=<configuration file>`, `LOG_DIR=<account home>/logs`.
4. Create the account `foreman-mcp`: locked password, its own home, no extra groups, and a login shell that can run the forced command (for example `/bin/sh`). Create the log directory owned by the account, mode 0700.
5. Put one line in `<account home>/.ssh/authorized_keys` (home mode 0755 or tighter and owned by root or the account, `.ssh` 0700, file 0600, all owned by the account):
   `restrict,command="<absolute path>/launcher.sh" ssh-ed25519 <public key> <comment>`
   `restrict` turns off the pty, port, agent and X11 forwarding and `~/.ssh/rc`, and the forced command ignores whatever the client asks to run.
6. If sshd uses `AllowUsers` or `AllowGroups`, the account must be listed. Check with `sshd -T` (read-only); do not reload sshd without the homeowner.

## Claude desktop configuration
In Claude desktop's MCP configuration, add a server that runs `ssh` and speaks MCP over its stdin and stdout, with placeholders for your values:
```
{ "mcpServers": { "foreman": { "command": "ssh", "args": ["-i", "<path to the private key>", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "foreman-mcp@<tower host>"] } } }
```
The server works only while the computer and Claude desktop are running. Nothing is exposed to the internet and no listening port is added.

## Revoke access
Remove the one line from `<account home>/.ssh/authorized_keys`, or lock the account (`usermod -L foreman-mcp`), or delete it (`userdel foreman-mcp`). Remove the server directory and the configuration if the server is retired. On Unraid, also remove the line that recreates the account from `/boot/config/go` and the script it runs.

## Checks
`node --test tests/foreman-mcp.test.mjs` covers the protocol, agreement with the planner's order, the proof that it cannot modify Foreman state (a fake state tree is byte-for-byte unchanged, only GETs reach the dashboard, and the permission model refuses other writes), bounded output, and no secret-shaped output. The restricted-key check required by #569 (no shell, no other command, no pty, no forwarding, tools callable over SSH) is a recorded manual check on the host.
