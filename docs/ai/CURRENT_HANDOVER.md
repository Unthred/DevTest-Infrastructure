# Current handover

Binding decisions: [docs/DECISIONS.md](../DECISIONS.md) (D-006 and D-015–D-018 remain agent proposals). Issue [#23](https://github.com/Unthred/DevTest-Infrastructure/issues/23) records homeowner-approved D-019 and D-020 for addition to the register. Entry point: [AGENTS.md](../../AGENTS.md). Gates: [acceptance-gates.md](../acceptance-gates.md).

Last updated: 2026-10-30 by Codex on `codex/review-queue-handover`. Each agent edits this file only on its own branch.

## Completion states

| Item | Implemented in source | CI/review passed | Deployed | Verified working |
|---|---|---|---|---|
| #1 Architecture | yes; PR #16 merged as `77d7e228113e09a0a0d94edbec030f5dc3d3ec09` | yes; Codex independent PASS at `ff46a80`, exact-head CI and GitGuardian green | n/a | n/a |
| #15 Supervisor | yes; PR #17 merged as `69f88000798a3a55224171e15d3f8af7b2d12e37` | yes; Claude independent PASS, exact-head CI green | yes; Tower payload upgraded to the merged SHA | normal Claude/Codex read-only CLI and supervised jobs completed; live subscription-limit reset/resume unverified |
| #15 regression follow-up | yes; PR #18 merged as `0240bc384bf9ee36ce6b0f87e1ea8f7f636fb9d7` | yes; Codex independent PASS at `df99dca65a0f3ea0c1f629d34ab54d91a093889c`, 42/42 local tests and exact-head CI green | not separately installed | context requeue crash window verified by fixture only |
| #2 Docker foundations | pending; Codex PR #19, head `cd84364880ee76e084727698158a5e13739bcdfa` | no; Claude's #19 review requested fixes through PR #22; Codex requested further changes to #22 | no | low-priority real Docker smoke on #22 passed; hard aggregate disk bound and secret-safe logs unresolved |
| #20 Allowance detection | pending; Claude PR #21, head `2d3b5cfae69f05743b7d22521da5d8a76da493d1` | no; Codex requested changes for successful paid-overage event | no | simulated subprocess bug reproduced; live allowance recovery unverified |
| #23 Team loop | not started | no | no | no |
| #3–#14 other issues | not started | no | no | no |

## Ownership

| Agent | Issues | Branch / worktree |
|---|---|---|
| Claude | #1, #5–#7, #10, #13, #14, #20, #23; fixes for Codex #19 | separate Claude branches/worktrees; PRs #21 and #22 open |
| Codex | #15, #2–#4, #8, #9, #11, #12; independent reviews | `codex/issue-2-docker` in `/mnt/user/projects/DevTest-Infrastructure-codex-2`; review handover branch in separate fresh clone |

## Environment facts and evidence

- Tower Docker 29.5.1, btrfs storage, cgroup v2, Node 22.18. `dotnet`, `pwsh`, and `shellcheck` are not host-installed. Cache pool had about 353 GB free at the 2026-10-30 review. No reboot or production Home Assistant change was made.
- Tower supervisor payload at `/mnt/cache/ai-supervisor/current` was upgraded to merged #17 SHA `69f88000798a3a55224171e15d3f8af7b2d12e37`; payload bytes matched source and launcher/CLI smoke passed. The User Scripts reconciliation entry runs every five minutes. Host-restart persistence has not been tested.
- Historical supervisor evidence: pre-rebase source `58c91c61f6ab3a6d2f536d4697853107f10d8d3f` had 21/21 local tests and [CI 41016983793](https://github.com/Unthred/DevTest-Infrastructure/actions/runs/41016983793)/[41016989881](https://github.com/Unthred/DevTest-Infrastructure/actions/runs/41016989881) green. Earlier installed payload `936f0845b0c9a17de67e2ac20a128997a6733c5f` completed supervised Codex job `802a94e403a919797c0ca7138a633ff4` and Claude job `ac07b63b0f1c799acb10a97f634c6ae3`; both were replaced by the merged #17 payload. The original launcher backup is `/root/bin/ai-agent.before-supervisor-6cff297568806b932d353f8dfaa7c70922ed7239` (SHA-256 `b96da02b190328940e500b378184cd446d6fe4b7cbbe3f349946ee2a3f129b7a`). Provider observations are in `docs/provider-observations.md`; live limit captures remain outstanding.
- PR #22 review at `a2f5a1aedf57f84ab6cb2a033fa3c521d4b37aef`: validator OK; full suite 50/50; low-priority real `tests/docker-smoke.mjs` passed positive and deliberate subject-failure probes with cleanup. Claude's aggregate disk probe reached 211 MB against a 64 MB budget. A recent kernel memory-cgroup OOM warning came from a container memory probe; intensive disk/OOM probes were stopped. [Codex CHANGES REQUESTED](https://github.com/Unthred/DevTest-Infrastructure/pull/22#issuecomment-6518406474): require a hard ceiling on all writable cache-pool paths, secret-safe persistent logs, and accurate D-015 wording. `--memory-swap` has no effective limit on this kernel.
- PR #21 review at `2d3b5cfae69f05743b7d22521da5d8a76da493d1`: validator OK; full suite 47/47; simulated Claude-shaped `isUsingOverage:true` with exit 0 was incorrectly marked completed. [Codex CHANGES REQUESTED](https://github.com/Unthred/DevTest-Infrastructure/pull/21#issuecomment-6518452687): paid-overage guard must take precedence on successful as well as failed exits. Production manifests still refuse `autoResume:true`; no live recovery or paid fallback was claimed.
- PR #18 review at `df99dca65a0f3ea0c1f629d34ab54d91a093889c`: fresh clone validator OK, full suite 42/42, exact-head project-contract/test/GitGuardian SUCCESS and merge state CLEAN. Some tests overlap #17; context requeue crash-window coverage adds value. [Codex PASS](https://github.com/Unthred/DevTest-Infrastructure/pull/18#issuecomment-6518490816); merged as `0240bc384bf9ee36ce6b0f87e1ea8f7f636fb9d7`.
- Both agents use one GitHub account. Independent acceptance is recorded with reviewer identity, exact SHA, commands and decision in PR comments; it is not a formal GitHub approval.

## Blockers

- #22 needs a hard aggregate disk bound and fail-closed handling of potentially secret-bearing logs; do not merge it into #19 until corrected, independently retested and exact-head CI green. Claude reviews and merges #19 after #22 is accepted.
- #21 needs the successful-exit overage fix and an executable regression before merge. D-019/D-020 in issue #23 authorize a bounded fresh restart and a human-selected supervisor elevated mode, respectively, subject to their stated controls. The first real limit hit per provider still needs a redacted capture; simulated tests do not prove live auto-resume.
- #3 depends on accepted and closed #2. Start it only after Claude merges #19 and its completion evidence is current.

## Next actions

1. Claude corrects PRs #22 and #21 in its own branches. Codex reviews each new exact head from a fresh clone, reruns validator/full suite and real Docker probes for #22, checks CI, and merges only after PASS.
2. Claude reviews/merges #19 after #22 lands and exact-head CI is green. Codex then starts #3 on `codex/issue-3-<slug>` in its own worktree, implementing .NET SDK 8/9/10 build tooling.
3. Claude implements #23 and obtains Codex independent review. Keep Tower supervisor live limit auto-resume explicitly unverified until a real redacted limit capture supports it.
