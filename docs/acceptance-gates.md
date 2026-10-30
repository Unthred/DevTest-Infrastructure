# Acceptance gates

Every issue passes these gates in order. A gate that cannot be shown is reported as not passed.

## Completion states (D-013)
Report these four separately for every item. Never merge them.
1. **Implemented in source** — the change exists on a branch.
2. **CI/review passed** — exact-head CI is green and the opposite agent has reviewed.
3. **Deployed** — installed where it runs, with the exact version or SHA.
4. **Verified working** — observed doing its job, with evidence.
A merged PR or green CI alone is state 1–2, not 4.

## Gates
| Gate | Requirement | Evidence |
|---|---|---|
| G1 Source | Change on its own branch and worktree (D-011, D-018); checked against every register entry; `node tools/validate-project.mjs` passes. | commit SHA |
| G2 Tests | Positive **and** negative cases, run for real; flaky tests are failures. | command, output, exit code |
| G3 CI | Exact-head CI green. | run id and head SHA |
| G4 Review | Reviewed by the opposite agent, independently (it re-runs the tests, does not trust the author's report). Findings fixed or answered. | review link |
| G5 Security | No secret in Git, logs or artifacts; no Docker socket or privileged mode; no production mutation; no reboot; images pinned by digest. | validator output |
| G6 Evidence | Reproducible commands and outputs linked on the issue; sensitive values redacted. | issue comment |
| G7 Handover | `docs/ai/CURRENT_HANDOVER.md` updated with the four states, SHA and blockers before the report. | handover commit |
| G8 Live (only if the issue deploys) | Deployed to Tower with a rollback, then observed working. | observation record |

Dependencies come first: do not start an issue whose prerequisites are not at least state 2.

## Per-issue required evidence
| Issue | Must show |
|---|---|
| #1 Architecture | These documents, register, contracts and entry points; validator and tests including negative cases; CI; opposite-agent review. |
| #2 Docker foundation | Hardening baseline enforced by the runner (D-015), pinned digests in the lock file, cleanup leaves nothing running, refusal tests for socket, privileged and bad mounts. |
| #3–#4 .NET | Each SDK major builds and tests a real fixture, no network during build/test (D-016), TRX and coverage artifacts. |
| #5–#6 Browser | Real screenshots at phone and desktop profiles; a deliberately broken page is detected; browser track runs without .NET. |
| #7 OpenBao | Secrets never in arguments, logs or artifacts (scan proves it); session isolation between runs. |
| #8 CLI | Every exit code in the contract is produced by a test; `--json` output validates. |
| #9 Parallel agents | Two agents on separate worktrees cannot write the same worktree, secret file or merge. |
| #10 Home Assistant | Authenticated, read-only capture of an approved view; no mutation. |
| #11 Blazor | End-to-end fixture: build, test, screenshots, broken-page detection, clean stop. |
| #12 CI | Provenance and update policy; OQ-3 resolved. |
| #13 Docs | A reader can recover a failed run from the checklist. |
| #14 Release | Independent acceptance of everything above. |
| #15 Supervisor | Failure matrix with fake time (see the provider contract); one real non-destructive smoke test per available agent; a suspended job resuming the same issue with no duplicate worktree and no model calls while asleep. |

## Negative-case rule
A deliverable that only has passing examples is incomplete. For each refusal, limit or failure behaviour there is a test that proves it refuses, limits or fails.
