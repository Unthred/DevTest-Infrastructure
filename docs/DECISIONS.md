# Decision register

Binding architecture and governance decisions for DevTest Infrastructure. Format and rules follow the shared AI-Rules *decision governance* policy.

- Only `homeowner-approved` entries bind. `agent-proposal` entries are the current best design and stay open to review; `temporary-note` entries carry a retirement condition.
- Never delete an entry. Replace it by adding a new dated entry and setting `Superseded-by` on the old one.
- Before significant work, read this file and check the plan against every entry. A change that revives a **Rejected** alternative is blocked until a new dated entry is approved.
- Location: the issue that created this register (#1) names `docs/DECISIONS.md`. The shared policy's default is `docs/ai/DECISIONS.md`; this project uses the issue's path (D-014).
- Provenance: `homeowner brief 2026-10-29` is the homeowner's task text, issue #1 and the repository README they directed. Unless stated, "approved" means approved in that text, not inferred.

## D-001 — One `dev-test` CLI is the only entry point
- Status: homeowner-approved
- Date: 2026-10-29
- Source: homeowner brief 2026-10-29; README; issue #8
- Decision: Agents and humans run builds, tests and browser checks only through the single `dev-test` CLI. Its behaviour is the contract in `docs/cli-contract.md` and `contracts/cli.v1.json`.
- Rationale: One stable, agent-agnostic surface keeps results comparable and lets policy be enforced in one place.
- Rejected: Per-agent scripts; ad-hoc `docker run` invocations by agents; a second launcher.
- Superseded-by: none

## D-002 — Two independent reusable tracks
- Status: homeowner-approved
- Date: 2026-10-29
- Source: homeowner brief 2026-10-29; README; issue #1
- Decision: Track A is on-demand .NET SDK 8, 9 and 10 build/test. Track B is on-demand Playwright browser testing. Browser tests must not depend on the .NET runtime.
- Rationale: Each track can be built, cached, updated and tested on its own and reused by other projects.
- Rejected: One combined toolchain image; a persistent shared dev container.
- Superseded-by: none

## D-003 — On-demand containers, none long-lived
- Status: homeowner-approved
- Date: 2026-10-29
- Source: homeowner brief 2026-10-29; README; issue #1
- Decision: Test and build containers start for a run and are removed when it ends, including on failure, timeout and interrupt. No persistent heavyweight toolchains.
- Rationale: Keeps Tower light and runs reproducible. Leftover containers are a defect (exit code 7).
- Rejected: Always-on build agents; persistent browser containers.
- Superseded-by: none

## D-004 — Official images, immutably pinned
- Status: homeowner-approved
- Date: 2026-10-29
- Source: homeowner brief 2026-10-29; README; issue #1
- Decision: Only official vendor images, referenced by immutable digest. Digests are recorded in one lock file with the tag they were resolved from and the date. Tags alone are never trusted.
- Rationale: Reproducible runs and auditable updates. Update policy is defined in issue #12.
- Rejected: Floating tags (`latest`, `8`); community or self-built base images without a recorded reason.
- Superseded-by: none

## D-005 — Unraid cache storage, reusing image layers and caches
- Status: homeowner-approved
- Date: 2026-10-29
- Source: homeowner brief 2026-10-29; README; issue #1
- Decision: Caches, run workspaces and evidence live on the Unraid cache pool, not the array and not inside Git. Image layers and package caches are reused across runs.
- Rationale: Fast, avoids repeated downloads and array spin-up.
- Rejected: Array storage; per-run cold caches.
- Superseded-by: none

## D-006 — Storage layout under `/mnt/cache/appdata/devtest-infrastructure`
- Status: agent-proposal
- Date: 2026-10-29
- Source: issue #1 (Claude); host check: `/mnt/cache/appdata` exists, Docker root is `/var/lib/docker` on btrfs
- Decision: `cache/nuget`, `cache/playwright`, `runs/<run-id>/{src,work,out}`, `evidence/<run-id>`, `state/`. Evidence is separate from run workspaces so cleanup of a run never deletes retained evidence.
- Rationale: Follows the Unraid appdata convention; one directory to back up or purge.
- Rejected: Writing under the repository checkout; `/tmp`.
- Superseded-by: none

## D-007 — No Docker socket, no privileged containers
- Status: homeowner-approved
- Date: 2026-10-29
- Source: homeowner brief 2026-10-29; README (Security); issue #1
- Decision: No test or build container ever mounts the Docker socket or runs privileged. Containers are started only by the trusted host-side runner. `contracts` validation and CI reject `docker.sock` and `--privileged` outside prohibitions in prose.
- Rationale: A Docker socket in a container is host root. Agents run untrusted project code.
- Rejected: Docker-in-Docker; socket proxies inside the test container.
- Superseded-by: none

## D-008 — OpenBao for credentials, least privilege, never in arguments
- Status: homeowner-approved
- Date: 2026-10-29
- Source: homeowner brief 2026-10-29; README (Security)
- Decision: Credentials come from OpenBao wherever possible, through a scoped read-only identity. They never appear in Git, artifacts, issue text, logs or command-line arguments. The delivery mechanism into a container is decided in issue #7.
- Rationale: Arguments leak via process listings and logs. Scoped identities limit blast radius.
- Rejected: `.env` files in the repository; secrets in CLI flags; the root or unseal token.
- Superseded-by: none

## D-009 — Read-only by default; no unattended production mutation
- Status: homeowner-approved
- Date: 2026-10-29
- Source: homeowner brief 2026-10-29; README (Security); issue #10
- Decision: Browser sessions are read-only by default. Nothing unattended mutates Home Assistant, applications, the network or other production systems. A mutating action needs an explicit, per-run, human-approved scope.
- Rationale: Test tooling must not become a production risk.
- Rejected: Blanket write access for authenticated test accounts.
- Superseded-by: none

## D-010 — No automatic reboot of infrastructure
- Status: homeowner-approved
- Date: 2026-10-29
- Source: homeowner brief 2026-10-29; README (Security)
- Decision: Nothing in this project reboots Tower, HA Green or other infrastructure automatically.
- Rationale: Production hosts.
- Rejected: Reboot-to-recover automation.
- Superseded-by: none

## D-011 — One writer per worktree; separate branches; cross-agent review
- Status: homeowner-approved
- Date: 2026-10-29
- Source: homeowner brief 2026-10-29; README (Parallel agents); issue #1, #9
- Decision: Each agent works on its own branch in its own worktree. Never touch another agent's worktree or overwrite a shared handover. Every PR is reviewed by the opposite agent before merge.
- Rationale: Prevents silent overwrites and self-acceptance.
- Rejected: Shared worktrees; self-merge; Git fixtures run inside a linked worktree (their `.git` is a pointer, so fixture commits would land on the real branch; fixtures use independent clones or `git init`).
- Superseded-by: none

## D-012 — Provider-agnostic agents; the supervisor (#15) is P0 and independent
- Status: homeowner-approved
- Date: 2026-10-29
- Source: README (Extensible launcher requirement); issue #15
- Decision: The unattended supervisor launches any registered agent provider through a versioned adapter registry with capability flags. Claude and Codex are initial adapters. The supervisor extends the existing `ai-agent` launcher (no second launcher) and does not wait for the Docker platform. Contract: `docs/agent-provider-contract.md`, `contracts/provider-manifest.v1.schema.json`.
- Rationale: Providers differ in limits, billing, login and resume; core logic must not branch on them.
- Rejected: Hard-coded Claude/Codex branches in supervisor core; a parallel launcher; automatic fallback to another billing method.
- Superseded-by: none

## D-013 — Canonical handover and four separate completion states
- Status: homeowner-approved
- Date: 2026-10-29
- Source: README (Agent startup); issue #1; shared decision-governance policy
- Decision: `docs/ai/CURRENT_HANDOVER.md` is canonical. It is updated before each substantive report. It records `implemented in source`, `CI/review passed`, `deployed`, and `verified working` separately for each item. Green CI or a merged PR is never reported as working.
- Rationale: Resume from repository state, not chat memory.
- Rejected: Chronological-only logs; status held only in chat or on the project board.
- Superseded-by: none

## D-014 — Register path is `docs/DECISIONS.md`
- Status: homeowner-approved
- Date: 2026-10-29
- Source: issue #1 ("Create … docs/DECISIONS.md")
- Decision: This project keeps the register at `docs/DECISIONS.md`, deviating from the shared policy's default `docs/ai/DECISIONS.md`. The handover links it near the top.
- Rationale: The issue specifies the path.
- Rejected: Keeping two copies.
- Superseded-by: none

## D-015 — Container hardening baseline
- Status: agent-proposal
- Date: 2026-10-29
- Source: issue #1 (Claude); builds on D-007
- Decision: Every run container uses a non-root user, `--cap-drop ALL`, `no-new-privileges`, a read-only root filesystem with explicit tmpfs/volumes, bounded CPU, memory and PIDs, a wall-clock limit, and a unique name carrying the run id. On Tower the host runner puts `/work` and `/out` together on one fixed-size ext4 loop image and the writable restore cache on a separate fixed-size loop image, so writes fail at filesystem capacity. The runner releases each run's volume after the container is removed on every outcome, reports incomplete cleanup if that fails, and sweeps stale DevTest volumes (only images under its own storage root) at the start of the next run. Build and test mount the cache read-only. The runner refuses unsafe configuration with exit code 4 and missing bounded-storage capability with exit code 3. `--memory-swap` is requested but the current kernel does not enforce swap limits.
- Rationale: Limits what untrusted project code can do or consume.
- Rejected: Relaxing the baseline per project without a recorded decision.
- Superseded-by: none

## D-016 — Network phases for the .NET track
- Status: agent-proposal
- Date: 2026-10-29
- Source: issue #1 (Claude)
- Decision: Package restore runs with network access to the package sources. Build and test run with no network. Browser runs reach only declared targets; the enforcement mechanism is an open question (OQ-2) because it may need a firewall change, which requires explicit homeowner approval.
- Rationale: Untrusted test code gets no outbound network, so it cannot exfiltrate.
- Rejected: Full network for every phase.
- Superseded-by: none

## D-017 — Exit codes and JSON result schema
- Status: agent-proposal
- Date: 2026-10-29
- Source: issue #1 (Claude); `contracts/cli.v1.json`
- Decision: Distinct exit codes separate "the subject failed" (1) from "the infrastructure failed or refused" (3, 4, 6). `--json` prints one result object on stdout and all human text on stderr.
- Rationale: An unattended agent must not mistake an infrastructure fault for a test result or the reverse.
- Rejected: A single non-zero failure code.
- Superseded-by: none

## D-018 — Branch and worktree naming
- Status: agent-proposal
- Date: 2026-10-29
- Source: issue #1 (Claude); existing practice (`codex/issue-15-supervisor`)
- Decision: Branch `<agent>/issue-<n>-<slug>`; worktree `DevTest-Infrastructure-<agent>-<n>` beside the main checkout under `/mnt/user/projects`.
- Rationale: Ownership is visible from the name.
- Rejected: Reusing a worktree across issues.
- Superseded-by: none

## D-019 — Bounded automatic restart after allowance limits
- Status: homeowner-approved
- Date: 2026-10-30
- Source: homeowner decision 2026-10-30, given to the overseer; issue #23
- Decision: When a supervised job stops on a usage limit, restart it *fresh* from issue, Git and handover state. Never resume a provider session unless its resume capability is verified. If the CLI reported a reset time and it parsed: wait until reset + 2 minutes. Otherwise: wait 1 hour, then 2 hours, then 4 hours, then block for the homeowner. That is at most three small launch attempts. No provider call while waiting. No paid fallback, no credit purchases. This supersedes the current refusal of `autoResume` for unverified providers, for this restart behaviour only. The first real limit hit for each provider must be captured, redacted, as a fixture. The reset parser stays `unverified` until it has been.
- Rationale: Unattended progress across allowance resets, with a bound on launches and cost.
- Rejected: Resuming unverified provider sessions; paid or credit fallback; polling a model while waiting.
- Superseded-by: none

## D-020 — Supervised jobs run with the same access as the homeowner's interactive agents
- Status: homeowner-approved
- Date: 2026-10-30
- Source: homeowner decision 2026-10-30, given to the overseer; issue #23
- Decision: The homeowner's agents on Tower intentionally have full access, and supervised jobs must keep it. Supervised Codex currently runs `codex exec --profile ai-rules-devtest` under the profile sandbox. Bubblewrap fails on Tower (`pivot_root: Invalid argument`), so every shell command is refused. Read the homeowner's launcher (`ai` → `/root/bin/ai-agent`, plus `/usr/local/bin/ai-rules-codex` and the deployed profiles) and launch supervised Claude and Codex with the **same effective access** as the interactive sessions. For Codex `exec` that means an explicit full-access sandbox setting. This is an explicitly selected, clearly named supervisor launch mode chosen by the homeowner (the AI-Rules "elevated mode selected by a Human" clause). It must not become a silent default for other roles. Project rules still apply: D-007, D-009, D-010, no reboots, no production Home Assistant changes and no secret disclosure.
- Rationale: The sandbox cannot start on Tower, so a sandboxed supervised job cannot run any command.
- Rejected: A silent or default elevated mode; weakening project rules.
- Superseded-by: none

## Open questions (need homeowner or a later issue)
- OQ-1: Exact secret delivery into a container (issue #7).
- OQ-2: Enforcing a browser egress allowlist on Tower without firewall changes (issues #5, #10; any firewall change is a hard approval gate). Partly answered in issue #5: with `--network=none`, a declared target that is a host-side Unix socket is enforced by the runner ([browser-runner.md](browser-runner.md)). Still open and blocked: a target that is a real TCP service.
- OQ-3: Whether Docker-dependent tests run in GitHub-hosted CI or only on Tower's runner (issue #12).
- OQ-4: Evidence retention period (issue #12/#13).
