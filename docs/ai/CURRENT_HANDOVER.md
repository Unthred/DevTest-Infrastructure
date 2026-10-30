# Current handover

Binding decisions: [docs/DECISIONS.md](../DECISIONS.md) (20 entries; D-019 and D-020 are homeowner-approved, recorded by PR #25; D-006 and D-015–D-018 remain agent proposals). Entry point: [AGENTS.md](../../AGENTS.md). Gates: [acceptance-gates.md](../acceptance-gates.md).

Last updated: 2026-10-30 by Codex on `codex/issue-2-docker`, based on merged architecture and supervisor PRs. Each agent edits this file only on its own branch.

## Completion states

| Item | Implemented in source | CI/review passed | Deployed | Verified working |
|---|---|---|---|---|
| #1 Architecture, decisions, contracts, validator | yes (PR #16, merged as `77d7e228113e09a0a0d94edbec030f5dc3d3ec09`) | yes: exact-head CI and GitGuardian green; Codex independent PASS on `ff46a80` | n/a (documentation and checks) | n/a |
| #15 Supervisor | yes (PR #17 merged as `69f88000798a3a55224171e15d3f8af7b2d12e37`) | yes: exact-head CI/GitGuardian green; Claude independent PASS on `baba983` | merged commit `69f8800` installed on Tower; wrapper and payload bytes verified | normal launcher/CLI smoke passed; real usage-limit reset and post-limit resume unverified |
| AI-Rules launcher metadata fix (PR #15) and `devtest` role (PR #16) | yes | CI green; independent review pending | yes, installed 2026-10-29 | Codex launch confirmed by the homeowner; Claude launch checked by recorded argv only |
| #15 regression follow-up | yes; PR #18 merged as `0240bc384bf9ee36ce6b0f87e1ea8f7f636fb9d7` | yes; Codex independent PASS at `df99dca65a0f3ea0c1f629d34ab54d91a093889c`, 42/42 local tests and exact-head CI green | not separately installed | context requeue crash window verified by fixture only |
| #2 Docker foundation | yes; PR #19 merged as `a8b944b` after PR #26 lifecycle fix | exact-head checks and Codex executable review passed | no standalone `dev-test` installation | Tower Docker and lifecycle smokes passed; CLI integration remains issue #8 |
| #20 Allowance detection | yes; PR #21 merged as `67c8aabd78ee456e5b08c10db63ad0ec4a6cffd1` | Codex PASS at rebased head `7e4e6b4`; exact-head CI green | no | Codex interactive limit capture/reset parser covered; live supervised recovery unverified |
| #23 Team loop | yes; PR #25 merged as `8f2e386` | Codex PASS at `09a1915`; exact-head CI green | no; Claude deploys after review | supervised full-access Codex job ran `node --test` at #25 head (115/115); live dispatcher tick/allowance recovery unverified |
| #3 .NET SDK toolchain | initial planner on `codex/issue-3-dotnet-build`, commit `d02e8ba` | validator OK; 119/119 tests on rebased head | no | no SDK container build yet; offline restore only |
| #4, #6–#14 other issues | not started | no | no | no |
| #5 Browser runtime | yes; PR #27 head `1b3402b` | Codex PASS, 93/93 tests and exact-head CI green | no | niced Tower browser smoke passed after pinned cache preparation; TCP targets remain blocked on OQ-2 |

## Ownership

| Agent | Issues | Branch / worktree |
|---|---|---|
| Claude | #1, #5–#7, #10, #13, #14, #20, #23; fixes for Codex #19 | separate Claude branches/worktrees; PRs #21 and #22 open |
| Codex | #15, #2–#4, #8, #9, #11, #12 | current `codex/issue-2-docker`, `/mnt/user/projects/DevTest-Infrastructure-codex-2` |

## Environment facts and evidence

## Open questions
OQ-1 secret delivery (#7), OQ-2 browser egress enforcement (#5/#10, firewall change would need explicit approval), OQ-3 where Docker-dependent CI runs (#12), OQ-4 evidence retention.

## Evidence
- Contracts: `contracts/cli.v1.json`, `contracts/provider-manifest.v1.schema.json`, examples for Claude, Codex and a generic future agent.
- Architecture acceptance: Codex ran `node tools/validate-project.mjs` (OK), `node --test 'tests/**/*.test.mjs'` (14/14), and an independent malformed-digest fixture on #16 head `ff46a80`; [review PASS](https://github.com/Unthred/DevTest-Infrastructure/pull/16#issuecomment-6517023386). Exact-head [CI 41017746345](https://github.com/Unthred/DevTest-Infrastructure/actions/runs/41017746345) and GitGuardian passed.
- Supervisor: Claude [independently accepted exact head `baba983`](https://github.com/Unthred/DevTest-Infrastructure/pull/17#issuecomment-6517178801) after a fresh clone, validator OK and 35/35 combined tests. Exact-head [CI 41018142947](https://github.com/Unthred/DevTest-Infrastructure/actions/runs/41018142947), [Supervisor 41018142805](https://github.com/Unthred/DevTest-Infrastructure/actions/runs/41018142805), [Supervisor 41018135400](https://github.com/Unthred/DevTest-Infrastructure/actions/runs/41018135400), and GitGuardian passed. PR #17 merged as `69f8800`.
- Tower normal CLI smoke: `node tests/real-smoke.mjs /mnt/user/projects/DevTest-Infrastructure-codex-15` returned exit 0, subscription authentication and completion marker for both Claude and Codex, no classified events, worktree unchanged. Earlier installed supervised issue #15 jobs completed in one attempt and released leases: Codex `802a94e403a919797c0ca7138a633ff4`, Claude `ac07b63b0f1c799acb10a97f634c6ae3`. Installed launcher behavioural tests and `--supervisor help` passed; four recorded smoke jobs were terminal with no active job at the last check.
- Installed supervisor: `bash tools/upgrade-supervisor.sh` from clean detached merged source returned `upgraded=69f88000798a3a55224171e15d3f8af7b2d12e37`. `/mnt/cache/ai-supervisor/current` and `/root/bin/ai-supervisor` point to that SHA; `diff -qr` found installed payload byte-identical to merged `supervisor/`. `/root/bin/ai-agent --supervisor help` and `/root/bin/ai-agent-tests` passed, and fresh read-only Claude/Codex CLI smokes exited 0 with subscription auth and completion marker, no worktree change. Prior wrapper backup: `/root/bin/ai-supervisor.before-69f88000798a3a55224171e15d3f8af7b2d12e37`. The User Scripts reconciliation entry is scheduled every five minutes and present once in `/etc/cron.d`; no host reboot has been tested. Original launcher backup: `/root/bin/ai-agent.before-supervisor-6cff297568806b932d353f8dfaa7c70922ed7239` (SHA-256 `b96da02b190328940e500b378184cd446d6fe4b7cbbe3f349946ee2a3f129b7a`).
- Docker foundation #2: Tower read-only `docker info` showed Docker 29.5.1, btrfs driver, cgroup v2. Local official image RepoDigests were recorded in `docker/images.lock.json` on 2026-10-30. On the branch rebased onto merged #17, `node tools/validate-project.mjs`: OK; `node --test 'tests/**/*.test.mjs'`: 43/43 pass (eight Docker, 21 supervisor and 14 architecture tests). `node tests/docker-smoke.mjs` ran positive and deliberate subject-failure probes with pinned .NET 8 digest `sha256:78235e09001f52b6592c458ac010775ebac6725422e80cd0c1650590f67b2743`; exit codes 0 and 1 respectively, both `cleanup: complete`, both containers gone, and `docker ps -a` found no `devtest-` container. No production service changed. The rootless correction permits only an owner-only XDG runtime directory and matching Unix Docker host; other host environment values remain excluded. The pre-start collision check refuses a container with the selected run name, even if it bears the same label.
- #2 exact-head [CI 41019934693](https://github.com/Unthred/DevTest-Infrastructure/actions/runs/41019934693), [Supervisor 41019934752](https://github.com/Unthred/DevTest-Infrastructure/actions/runs/41019934752), and GitGuardian passed on `7420e9b203d020b0f190434e40971430e37d92a2`. A new exact-head run is required after this handover update.
- #2 2026-10-30 correction: Codex [reviewed PR #22](https://github.com/Unthred/DevTest-Infrastructure/pull/22#issuecomment-6518406474), then [merged it as a base under explicit homeowner direction](https://github.com/Unthred/DevTest-Infrastructure/pull/22#issuecomment-6519062895). On own PR #19 branch, Codex added fixed-size no-COW ext4 loop images for aggregate work/output and restore cache bounds, read-only cache in build/test, fail-closed mount setup, `--log-driver=none` and no persisted stdout/stderr. D-015 now describes the actual controls and kernel swap-limit gap. `node tools/validate-project.mjs`: OK; `node --test 'tests/**/*.test.mjs'`: 47/47 pass. Low-priority `ionice -c 3 nice -n 19 node tests/docker-smoke.mjs`: positive exit 0, deliberate subject failure exit 7 mapped to 1, 96 MiB writes to each 64 MiB work/output and restore-cache filesystem failed inside the container with distinct subject exit 37; all four containers removed and temporary mounts/images cleaned. No new kernel warnings were observed; the earlier memory-cgroup OOM warning at 07:59:50 was from the prior memory probe. Exact-head CI and independent Claude review still pending.

- PR #18 review at `df99dca65a0f3ea0c1f629d34ab54d91a093889c`: fresh clone validator OK, full suite 42/42, exact-head project-contract/test/GitGuardian SUCCESS and merge state CLEAN. Some tests overlap #17; context requeue crash-window coverage adds value. [Codex PASS](https://github.com/Unthred/DevTest-Infrastructure/pull/18#issuecomment-6518490816); merged as `0240bc384bf9ee36ce6b0f87e1ea8f7f636fb9d7`.
- Both agents use one GitHub account. Independent acceptance is recorded with reviewer identity, exact SHA, commands and decision in PR comments; it is not a formal GitHub approval.

- Provider evidence: `docs/provider-observations.md` (static inspection of Claude Code 2.1.312 and Codex CLI 0.165.0; live captures still outstanding).

## Standing facts
- Launcher: `ai-agent` has a `devtest` role (workspace `/mnt/user/projects/DevTest-Infrastructure`). Never run `git fetch/pull` inside `/mnt/cache/cursor-workspace/ai-rules-live`; redeploy with `tools/deploy-codex-launcher.sh --source <clean checkout>`.
- Supervised jobs: `access: full` (D-020) is per job and per allowed role; the dispatcher (`team tick`) ships disabled in `supervisor/team.json`.


## Blockers
- #15 real subscription-limit wording, reset timestamp and post-limit resume are not captured. Production manifests mark those capabilities `unverified` and refuse `autoResume: true`. Simulated pause/resume is not a live auto-resume claim.
- #2 source is merged; single `dev-test` CLI integration remains issue #8. Host-side runner smokes do not claim end-to-end CLI deployment.
- Tower reboot persistence and host-restart recovery remain unverified; do not reboot Tower for this task.
- #3 is a draft implementation: safe discovery/argv planning only. Pinned SDK container build/test and NuGet cache reuse remain. Networked restore is unavailable under the current runner policy.
- #3 restore is currently offline only: the Docker runner disables networking, so package restore from an empty NuGet cache is not yet supported. D-016 networked restore needs its own reviewed phase policy.

## Review log
- 2026-10-30: Claude reviewed PR #17 at `9f17ce1`, requested D1–D3/S1–S3 corrections, then independently accepted rebased `baba983` after fresh-clone tests. Both agents share one GitHub account, so independent acceptance is recorded in PR comments, not formal review objects.
- Merge order: #16 merged first; #17 rebased onto merge commit `77d7e22`, then merged as `69f8800` and installed on Tower.

- 2026-10-30: Codex reviewed PR #16 at `3c1e3f2`: malformed digests accepted, Claude example overstated resume. Both fixed on `ff46a80` (strict 64-hex digest at end of reference; resume and session_status now `unverified`), independently retested and accepted. PR #16 merged by Codex.
- 2026-10-30: Codex re-reviewed #21 conflict-only rebase `c2f2244` → `7e4e6b4` (four functional commits patch-identical; handover conflict reconciled), posted PASS and merged as `67c8aab`. Reviewed and merged #25 at `09a1915` as `8f2e386`; 115/115 tests and the supervised full-access D-020 Codex proof passed. Draft #3 is PR #28.
- 2026-10-30: Codex independently reviewed #27 at `1b3402b`: validator OK, 93/93 tests, niced browser smoke `BROWSER SMOKE OK`, no-network probe passed, and OQ-2 TCP target limits are documented as blocked. [Review PASS](https://github.com/Unthred/DevTest-Infrastructure/pull/27#issuecomment-6523222052).

## Next actions
1. Claude deploys PR #25 with `tools/upgrade-supervisor.sh`, verifies installed SHA, enables at most one job per agent and records the first live tick on #23.
2. Codex continues issue #3 in this branch and draft PR #28: wire safe SDK plans to the runner, test the pinned SDK images and demonstrate NuGet cache reuse.
3. Keep live provider-limit recovery unverified; do not reboot Tower.


## #2 mount lifecycle fix (PR #26, merged into #19 branch)
- Source includes final-step mount release, lease/cache user markers and startup sweep restricted to DevTest loop-image paths.
- Codex exact-head review PASS at `ce738f4`; validator OK, 62/62 tests, niced Docker/lifecycle smokes passed. Loop devices/mounts/containers returned to baseline after SIGKILL recovery. PR #19 later merged by Claude as `a8b944b`.

## Issue #20 allowance evidence (Claude, PR #21, merged)
- Source: `supervisor/allowance.mjs`, `supervisor/clocktext.mjs`, Claude `rate_limit_event` parsing, Codex rollout `postRun`, billing guard on every exit, Codex local-time reset parsing; `docs/allowance-evidence.md`; live fixtures in `tests/fixtures/allowance/` (allowed states and the first real Codex exhausted message).
- Review and CI: Codex PASS at rebased head `7e4e6b4`; exact-head CI green; merged as `67c8aab`. Installed: no.
- Live status: the Codex interactive limit message and its `/status` window lines are captured and parsed (verified for those two shapes only). The `codex exec --json` form, session resume and all Claude exhausted states are uncaptured; manifests stay `unverified` and `autoResume` stays refused.

## Issue #23 team loop (Claude, PR #25, merged)
- Source: dispatcher `supervisor/team.mjs`, `github.mjs`, `team.json` (disabled), `access.json`; post-conditions, `autoRestart` and D-019 timing in `core.mjs`; manifest `access` field; `docs/team-loop.md`; fake-GitHub/fake-provider tests.
- Review and CI: Codex PASS at `09a1915`, exact-head CI green; merged as `8f2e386`. Installed: no; Claude owns deployment and first tick.
- Live status: supervised full-access Codex job at PR #25 head ran the suite in its linked worktree (115/115; clean worktree). Dispatcher production tick, merge, real-limit restart and cron dispatch are not live-verified. Reset parsing stays unverified.
