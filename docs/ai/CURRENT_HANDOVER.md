# Current handover

Binding decisions: [docs/DECISIONS.md](../DECISIONS.md) (18 entries; D-006, D-015–D-018 are agent proposals awaiting review). Entry point: [AGENTS.md](../../AGENTS.md). Gates: [acceptance-gates.md](../acceptance-gates.md).

Last updated: 2026-10-30 by Codex on `codex/issue-15-supervisor`, rebased onto merged architecture PR #16. Each agent edits this file only on its own branch.

## Completion states
Reported separately; none implies the next.

| Item | Implemented in source | CI/review passed | Deployed | Verified working |
|---|---|---|---|---|
| #1 Architecture, decisions, contracts, validator | yes (PR #16, merged as `77d7e228113e09a0a0d94edbec030f5dc3d3ec09`) | yes: exact-head CI and GitGuardian green; Codex independent PASS on `ff46a80` | n/a (documentation and checks) | n/a |
| #15 Supervisor | yes (PR #17 rebased; code review corrections included) | pending: rebased exact-head CI and Claude's independent recheck | earlier `936f0845b0c9a17de67e2ac20a128997a6733c5f` installed on Tower; rebased head not installed | normal read-only Claude/Codex CLI and supervised jobs completed; real usage-limit reset and post-limit resume unverified |
| AI-Rules launcher metadata fix (PR #15) and `devtest` role (PR #16) | yes | CI green; independent review pending | yes, installed 2026-10-29 | Codex launch confirmed by the homeowner; Claude launch checked by recorded argv only |
| #2–#14 | not started | no | no | no |

## Ownership
| Agent | Issues | Branch / worktree |
|---|---|---|
| Claude | #1, then #5–#7, #10, #13, #14; independent review of #15 | `claude/issue-1-architecture`, `/mnt/user/projects/DevTest-Infrastructure-claude-1` |
| Codex | #15, then #2–#4, #8, #9, #11, #12 | `codex/issue-15-supervisor`, `/mnt/user/projects/DevTest-Infrastructure-codex-15` |

## Environment facts (checked 2026-10-29)
- Tower: Docker 29.5.1, storage driver btrfs, cgroup v2; Node 22.18; `jq` present. **Not installed on the host:** `dotnet`, `pwsh`, `shellcheck`. Tests and validators here therefore use Node and bash; .NET work runs in containers.
- `/mnt/cache/appdata` exists; cache pool has about 353 GB free.
- Launcher: `ai-agent` has a `devtest` role (workspace `/mnt/user/projects/DevTest-Infrastructure`, Unraid host-safety rules). Do not run `git fetch/pull` inside `/mnt/cache/cursor-workspace/ai-rules-live`; redeploy with `tools/deploy-codex-launcher.sh --source <clean checkout>`.

## Open questions
OQ-1 secret delivery (#7), OQ-2 browser egress enforcement (#5/#10, firewall change would need explicit approval), OQ-3 where Docker-dependent CI runs (#12), OQ-4 evidence retention.

## Evidence
- Contracts: `contracts/cli.v1.json`, `contracts/provider-manifest.v1.schema.json`, examples for Claude, Codex and a generic future agent.
- Architecture acceptance: Codex ran `node tools/validate-project.mjs` (OK), `node --test 'tests/**/*.test.mjs'` (14/14), and an independent malformed-digest fixture on #16 head `ff46a80`; [review PASS](https://github.com/Unthred/DevTest-Infrastructure/pull/16#issuecomment-6517023386). Exact-head [CI 41017746345](https://github.com/Unthred/DevTest-Infrastructure/actions/runs/41017746345) and GitGuardian passed.
- Supervisor source before rebase: `58c91c61f6ab3a6d2f536d4697853107f10d8d3f`; 21/21 local tests, exact-head [CI 41016983793](https://github.com/Unthred/DevTest-Infrastructure/actions/runs/41016983793) and [CI 41016989881](https://github.com/Unthred/DevTest-Infrastructure/actions/runs/41016989881), GitGuardian green. The rebase changes commit identities; rerun all gates on the new head.
- Tower normal CLI smoke: `node tests/real-smoke.mjs /mnt/user/projects/DevTest-Infrastructure-codex-15` returned exit 0, subscription authentication and completion marker for both Claude and Codex, no classified events, worktree unchanged. Earlier installed supervised issue #15 jobs completed in one attempt and released leases: Codex `802a94e403a919797c0ca7138a633ff4`, Claude `ac07b63b0f1c799acb10a97f634c6ae3`. Installed launcher behavioural tests and `--supervisor help` passed; four recorded smoke jobs were terminal with no active job at the last check.
- Installed payload: `/mnt/cache/ai-supervisor/current` and `/root/bin/ai-supervisor` still point to `936f0845b0c9a17de67e2ac20a128997a6733c5f`. The User Scripts reconciliation entry is scheduled every five minutes and present once in `/etc/cron.d`; no host reboot has been tested. The original launcher backup is `/root/bin/ai-agent.before-supervisor-6cff297568806b932d353f8dfaa7c70922ed7239` (SHA-256 `b96da02b190328940e500b378184cd446d6fe4b7cbbe3f349946ee2a3f129b7a`).

- Provider evidence: `docs/provider-observations.md` (static inspection of Claude Code 2.1.312 and Codex CLI 0.165.0; live captures still outstanding).

## Blockers
- #15 real subscription-limit wording, reset timestamp and post-limit resume are not captured. Production manifests mark those capabilities `unverified` and refuse `autoResume: true`. Simulated pause/resume is not a live auto-resume claim.
- #15 requires Claude's independent recheck of the rebased exact head and green exact-head CI before merge. The reviewed version must then be installed and verified on Tower under the homeowner's explicit continuation authorization.
- Tower reboot persistence and host-restart recovery remain unverified; do not reboot Tower for this task.

## Review log
- 2026-10-30: Claude reviewed PR #17 at `9f17ce1` in a standalone clone. Changes requested: D1 exit 0 plus a stray rate-limit line; D2 Claude error-result parsing; D3 a stranded queued backoff job; S1–S3 smaller items. Codex corrected all six on the #17 branch and added subprocess, structured-error, recovery and redaction regressions. Claude recheck of the rebased head is pending. Both agents share one GitHub account, so independent acceptance is recorded in PR comments, not a formal review object.
- Merge order: #16 merged first; #17 rebased onto merge commit `77d7e22`, with this handover preserving architecture and supervisor evidence.

- 2026-10-30: Codex reviewed PR #16 at `3c1e3f2`: malformed digests accepted, Claude example overstated resume. Both fixed on `ff46a80` (strict 64-hex digest at end of reference; resume and session_status now `unverified`), independently retested and accepted. PR #16 merged by Codex.

## Next actions
1. Codex: run architecture validator, complete supervisor tests and exact-head CI on rebased PR #17; request Claude's independent PASS or actionable findings on that head.
2. After PASS and green CI, merge #17, upgrade the installed Tower payload using `tools/upgrade-supervisor.sh`, verify exact installed SHA, launcher behaviour, subscription CLI smoke and no active-job disruption. Do not claim live limit auto-resume.
3. Codex: start issue #2 in a new branch/worktree now that #1 has reached CI/review passed. Claude: continue the next unblocked Claude-owned issue when its prerequisites allow.
