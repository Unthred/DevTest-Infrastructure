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
Read the shared `Unthred/AI-Rules` agent governance and project-specific rules, then review the open queue. Issue #1 must create `docs/DECISIONS.md`, `docs/ai/CURRENT_HANDOVER.md` and the normative local entry points. Until then, this README and issue bodies are the project bootstrap.

Before each substantive report, preserve progress in the canonical handover once it exists. Record source, CI, deployed and verified states separately.

## First useful outcome
Build and test a real Blazor fixture, render browser screenshots at phone and desktop widths, detect a deliberately broken responsive page, securely capture an authenticated HA view when access is approved, and cleanly stop containers with reproducible evidence saved on Tower.
