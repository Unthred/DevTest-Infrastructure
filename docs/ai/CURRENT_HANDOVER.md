# Current handover

Binding decisions: [docs/DECISIONS.md](../DECISIONS.md) (18 entries; D-006, D-015–D-018 are agent proposals awaiting review). Entry point: [AGENTS.md](../../AGENTS.md). Gates: [acceptance-gates.md](../acceptance-gates.md).

Last updated: 2026-10-30 by Codex on `codex/issue-2-docker`, based on merged architecture and supervisor PRs. Each agent edits this file only on its own branch.

## Completion states
Reported separately; none implies the next.

| Item | Implemented in source | CI/review passed | Deployed | Verified working |
|---|---|---|---|---|
| #1 Architecture, decisions, contracts, validator | yes (PR #16, merged as `77d7e228113e09a0a0d94edbec030f5dc3d3ec09`) | yes: exact-head CI and GitGuardian green; Codex independent PASS on `ff46a80` | n/a (documentation and checks) | n/a |
| #15 Supervisor | yes (PR #17 merged as `69f88000798a3a55224171e15d3f8af7b2d12e37`) | yes: exact-head CI/GitGuardian green; Claude independent PASS on `baba983` | merged commit `69f8800` installed on Tower; wrapper and payload bytes verified | normal launcher/CLI smoke passed; real usage-limit reset and post-limit resume unverified |
| AI-Rules launcher metadata fix (PR #15) and `devtest` role (PR #16) | yes | CI green; independent review pending | yes, installed 2026-10-29 | Codex launch confirmed by the homeowner; Claude launch checked by recorded argv only |
| #2 Docker foundation | yes (branch `codex/issue-2-docker`, source `c3bab6d870865f962531be8770edf6c22ba7b253`, rootless correction `aca86c7c857e4cd504285cd995d4a548127aea96`, name-collision correction `742fbcfc3306fb553c777dc811323de24fa22861`) | prior head CI/GitGuardian green; new exact-head CI and Claude review pending | no standalone `dev-test` installation | Tower runner positive and subject-failure probes passed; CLI integration remains issue #8 |
| #3–#14 | not started | no | no | no |

## Ownership
| Agent | Issues | Branch / worktree |
|---|---|---|
| Claude | #1, then #5–#7, #10, #13, #14; independent review of #15 | `claude/issue-1-architecture`, `/mnt/user/projects/DevTest-Infrastructure-claude-1` |
| Codex | #15, #2–#4, #8, #9, #11, #12 | current `codex/issue-2-docker`, `/mnt/user/projects/DevTest-Infrastructure-codex-2` |

## Environment facts (checked 2026-10-29)
- Tower: Docker 29.5.1, storage driver btrfs, cgroup v2; Node 22.18; `jq` present. **Not installed on the host:** `dotnet`, `pwsh`, `shellcheck`. Tests and validators here therefore use Node and bash; .NET work runs in containers.
- `/mnt/cache/appdata` exists; cache pool has about 353 GB free.
- Launcher: `ai-agent` has a `devtest` role (workspace `/mnt/user/projects/DevTest-Infrastructure`, Unraid host-safety rules). Do not run `git fetch/pull` inside `/mnt/cache/cursor-workspace/ai-rules-live`; redeploy with `tools/deploy-codex-launcher.sh --source <clean checkout>`.

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

- Provider evidence: `docs/provider-observations.md` (static inspection of Claude Code 2.1.312 and Codex CLI 0.165.0; live captures still outstanding).

## Blockers
- #15 real subscription-limit wording, reset timestamp and post-limit resume are not captured. Production manifests mark those capabilities `unverified` and refuse `autoResume: true`. Simulated pause/resume is not a live auto-resume claim.
- #2 still needs exact-head CI, Claude's independent review, and integration through the single `dev-test` CLI in issue #8. The host-side runner smoke is not a deployed end-to-end CLI claim.
- Tower reboot persistence and host-restart recovery remain unverified; do not reboot Tower for this task.

## Review log
- 2026-10-30: Claude reviewed PR #17 at `9f17ce1`, requested D1–D3/S1–S3 corrections, then independently accepted rebased `baba983` after fresh-clone tests. Both agents share one GitHub account, so independent acceptance is recorded in PR comments, not formal review objects.
- Merge order: #16 merged first; #17 rebased onto merge commit `77d7e22`, then merged as `69f8800` and installed on Tower.

- 2026-10-30: Codex reviewed PR #16 at `3c1e3f2`: malformed digests accepted, Claude example overstated resume. Both fixed on `ff46a80` (strict 64-hex digest at end of reference; resume and session_status now `unverified`), independently retested and accepted. PR #16 merged by Codex.

## Next actions
1. Codex: push issue #2 source and this handover, open a PR, wait for exact-head CI, request Claude's independent review and correct any findings.
2. After #2 is reviewed and green, merge it and start #3 .NET SDK builds in a new worktree. Claude can start #5 Playwright once #2 reaches CI/review passed.
3. Keep #15 open for real provider-limit capability evidence; do not enable production auto-resume based on simulated tests or reboot Tower to claim persistence.
