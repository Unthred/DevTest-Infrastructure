# Current handover

Binding decisions: [docs/DECISIONS.md](../DECISIONS.md) (18 entries; D-006, D-015–D-018 are agent proposals awaiting review). Entry point: [AGENTS.md](../../AGENTS.md). Gates: [acceptance-gates.md](../acceptance-gates.md).

Last updated: 2026-10-29 by Claude (issue #1 branch `claude/issue-1-architecture`). Each agent edits this file only on its own branch; the merge order is recorded in the PR.

## Completion states
Reported separately; none implies the next.

| Item | Implemented in source | CI/review passed | Deployed | Verified working |
|---|---|---|---|---|
| #1 Architecture, decisions, contracts, validator | yes (this branch) | not yet (CI and opposite-agent review pending) | n/a (documentation and checks) | n/a |
| #15 Supervisor | in progress (Codex, branch `codex/issue-15-supervisor`) | no | no | no |
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
- Validation: `node tools/validate-project.mjs`; `node --test "tests/**/*.test.mjs"` (good and deliberately broken fixtures).

## Blockers
None for #1. #2 onward wait on #1 reaching CI/review passed (prerequisite rule).

## Next actions
1. Claude: open the #1 PR, run CI, request Codex's independent review; answer review findings.
2. Codex: review the provider contract against the #15 implementation and reply on issue #15 with corrections.
3. Claude: independently review and test #15 as it lands (fake-clock failure matrix, duplicate start, restart recovery).
4. After #1 is merged: Claude starts #5 (Playwright runtime) once #2 provides the Docker foundation; until then, prepare #5/#6 design notes without implementing against missing foundations.
