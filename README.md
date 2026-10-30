# DevTest Infrastructure

Reusable, agent-agnostic development and UI test infrastructure for Tower/Unraid.

## Goal
On-demand, pinned official Docker-based .NET SDK 8/9/10 builds/tests and Playwright browser screenshot/responsive testing, invoked through one `dev-test` CLI. Reuse image layers and /mnt/cache caches; avoid persistent heavyweight toolchains.

## Work queue
[GitHub issues #1–#14](https://github.com/Unthred/DevTest-Infrastructure/issues) are ordered by numeric prefix and contain explicit prerequisites, deliverables and acceptance. Do not start an issue whose prerequisites are incomplete.

## Parallel agents
- **Claude:** architecture/governance #1, browser #5–#7, HA #10, docs #13, final validation #14.
- **Codex:** Docker foundation #2, .NET #3–#4, CLI #8, agent integration #9, Blazor #11, CI #12.
- Both agents work on separate branches and isolated worktrees; never touch another agent's worktree or overwrite shared handovers. Cross-review before merge.
- These are issue role hints, not GitHub user assignees. The single shared CLI contract is designed in #1 and integrated in #8.
- Project board is coordination only; issue dependencies and handover remain authoritative.

## Security
- Use **OpenBao** for credentials wherever possible, with least privilege and no secrets in Git, artifacts, issue logs or CLI arguments.
- Test browser sessions are read-only by default; no unattended mutation of Home Assistant, applications, network or other production systems.
- No privileged Docker containers or Docker socket mounted inside test containers; use the existing trusted host-side runner.
- Do not automatically reboot Tower, HA Green or other infrastructure.

## Agent startup
Start at [AGENTS.md](AGENTS.md) (`CLAUDE.md` points to it). It lists the read order: shared AI-Rules, the [decision register](docs/DECISIONS.md), the [canonical handover](docs/ai/CURRENT_HANDOVER.md), then your issue.

## Documentation map
| Document | Purpose |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Components, tracks, storage, security model |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Binding decisions, status, rejected alternatives, open questions |
| [docs/cli-contract.md](docs/cli-contract.md) | `dev-test` commands, exit codes, result schema |
| [docs/agent-provider-contract.md](docs/agent-provider-contract.md) | Provider adapter contract shared with the supervisor (#15) |
| [docs/docker-runner.md](docs/docker-runner.md) | Host-side pinned-image Docker foundation and Tower smoke (issue #2) |
| [docs/provider-observations.md](docs/provider-observations.md) | What the installed Claude and Codex CLIs expose about limits and resume (static evidence) |
- [docs/team-loop.md](docs/team-loop.md) — dispatcher, trusted verdicts, merging, post-conditions, D-019 restart, D-020 access.
| [docs/acceptance-gates.md](docs/acceptance-gates.md) | Completion states, gates and per-issue evidence |
| [docs/ai/CURRENT_HANDOVER.md](docs/ai/CURRENT_HANDOVER.md) | Canonical current state |
| [contracts/](contracts/) | Machine-readable CLI and provider contracts, with examples |

## Validation
`node tools/validate-project.mjs` checks required files, the decision register, the handover, entry points, contracts, secrets, Docker-socket/privileged use and image pinning. `node --test "tests/**/*.test.mjs"` runs it against good and deliberately broken fixtures. CI runs both.

Before each substantive report, preserve progress in the canonical handover once it exists. Record source, CI, deployed and verified states separately.

## First useful outcome
Build and test a real Blazor fixture, render browser screenshots at phone and desktop widths, detect a deliberately broken responsive page, securely capture an authenticated HA view when access is approved, and cleanly stop containers with reproducible evidence saved on Tower.

## Extensible launcher requirement
The unattended supervisor (issue #15, priority P0) must launch any **user-configured agent provider**, not just Claude or Codex. Claude and Codex are initial adapters and can run concurrently on **separate issues/worktrees**. Add providers through a versioned adapter registry and capability flags without editing core supervisor logic. Auto-resume depends on provider support; expose unsupported features rather than guessing. Preserve role-first selection in the existing `ai-agent` workflow.
