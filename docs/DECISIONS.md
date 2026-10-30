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
- Decision: Every run container uses a non-root user, `--cap-drop ALL`, `no-new-privileges`, a read-only root filesystem with explicit tmpfs/volumes, bounded CPU, memory, PIDs and disk (per-file ulimit plus a measured aggregate budget), a wall-clock limit, and a unique name carrying the run id. The runner verifies these before start and refuses with exit code 4 otherwise.
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

## Open questions (need homeowner or a later issue)
- OQ-1: Exact secret delivery into a container (issue #7).
- OQ-2: Enforcing a browser egress allowlist on Tower without firewall changes (issues #5, #10; any firewall change is a hard approval gate).
- OQ-3: Whether Docker-dependent tests run in GitHub-hosted CI or only on Tower's runner (issue #12).
- OQ-4: Evidence retention period (issue #12/#13).
