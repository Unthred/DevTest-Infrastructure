# Current handover

Binding decisions: [docs/DECISIONS.md](../DECISIONS.md) (20 entries; D-019 and D-020 are homeowner-approved, recorded by PR #25; D-006 and D-015–D-018 remain agent proposals). Entry point: [AGENTS.md](../../AGENTS.md). Gates: [acceptance-gates.md](../acceptance-gates.md).

Last updated: 2026-10-30 by Claude on `claude/issue-5-playwright` (based on main at the merge of #19). Each agent edits this file only on its own branch.

Last updated: 2026-10-30 by Claude on `claude/issue-35-scheduled-ticks-fail` (issue #35 section at the end). Each agent edits this file only on its own branch.

## Completion states

| Item | Implemented in source | CI/review passed | Deployed | Verified working |
|---|---|---|---|---|
| #1 Architecture, decisions, contracts, validator | yes (PR #16, merged as `77d7e228113e09a0a0d94edbec030f5dc3d3ec09`) | yes: exact-head CI and GitGuardian green; Codex independent PASS on `ff46a80` | n/a (documentation and checks) | n/a |
| #15 Supervisor | yes (PR #17 merged as `69f88000798a3a55224171e15d3f8af7b2d12e37`) | yes: exact-head CI/GitGuardian green; Claude independent PASS on `baba983` | merged commit `69f8800` installed on Tower; wrapper and payload bytes verified | normal launcher/CLI smoke passed; real usage-limit reset and post-limit resume unverified |
| AI-Rules launcher metadata fix (PR #15) and `devtest` role (PR #16) | yes | CI green; independent review pending | yes, installed 2026-10-29 | Codex launch confirmed by the homeowner; Claude launch checked by recorded argv only |
| #15 regression follow-up | yes; PR #18 merged as `0240bc384bf9ee36ce6b0f87e1ea8f7f636fb9d7` | yes; Codex independent PASS at `df99dca65a0f3ea0c1f629d34ab54d91a093889c`, 42/42 local tests and exact-head CI green | not separately installed | context requeue crash window verified by fixture only |
| #2 Docker foundation | yes on PR #19; PR #22 merged as base, then Codex hard-bound/log fixes `a96ea85`, `31f3c96`, `95f392a` | yes: PR #19 merged as `a8b944b` after Codex PASS on #26 (`ce738f4`) and Claude final check at `aaa76cc` (62/62, exact-head CI green, both Docker smokes) | no standalone `dev-test` installation | Tower runner positive, subject-failure and hard work/output/cache limit probes passed; CLI integration remains issue #8 |
| #20 Allowance detection | pending; Claude PR #21, head `2d3b5cfae69f05743b7d22521da5d8a76da493d1` | no; Codex requested changes for successful paid-overage event | no | simulated subprocess bug reproduced; live allowance recovery unverified |
| #23 Team loop | yes; PR #25 (D-019 and D-020 recorded; dispatcher, trusted verdicts, post-conditions, restart and access modes) | no; CI green, Codex executable review pending | no | a supervised full-access Codex job ran `node --test` on Tower (35/35); dispatcher, merge, real-limit restart and cron path not live-verified |
| #5 Playwright browser runtime | yes; branch `claude/issue-5-playwright` | no; CI and Codex review pending | no | real Docker on Tower: Chromium, Firefox and WebKit screenshots, broken-page and external-request detection, cleanup to baseline (`tests/browser-smoke.mjs`); TCP targets blocked on OQ-2 |
| #3–#14 other issues | not started | no | no | no |

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
- #2 still needs exact-head CI, Claude's independent review, and integration through the single `dev-test` CLI in issue #8. The host-side runner smoke is not a deployed end-to-end CLI claim.
- Tower reboot persistence and host-restart recovery remain unverified; do not reboot Tower for this task.

## Review log
- 2026-10-30: Claude reviewed PR #17 at `9f17ce1`, requested D1–D3/S1–S3 corrections, then independently accepted rebased `baba983` after fresh-clone tests. Both agents share one GitHub account, so independent acceptance is recorded in PR comments, not formal review objects.
- Merge order: #16 merged first; #17 rebased onto merge commit `77d7e22`, then merged as `69f8800` and installed on Tower.

- 2026-10-30: Codex reviewed PR #16 at `3c1e3f2`: malformed digests accepted, Claude example overstated resume. Both fixed on `ff46a80` (strict 64-hex digest at end of reference; resume and session_status now `unverified`), independently retested and accepted. PR #16 merged by Codex.
- 2026-10-30: Codex reviewed #22 at `a2f5a1a` and requested hard disk and secret-safe logs; homeowner directed merge as a base and Codex corrected these on #19. #21 at `2d3b5cf` remains CHANGES REQUESTED because successful paid-overage output was marked completed. #18 passed independent review and merged as `0240bc384bf9ee36ce6b0f87e1ea8f7f636fb9d7`. Codex's separate review handover is PR #24 and needs Claude review; do not self-merge it.

## Next actions
1. Codex: review PR #21 (`c2f2244`) and PR #25, then start #3 (.NET) now that #19 is merged; review the #5 PR when requested.
2. Claude: continue #5 until Codex reviews it; then #6, #7 (OpenBao), #10, #13, #14 as prerequisites reach CI/review passed.
3. Keep #15 open for real provider-limit capability evidence; do not enable production auto-resume based on simulated tests or reboot Tower to claim persistence.

1. Claude corrects PRs #22 and #21 in its own branches. Codex reviews each new exact head from a fresh clone, reruns validator/full suite and real Docker probes for #22, checks CI, and merges only after PASS.
2. Claude reviews/merges #19 after #22 lands and exact-head CI is green. Codex then starts #3 on `codex/issue-3-<slug>` in its own worktree, implementing .NET SDK 8/9/10 build tooling.
3. Claude implements #23 and obtains Codex independent review. Keep Tower supervisor live limit auto-resume explicitly unverified until a real redacted limit capture supports it.


## #2 mount lifecycle fix (Claude, branch `claude/issue-2-mount-lifecycle`, PR targets `codex/issue-2-docker`)
- Source: merges main into the #19 branch (handover reconciled, both sides kept); release in a final step on every outcome, incomplete-cleanup reporting, lease and cache user markers, start-up sweep restricted to DevTest images under the storage root; `withRunVolume`; `tests/docker-lifecycle-smoke.mjs`.
- Tests: validator OK, 62/62. Tower gate: lifecycle smoke LIFECYCLE OK (baseline restored after five outcomes; sweep removed only the two stranded devices) and `tests/docker-smoke.mjs` passes.
- Review and CI: Codex review pending; merging this PR into `codex/issue-2-docker` updates #19. Claude then performs the final check and merges #19.

## Issue #20 allowance evidence (Claude, PR #21, branch `claude/issue-20-allowance`)
- Source: `supervisor/allowance.mjs`, `supervisor/clocktext.mjs`, Claude `rate_limit_event` parsing, Codex rollout `postRun`, billing guard on every exit, Codex local-time reset parsing; `docs/allowance-evidence.md`; live fixtures in `tests/fixtures/allowance/` (allowed states and the first real Codex exhausted message).
- Review and CI: Codex re-review pending at the head named on the PR. Installed: no.
- Live status: the Codex interactive limit message and its `/status` window lines are captured and parsed (verified for those two shapes only). The `codex exec --json` form, session resume and all Claude exhausted states are uncaptured; manifests stay `unverified` and `autoResume` stays refused.

## Issue #23 team loop (Claude, branch `claude/issue-23-team-loop`, stacked on #21: its diff includes #21 until #21 merges)
- Source: dispatcher `supervisor/team.mjs`, `github.mjs`, `team.json` (disabled), `access.json`; post-conditions, `autoRestart` and D-019 timing in `core.mjs`; manifest `access` field; `docs/team-loop.md`; fake-GitHub/fake-provider tests.
- Review and CI: exact-head CI green; Codex executable review pending. Installed: no. Deploy with `tools/upgrade-supervisor.sh` only after Codex's PASS, then enable `team.json` (an explicit act).
- Live status: a supervised `access: full` Codex job ran the suite on Tower; dispatcher, merge, restart after a real limit and the cron path are not live-verified. Reset parsing stays unverified.

## #33 False usage pause from truncated output lines (Claude, branch `claude/issue-33-truncated-line`)
- Finding: supervised job `7829a980…` (issue #30) was paused as a usage limit although it finished normally (PR #31 opened) and /usage showed 34% session, 18% week, credits off. Cause: `process.mjs` cuts each line to 16 KiB; a cut JSON tool result no longer parses and the Claude and Codex adapters then ran their limit regexes on the raw fragment, which quoted this project's own "usage limit" text. No structured allowance event and no overage flag was involved.
- Fix: a line that starts with `{`/`[` but does not parse is a truncated payload and is never limit/auth/context/approval/rate evidence (`isTruncatedPayload` in `supervisor/adapters/base.mjs`, used by both adapters). Plain stderr text and whole structured errors classify as before. The overage guard and status/threshold parsing are untouched.
- Evidence: redacted shape fixture, unit tests, real-subprocess tests (exit 0 completes, exit 1 is a plain failure, overage still blocks, a real exhausted event is still detected); mutation check (guard removed) fails 4 tests. Not live-verified: a real limit; the incident's raw line was not persisted, so the shape is reconstructed from the job's session transcript.

## Issue #30 delivered-work detection and local config (Claude, branch `claude/issue-30-team-loop-delivered`)
- Source: `listMergedPulls` + delivered-work skip in `supervisor/team.mjs`; `team.local.json` override loader (state root, restricted keys); `team.json` no longer lists #2 and #23; `tools/upgrade-supervisor.sh` refuses an override in the payload and verifies the copy with `diff -r`; `docs/team-loop.md` documents the override and upgrade procedure.
- Tests: validator OK, 119/119 (new: delivered-work positive/negative, shipped config, override apply/refuse/survives-upgrade, script guards). Live read-only `team tick --dry-run` with a temp state root planned one review and no #2/#23 job.
- Review and CI: Codex review pending. Installed: no. Deploy only after PASS and dispatcher merge, then create `/mnt/cache/ai-supervisor/team.local.json` (`{"enabled": true}`) and follow the procedure in docs/team-loop.md.

## #5 Playwright browser runtime (Claude, branch `claude/issue-5-playwright`)
- Homeowner exception 2026-10-30: #5 was started before #2 was formally merged, stacked on #19 ("do not merge before #19"). #19 merged as `a8b944b` before this PR was opened, so the branch is based on main and no stacking remains.
- Source: image `mcr.microsoft.com/playwright:v1.64.1-noble` pinned by digest with tag and resolved date in `docker/images.lock.json`; `playwright-core` 1.64.1 pinned by npm integrity (`browser/prepare-cache.mjs`); `browser/capture.mjs`; `browser/static-server.mjs`; runner `targets` (host-side Unix socket mounts, verified before start); [docs/browser-runner.md](../browser-runner.md).
- Tests: `tests/browser.test.mjs` (positive and negative, one mutation check on the allow-list). Tower gate `tests/browser-smoke.mjs`: see the PR for the output.
- Not done, blocked on OQ-2: reaching a real TCP service (needs a firewall rule or trusted forwarder; no firewall change was made). No .NET in this track. Not deployed; CLI integration is #8.
- Codex verdict CHANGES on `fcbf9c1` (2026-10-30), both findings fixed in the next head: (1) `static-server.mjs` now compares `realpath` with the joined path, so a symlinked directory component anywhere returns 403 (tests: `/linked/…`, `/real/deep/…`); (2) `capture.mjs` strips query/fragment from the reported `path` and reduces every URL inside console/page/navigation error text to scheme+host+path (test with a canary). Validator OK, 129/129. Real-Docker smoke not rerun; CI and Codex re-review pending.
- Codex verdict CHANGES on `a784af7` (2026-10-30): `context.route` does not see WebSocket handshakes, so `ws://127.0.0.1:43210/undeclared` was attempted (exit 10, nothing recorded). Fixed in the next head: `context.routeWebSocket` in `capture.mjs` connects only `ws://` to the bridged origin (`isAllowedSocket`); everything else is closed unconnected, recorded without query, exit 12. Tests: fake-Playwright cases plus `tests/browser-smoke.mjs` now runs `browser/fixture/websocket.html` on Chromium, Firefox and WebKit (all exit 12, token absent). Validator OK, 142/142, BROWSER SMOKE OK (cleanup 4/0/0). CI and Codex re-review pending.

## Issue #35 scheduled ticks fail silently (Claude, branch `claude/issue-35-scheduled-ticks-fail`)
- Implemented in source: pinned PATH/HOME, `flock` and a bounded log in the generated reconcile script; `tools/verify-reconcile-env.sh` and `ai-supervisor preflight` as the enable gate (installer refuses, exit 3); named `gh` missing error and bounded retry of transient GitHub errors; `preflight_failed` instead of `auth_error` for a missing provider binary; per-action tick skipping with reasons; post-once verdict and needs-homeowner notices; automatic lease release for completed/stopped dispatcher jobs. Docs: `docs/supervisor.md`, `docs/team-loop.md`.
- Tests: validator OK, 135/135 locally, including `env -i` runs of the generated script with fake `gh`/`node`, log trim and lock, enable-gate refusal, retry bounds, lease conflict skip, once-only posting across ticks.
- Not done / not verified: dashboard indicators and stale-lease attention items (issue #32); the already hot-fixed script on Tower is not replaced (reinstall needs the homeowner: remove, then install); the cron path is **not** marked verified working until a scheduled (not hand-run) tick has started a job. CI and Codex review pending.
