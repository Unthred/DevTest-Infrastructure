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
- Decision: Each agent works on its own branch in its own worktree. Never touch another agent's worktree or overwrite a shared handover. Every PR is reviewed by the opposite agent before merge. Narrowed by D-021: an interim same-provider review while every other agent is out of allowance. Note (issue #1070): the "opposite agent" wording is replaced by D-024 (a fresh session on a different model; a different provider is not required).
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
- Superseded-by: D-023 (partly: who may edit the handover and when; the file stays canonical and the four states stay separate)

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
- Decision: Every run container uses a non-root user, `--cap-drop ALL`, `no-new-privileges`, a read-only root filesystem with explicit tmpfs/volumes, bounded CPU, memory and PIDs, a wall-clock limit, and a unique name carrying the run id. On Tower the host runner puts `/work` and `/out` together on one fixed-size ext4 loop image and the writable restore cache on a separate fixed-size loop image, so writes fail at filesystem capacity. The per-file `fsize` ulimit is secondary to those hard volume ceilings. For official .NET SDK images only, it is finite at 3 TiB because CoreCLR's W^X allocator uses a sparse 2-TiB memfd subject to RLIMIT_FSIZE; actual writable `/work`, `/cache` and `/tmp` remain hard bounded. The runner releases each run's volume after the container is removed on every outcome, reports incomplete cleanup if that fails, and sweeps stale DevTest volumes (only images under its own storage root) at the start of the next run. Build and test mount the cache read-only. The runner refuses unsafe configuration with exit code 4 and missing bounded-storage capability with exit code 3. `--memory-swap` is requested but the current kernel does not enforce swap limits.
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

## D-021 — Interim same-provider review while the opposite agent is out of allowance
- Status: homeowner-approved
- Date: 2026-10-31
- Source: homeowner decision 2026-10-31, given in a direct session; issue #81
- Decision: When every agent other than a pull request's author is out of allowance, the team loop may have the author's own provider review that pull request as an *interim reviewer*. The interim review is a separate supervised review job: a fresh session, the reviewer's own review worktree, and the agent's `interim-review` model entry (a cheaper review model or effort where the provider offers one, never the strong implement entry). Its PASS is merge-eligible without the homeowner, under the same gates as any PASS (exact head, green checks, mergeable). Every such merge is labelled `post-merge-review`, and when the regular opposite agent has allowance again the dispatcher runs its review of the merged head; a blocking finding there opens a linked issue for the homeowner. "Out of allowance" means evidence only: a provider-reported exhausted window or status, reported weekly use at or above the configured threshold, or the provider's most recent supervised job paused or blocked on a usage limit. Provider-agnostic (D-012): it applies to whichever agent is out. The interim reviewer never merges; the dispatcher does. No paid overage or credits are used to avoid it.
- Rationale: With one agent out of allowance for days nothing could merge (31 Oct: Codex at its weekly limit; PRs #41, #60 and #77 waiting). A fresh session on a different model is a weaker but real independent check, and the opposite agent still reviews afterwards.
- Rejected: Self-review in the authoring session or on the authoring model; waiting for the homeowner to review every PR while an agent is out; skipping review.
- Superseded-by: D-024 (its interim review and post-merge-review queue no longer exist; issue #1070)

## D-022 — Secret delivery: host broker, tmpfs file bind mounts
- Status: agent-proposal
- Date: 2026-10-30
- Source: issue #7 (Claude); builds on D-007, D-008, D-009, D-015; answers OQ-1
- Decision: Only a trusted host-side broker talks to OpenBao, with a read-only identity whose token comes from an owner-only file. Secrets are delivered as read-only file bind mounts at `/secrets/<name>` from a 0700 per-run directory on tmpfs (`/dev/shm`), never argv, environment, repository or cache pool. They are overwritten, deleted and revoked after every run, and the output is scanned for the values. Traces are refused on runs with secrets. Sessions are reduced to an allow-listed domain set with a capped expiry. A production (Home Assistant) entry is refused until a recorded decision confirms a dedicated `devtest-` identity. Without OpenBao only the labelled mock backend is available. Details: docs/secrets.md.
- Rationale: Environment and argv leak through inspection and logs; the container has no network, so a mounted file is the only channel that needs no token inside untrusted code.
- Rejected: Environment variables; a container-side OpenBao client; secrets on persistent storage; automatic live Home Assistant login.
- Superseded-by: none

## D-023 — The handover changes on main only, never on a feature branch
- Status: homeowner-approved
- Date: 2026-10-30
- Source: homeowner decision 2026-10-30; issue #52; amends D-013
- Decision: Feature branches (implement, continue, fix, ci-fix and rebase jobs) do not edit `docs/ai/CURRENT_HANDOVER.md`. The dispatcher's state and the dashboard are the live per-job record. The handover is updated only on main, by one post-merge step (a dispatcher-generated summary or a periodic docs pull request from a `docs/handover-*` branch). D-013 otherwise stands: the handover stays canonical and reports `implemented in source`, `CI/review passed`, `deployed` and `verified working` separately. CI fails a pull request whose branch changes the handover unless its head branch is `docs/handover-*`.
- Rationale: 30 Oct: nearly every rebase job, and the full opposite-agent re-review it forced (500k-1.2M tokens each), came from conflicts in the handover that every feature branch edited. Codex reached 75% of its weekly allowance.
- Rejected: Keeping per-branch handover edits and merging them by hand; a merge driver that hides the conflict but still produces a new head and a re-review.
- Superseded-by: none

## D-024 — Review independence by session and model, not provider
- Status: homeowner-approved
- Date: 2026-11-01
- Source: homeowner decision 1 Nov 2026 as recorded in issue #152; amends D-021 (and the "opposite agent" wording of D-011)
- Decision: A review is independent when it is a fresh session in a review worktree, the reviewer runs the tests itself, and the reviewer's model differs from the model that wrote the pull request head (taken from the dispatcher's job records). A review on the same model is refused. A different model on the same provider is a full review, so its PASS is merge-eligible with no follow-up. Post-merge reviews are no longer queued; entries queued earlier are dropped. An optional `second_opinion` configuration (path globs plus a reviewer) asks for one extra review from a different provider for pull requests touching sensitive paths (upgrader, scheduler, network, secrets) when that provider has allowance; unconfigured, none. When second_opinion is enabled and the second-opinion provider has no allowance, the PR waits and does not merge until that review is done. The dashboard and Needs you show it as 'waiting for second opinion (<provider> out of allowance until <reset>)'. second_opinion stays off unless configured. A team of one agent is valid. Status, dashboard and notices name a role and what it waits for, never an agent that "owes" work. No paid overage or credits are used to obtain a reviewer.
- Rationale: 1 Nov: six PRs (#119, #129, #131, #138, #144, #146) waited for a provider that was out until Wednesday, because only a different provider counted as independent. Session and model separation is the property that matters, and it needs no second provider.
- Rejected: Treating only a different provider as independent; queuing a mandatory post-merge review for every same-provider merge; self-review in the authoring session or on the authoring model.
- Superseded-by: none

## D-025 — A review PASS carries across a clean, unchanged, green rebase
- Status: homeowner-approved
- Date: 2026-11-02
- Source: homeowner decision 2 Nov 2026 as recorded in issue #290; builds on issues #79 and #258; does not change D-024
- Decision: A review PASS (and a configured second-opinion PASS) recorded for the head a rebase started from carries to the rebased head only when all three hold: the rebase resolved no conflicts; the pull request's patch is unchanged between the reviewed head and the new head, checked mechanically (exact patch text and hunk placement, not assumed from the job's success); and all required CI is green on the new head (a check that is skipped or neutral is not a failure and does not block a carry; this repository has no branch protection, so every check that ran and was not skipped counts as required). If any condition fails or cannot be determined, the PASS does not carry and a full review runs. A rebase that resolves a conflict always gets a re-review. Pending CI delays the carry (no review runs meanwhile); red CI or a moved head ends it. Each carry is recorded on the verdict with the old head, the new head and the evidence, is announced on the pull request and shown on the dashboard, and merge re-verifies that record against the current head. A clean rebase is still not authorship (#258) and the D-024 independence rules are unchanged.
- Accepted risk: a clean rebase can still combine badly with new code on main; CI is the only check on that.
- Rationale: A re-review of an identical patch costs 500k-1.2M tokens and feeds the rebase starvation seen in #266.
- Rejected: Carrying on job success alone; carrying across a resolved conflict; carrying while required CI is red, pending or unknown.
- Superseded-by: none

## D-026 — Writing jobs never escalate, and never use a review model
- Status: homeowner-approved
- Date: 2026-11-02
- Source: homeowner decision 2 Nov 2026 as recorded in issue #316; builds on D-024 and does not change it; approved: https://github.com/Unthred/DevTest-Infrastructure/pull/372#issuecomment-6588626267
- Decision: No writing job (implement, continue, fix, ci-fix, rebase) is automatically moved to a stronger model; the escalation entry is retired. A model that an agent is configured to review with (its `review` entry and `review_candidates`) is not assigned writing jobs automatically; this is decided from role config, not from model names. A job whose model would also leave a PR with no available independent reviewer is not started. When the implementer's model cannot finish a fix, Foreman tries a fresh session on that model with the review findings, then splitting out-of-scope findings, then stops with one Needs you item. That item does not offer paid escalation.
- Rationale: 2 Nov: Opus escalation fixes made every Claude model a writer, and five PRs (#137, #216, #217, #222, #234) could not be reviewed while Codex was out of allowance.
- Rejected: Withholding the escalation only when it would strand the PR; offering paid escalation as an option; changing D-024.
- Superseded-by: D-037 (in part: the rule that a configured review model is never assigned writing jobs, and the no escalation rule for the one case of a low risk PR that draws CHANGES twice)

## D-027 — One-off review exception for named pull requests
- Status: agent-proposal
- Date: 2026-11-02
- Source: homeowner decision 2 Nov 2026 as recorded in issue #318; does not change D-024 for any other pull request
- Decision: A time-limited `review_exception` list in the team configuration names pull requests (initially #137, #216, #217, #222 and #234) that merge by this route instead of the D-024 single independent review. Sonnet rebases a conflicting PR first. Opus, in a fresh session, reviews the whole PR (the D-024 model-independence refusal does not apply to this step). Sonnet, in a fresh session, then reviews the commits Opus wrote, identified from the dispatcher's job history. Both must PASS on the current head; a head that moves needs both again, and a PASS from an older head is not reused for the commit step. All other merge gates (CI, mergeable, requirements, second opinion) still apply. Changes requested are fixed by Sonnet only and reviewed again the same way; the fix never escalates to Opus, and a fix Sonnet cannot finish stops that PR with one Needs you item. The exception ends for each PR when it is merged or closed, or at its `expires_at` (at most 31 days out), whichever comes first; an ended entry is never revived. It covers no other PR. Every merge made this way is recorded as using it (merge log, merge comment on the PR and on the issue). The exception does nothing until this entry is homeowner-approved.
- Rationale: 2 Nov: five long-open PRs need a stronger first look than a single D-024 review gives, and a normal review of an Opus-written PR is refused by D-024.
- Accepted risk: for these PRs the Opus review of its own earlier commits is covered only by the narrower Sonnet commit review; a PR on a branch whose author is not the configured agent is repaired on that author's default models.
- Rejected: A per-PR switch that skips review; a path-based `second_opinion` (it cannot name PRs or relax D-024); Opus writing fixes.
- Withdrawn: issue #1070. Never approved, and every entry expires 9 Nov 2026; `review_exception` with its code path, tests and docs is removed. The entry stays as history, binds nothing, and needs no superseding entry.
- Superseded-by: none

## D-028 — Docker smokes run on Tower only; hosted CI is static; no dependency bots
- Status: agent-proposal
- Date: 2026-11-03
- Source: issue #298 (review follow-up to PR #294); answers OQ-3; see docs/ci-and-images.md
- Decision: GitHub-hosted CI runs only Docker-free checks (project validators, fixtures and fakes, `check-ci`) with `contents: read`, no secrets and no self-hosted runner. Docker-dependent smokes run on Tower only, and a Docker claim needs Tower evidence. Image digest freshness is a weekly scheduled check (45 days), not a merge gate. Dependabot and Renovate stay off until a later dated decision approves a scope.
- Rationale: Keeps Tower out of GitHub-triggered execution (D-007) and keeps PR gates reproducible (D-004).
- Rejected: Docker in hosted CI; a self-hosted Tower runner; bot-opened dependency pull requests now.
- Superseded-by: none

## D-029 — Dashboard writes need a secret proof and a cooldown
- Status: agent-proposal
- Date: 2026-11-03
- Source: issue #434
- Decision: Every dashboard write (POST /mark-read, POST /probe/<agent>) must carry a random secret kept in the state root (dashboard/write-token, mode 0600) as a hidden form field, compared in constant time; Host and Origin checks stay but are no longer sufficient. "Refresh allowance" also has a 5-minute per-agent cooldown kept in the state root (dashboard/write-cooldown.json), so it survives a restart; an overage-risk refusal gives the slot back. "Mark as read" has a 5-second cooldown in the same file (a refused click redirects back to the dashboard with a notice, and a bad proof or bad time takes no slot). Limit: the secret is in the served page, so this stops forged and replayed requests and blind scripts, not a client that can read the page; a login or a read-only default would be a separate decision.
- Rationale: Origin is a header a non-browser client sets freely, and each accepted probe spends allowance.
- Rejected: Trusting Origin alone; a short-lived token (more state for the same page-reader limit).
- Superseded-by: none

## D-030 — Read-only MCP server for the overseer, reached over SSH on a restricted account
- Status: agent-proposal
- Date: 2026-11-04
- Source: issue #569; the homeowner's approval comment on pull request #589: https://github.com/Unthred/DevTest-Infrastructure/pull/589#issuecomment-6644201295
- Decision: The overseer may read Foreman's state through a separate read-only stdio MCP server on Tower. It runs as its own process, never inside the dashboard, and reads the local dashboard's existing `/api/view.json` and `/proc`; it cannot modify Foreman state and makes no model call. It is reached through a dedicated unprivileged Tower account, `foreman-mcp`, with no password login. That account has exactly one SSH key in `authorized_keys`, written with `restrict` and a forced `command=` that runs the server: no shell, no pty, no forwarding, no other command. No new listening port is opened and nothing new is exposed to the internet. It works only while the homeowner's computer and Claude desktop are running. Posting to GitHub, merges, pushes, reviews, restarts and queue changes are not exposed; the write route stays with issue #124 and needs its own decision. Revoking access means removing the one `authorized_keys` line, or locking or deleting the account.
- Rationale: The overseer works from a cloud session that cannot see Foreman's state, so every question costs a Tower session and a paste. Claude's custom connectors connect from the provider's cloud and cannot reach the LAN, so the desktop configuration is the available route. D-009 keeps it read-only, D-008 keeps secrets out of its output, D-007 forbids the Docker socket and privileged access, and AGENTS.md requires fresh homeowner approval for remote-access changes.
- Rejected: A public or LAN listener for the server (a new port); sharing the dashboard's process or the root account; a shell login with a command filter; exposing any write action in this entry.
- Superseded-by: none

## D-031 — The overseer inbox: one narrow write from the MCP server, approved on the dashboard
- Status: agent-proposal
- Date: 2026-11-05
- Source: issue #124; the homeowner's approval comment on this issue: https://github.com/Unthred/DevTest-Infrastructure/issues/124#issuecomment-6649903462; extends D-030
- Decision: The `foreman-mcp` server (D-030) gains one narrow write: `foreman_propose` writes a proposal file into an inbox `items/` directory owned by the `foreman-mcp` account, and nowhere else (the launcher's Node permission model allows writes to that directory only); `foreman_proposal_status` reads back a status file that only Foreman writes. Only two kinds are accepted: `prompt` (run as one supervised Foreman job) and `issue_draft` (post as the homeowner). Foreman treats every item as untrusted: shape, size limits, a cap on pending items, a refusal of secret-shaped and AI-attribution text, and a content hash that must still match at approval and at use. Nothing runs without an approval, and approval is possible only through the dashboard's write route (D-029: Host, Origin, secret proof, cooldown), never through MCP. An approved prompt is an ordinary job: role slots, allowance, breaker, usage-limit and model rules apply, it never writes as Opus (D-026 and issue #368), and it cannot merge, approve, write a verdict or bypass a review gate. An approved issue draft is posted once (a marker is recorded and looked up before posting), redacted, with no attribution. Every proposal and decision is logged with time, kind and a hash of the content, never the content. No new listening port and no network route. Config changes and standing permissions (#102) are out of scope.
- Rationale: Every overseer prompt was pasted into a Tower session by hand. A queue that the homeowner approves with one click removes the paste without giving the overseer any ability to act on its own.
- Rejected: Approval through MCP or by a file the MCP account can write; running an item without approval; a second write path into Foreman state; free-form item kinds; a new port for the inbox.
- Superseded-by: none

## D-032 — A forecast of weekly use informs; it never holds work back
- Status: agent-proposal
- Date: 2026-11-05
- Source: homeowner decision 2026-11-05, given to the overseer: "the aim is not to spread work out over the week; the aim is to maximise the processing we can do on the server." https://github.com/Unthred/DevTest-Infrastructure/issues/680 (supersedes the forecast rules of issue #627 and PR #644)
- Decision: The projection of weekly use (rate, projected use at the reset, run-out time) is an estimate shown on the dashboard and used only to choose between agents. It never sets `reviews_only` or any other mode, never latches, and never moves a scheduling estimate. Actual use still holds work: the paid-overage stop, `exhausted_at` on a weekly or short window, a provider-reported limit, and the high-water reserve (reviews and fixes only at 85 % used with more than `high_water_min_hours` left) are unchanged, as is the per-job cost check against the weekly limit.
- Rationale: Spreading work over the week left the server idle while allowance remained, and a forecast built from a few hours after a reset held Claude off implementation at 9 % to 11 % used.
- Rejected: A better forecast (issue #627: a minimum of evidence, a self-releasing latch), a forecast margin setting, and switching allowance-aware scheduling off, which would also disable the overage check.
- Superseded-by: D-036 (in part: the statement that a projection never moves scheduling; it may now reorder work by D-036 rule D2 and still never sets a mode or holds work by itself)

## D-033 — Inbox actions: named job operations approved on the dashboard
- Status: agent-proposal
- Date: 2026-11-05
- Source: issue #629; extends D-031
- Decision: The inbox (D-031) gains a third kind, `action`, with a fixed list of names and one target each: `new_review_attempt` (a pull request number), `reopen` (an issue number), `close_job`, `stop_job` and `resume_job` (the 8-character job id). The item carries a title and a reason of at most 300 characters and no command, path or other argument. Approval is the same as for every inbox item: the dashboard's write route only (D-029), never MCP and never an agent job. On the next tick Foreman records `running` before it acts (at most once), re-checks the target and refuses a wrong one with a reason, changing nothing. `new_review_attempt` lowers each review-attempt counter at the limit for that head by one, and is refused with attempts left, a verdict, or a live review. `reopen` is the existing `team reopen` with all its checks. `close_job` applies only to a blocked, failed or stopped job whose pull request head has moved on; its worktree is saved first (uncommitted work committed on the job branch, ignored files excluded, and pushed to a new `saved/` branch on the remote), and the job is closed only if git then proves the tree clean and nothing local unpushed. `resume_job` is refused for a job on an overtaken head, when the agent is out of allowance, or when the provider role is full. Every outcome is logged in the inbox audit log and the unblock log.
- Rationale: Jobs overtaken by a newer head, attempts spent by Foreman's own faults and stuck marks needed a terminal; each is now one reviewed click, with the same safeguards as the terminal commands.
- Rejected: A free-form command or argument in an item; approval through MCP; closing a job without saving its work; a count of extra review attempts larger than one per approval.
- Superseded-by: none

## D-034 — The circuit breaker judges by repeat cause and cost, clears itself on success, and a person can resume it from the dashboard
- Status: agent-proposal
- Date: 2026-11-06
- Source: issue #626 (changes the safety design of issue #549 and D-029/D-030 style write protection)
- Decision: The breaker for wasted usage (issue #549) trips a cause when the same pull request (or issue) wastes `same_cause_jobs` (3) jobs of that cause inside the window, or when the cost of the waste is meaningful ($5 of one cause or of any kind; $15 across causes stops every new job). A few cheap failures across unrelated pull requests no longer trip it. A halt holds only the pull requests or issues that wasted (with a count trip, only those that repeated; with a cost trip, every one that wasted); the same type of work on other pull requests or issues keeps running, so a cause such as context_too_large can still waste one job on each new pull request until the cost limit or the global limit is reached. A halt recorded before this change, with no subject list, keeps holding the whole type. A halt of a job type ends by itself when a later job of that type, created after the halt began, completes and is not waste; a job already running when it tripped does not count, and the global halt is not cleared this way. A person can also press Resume on the breaker's dashboard card: the form post carries the D-029 access proof, passes the Host and Origin checks, has a 5-second cooldown, must carry the browser's same-origin user-click markers (Sec-Fetch-Site same-origin, Sec-Fetch-User) and is refused by a dashboard running under a supervised job, and for a request from this machine the dashboard finds the calling process (the loopback socket's owner in /proc) and refuses one that descends from a supervised job or cannot be identified. The dashboard does not edit Foreman state: a click leaves a request file and the next tick applies it. Agents and supervised jobs have no supported route to resume; the terminal command keeps its terminal and supervised-job checks. Standing limits stay: the higher global limit, running jobs finishing, and a halt surviving a restart until a success or a resume clears it. Limit: the click markers and the proof stop forged requests and blind scripts, not a client that reads the page and forges the headers, or an agent with full access that edits files directly (the same limit as D-029).
- Rationale: On 5 Nov 2026 three cheap failures ($0.39 and $1.15) across different pull requests tripped the breaker twice and halted all new work of that type until a person ran a terminal command. Repetition on one pull request and real cost are the signals of a loop; a later success is the signal of recovery.
- Rejected: Expiring a halt by time (a halt would end without evidence); letting a job already running at the trip clear it; letting the dashboard edit Foreman's state file directly (two writers); an agent-callable resume.
- Superseded-by: none

## D-035 — A CHANGES verdict carries across a clean rebase until a fix lands
- Status: agent-proposal
- Date: 2026-11-08
- Source: issue #1048; builds on D-025 and does not change it or D-024
- Decision: When a pull request's latest verdict is CHANGES and the only thing since that verdict's head is a rebase that resolved no conflict and left the patch unchanged (the same mechanical evidence as D-025: no lost commit or change, exact patch text and hunk placement), the CHANGES verdict and its findings carry to the new head, with a public comment and a carry record. The pull request stays in the fix lane and no review is queued. CI state is not a condition (a carry only keeps a block; red CI is handled by the CI-fix path). A review is queued again only after a fix or CI-fix job pushes a commit that is not a rebase. A carried CHANGES does not count as a further CHANGES round for escalation or churn. At the fix limit, a pull request holding a carried CHANGES gets its one Needs you item at once (no final round first) and is held from rebase, further fix rounds and review until the homeowner decides (finish with a named list of findings, restart smaller, or close); a requested re-review (issue #418) sets the verdict aside and lifts the hold. The pull request card shows the old head, the new head and the findings carried.
- Rationale: 8 Nov 2026, PR 979: two rebases bought two full reviews (1.6M and 2.5M tokens) of a patch whose blocking findings no fix had addressed.
- Rejected: Carrying across a resolved conflict; carrying a CHANGES past a non-rebase commit; waiting for green CI before carrying a block.
- Superseded-by: none

## Open questions (need homeowner or a later issue)
- OQ-1: Exact secret delivery into a container (issue #7). Proposed answer: D-022, awaiting review and homeowner approval.
- OQ-2: Enforcing a browser egress allowlist on Tower without firewall changes (issues #5, #10; any firewall change is a hard approval gate). Partly answered in issue #5: with `--network=none`, a declared target that is a host-side Unix socket is enforced by the runner ([browser-runner.md](browser-runner.md)). Still open and blocked: a target that is a real TCP service.
- OQ-3: Whether Docker-dependent tests run in GitHub-hosted CI or only on Tower's runner (issue #12). Proposed answer: D-028, awaiting homeowner approval.
- OQ-4: Evidence retention period (issue #12/#13).

## D-036 — Scheduler model: finish before starting, one ranking, admission by review capacity
- Status: agent-proposal
- Date: 2026-11-08
- Source: homeowner decisions in chat 8 Nov 2026, recorded on issue #1064; reconciled by issue #1070
- Decision: (1) Finish before starting. (2) One ranking, with the tiers agreed on 8 Nov, is used by every lane (review, fix, rebase, implement). (3) New work is admitted by review capacity. (4) Few open PRs per hot file. (5) Every stuck PR gets a decision (a Needs you item), and a PR that no reviewer can review now leaves the ranking. (D1) Implementers may idle while review is full. (D2) When projected weekly use exceeds 100 %, cheaper-to-finish work ranks first. (D3) The parked PR limit pauses tiers 3 to 6. Supersedes the part of D-032 that says a projection never moves scheduling: the projection may reorder work by D2; it still never sets a mode or holds work by itself.
- Rationale: Tokens, not slots, are the limit: about 3.9M tokens per merged PR, and rework about 47 %.
- Rejected: Starting new work whenever a slot is free; separate orderings per lane.
- Superseded-by: none

## D-037 — Model choice by risk
- Status: agent-proposal
- Date: 2026-11-08
- Source: homeowner decisions in chat 8 Nov 2026; reconciled by issue #1070
- Decision: Low risk work is implemented on Haiku and reviewed on Sonnet. Review independence is judged per PR: a model may review a PR it wrote no commit on (D-024 otherwise unchanged). A low risk PR that draws CHANGES twice moves to the standard class (Sonnet fix, Opus review) for the rest of its life. Opus still never writes. Supersedes, in part, D-026: the rule that a configured review model is never assigned writing jobs, and the no escalation rule for this one case.
- Rationale: Cheaper models for low risk work save tokens; independence only needs a different model per PR.
- Rejected: Escalating any other writing job; letting Opus write.
- Superseded-by: none

## D-038 — The overseer may hold work back or stop a job without a click
- Status: agent-proposal
- Date: 2026-11-09
- Source: the pausing direction agreed on 9 Nov 2026 in V2 item 2; issue #1115; narrows D-031 ("nothing runs without an approval") for two holding actions only
- Decision: The inbox gains a kind `control` with exactly two fixed names: `park` (apply the existing `parked` label to one issue or pull request through Foreman's own label path) and `stop_job` (the supported stop of one job). Foreman runs a control item on its next pass without a dashboard click, never counts it against the pending limit, and records who, when, why and the result in its status and in the dashboard view. Releasing stays a click: `unpark` is an ordinary `action` item the homeowner approves on the dashboard. A control item cannot merge, approve, release, start a job or change a limit; every other D-031 rule (shape, size, secret and attribution refusal, content hash, audit) applies unchanged.
- Rationale: A runaway job spent allowance for several minutes while waiting for a click that could only stop it. Holding back and stopping lose nothing that cannot be reversed by one approved unpark or a new job, so the click adds delay without protection; releasing is the direction that needs it.
- Rejected: A click for park and stop; a direct unpark; a free-form command in a control item.
- Superseded-by: none
