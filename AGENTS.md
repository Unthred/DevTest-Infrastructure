# DevTest Infrastructure — agent entrypoint

Normative for every agent (Claude, Codex or any registered provider). Short on purpose: the detail lives in the linked files, and no task state is kept here.

## Read first, in this order
1. The shared AI-Rules loaded by your launcher (host safety, secrets, change control, decision governance). This file adds project rules; it does not replace them.
2. [`docs/DECISIONS.md`](docs/DECISIONS.md) — binding decisions. Check your plan against every entry before significant work; a conflict stops you until the homeowner approves a new dated entry.
3. [`docs/ai/CURRENT_HANDOVER.md`](docs/ai/CURRENT_HANDOVER.md) — current state, owners, blockers, next actions.
4. The issue you are working and its live branch/PR.
Resume from repository state, never from assumed chat memory.

## Rules that always apply
- **One entry point.** Build and test through the `dev-test` CLI ([`docs/cli-contract.md`](docs/cli-contract.md)). No ad-hoc `docker run`, no second launcher.
- **One writer per worktree.** Work on `<agent>/issue-<n>-<slug>` in `DevTest-Infrastructure-<agent>-<n>`. Never edit, reset, stash or clean another agent's worktree, and never overwrite a shared handover. Git fixtures in tests use independent clones or `git init`, never a linked worktree.
- **Opposite-agent review** before any merge. You do not merge your own PR.
- **Secrets.** OpenBao only, scoped and read-only. Never in Git, logs, artifacts, issue text or command-line arguments.
- **No Docker socket, no privileged containers**, images pinned by digest, containers removed after every run.
- **Read-only against production.** No unattended mutation of Home Assistant, applications or the network. No reboots. Firewall or remote-access changes need fresh explicit homeowner approval.
- **Handover write-through.** Update `docs/ai/CURRENT_HANDOVER.md` before each substantive report and before you exit. Report *implemented*, *CI/review passed*, *deployed* and *verified working* separately ([`docs/acceptance-gates.md`](docs/acceptance-gates.md)).
- **Do not start an issue whose prerequisites are not done.** Issue #15 (supervisor) is P0 and independent.

## Checks before you push
```
node tools/validate-project.mjs
node --test "tests/**/*.test.mjs"
```

## Map
[`README.md`](README.md) · [`docs/architecture.md`](docs/architecture.md) · [`docs/agent-provider-contract.md`](docs/agent-provider-contract.md) · [`contracts/`](contracts/)
