# Team loop (issue #23)

Status: implemented in source on `claude/issue-23-team-loop`; not deployed. Decisions: **D-019** (bounded automatic restart) and **D-020** (supervised jobs run with the interactive agents' access), both homeowner-approved.

## What it does
`ai-supervisor team tick` is a dispatcher that **makes no model call**. It uses GitHub API calls (`gh`, argument arrays, no shell) and local files only. The existing five-minute reconcile cron already runs `reconcile`, which now runs one tick when `supervisor/team.json` has `"enabled": true` (shipped as `false`; enabling is an explicit act). Only one tick runs at a time (lock with PID and start time). A tick:

1. **Ingests verdicts** from finished review jobs and posts them as a PR comment with a machine marker.
2. **Notifies** for blocked or failed jobs: label `needs-homeowner` plus one comment saying what is needed. Other agents keep working.
3. **Plans at most one merge**, then **dispatches** per agent (first rule that applies; at most 1 active, queued or paused job per agent, 2 overall, counting manual jobs):
   1. *Review* an open PR by another agent with all checks green and no verdict from this agent for that exact head (max 2 attempts per head).
   2. *Fix* this agent's own PR that has a CHANGES verdict on its current head (max 2 attempts).
   3. *Implement* the next owned open issue whose prerequisites (parsed from the issue's `Prerequisites:` line, numbers only) are closed, with no open PR or job already on it and no `needs-homeowner` label. Branch `<agent>/issue-<n>-<slug>`, worktree `DevTest-Infrastructure-<agent>-<n>` (D-018).

`team tick --dry-run` prints the planned actions and writes nothing.

## Trust
- A review job writes `verdict.json` into its own inbox directory (`<state>/team/inbox/<ticket>/`): `{pr, headSha, verdict: PASS|CHANGES, findings[], commandsRun[]}`. PASS requires `commandsRun`; CHANGES requires a finding.
- The dispatcher records a verdict only from a **finished** job it created, for the job's own PR and head. **Comment text is never read**, so a comment on the shared account cannot approve anything. An agent cannot accept its own PR: the recorded reviewer must differ from the branch's author agent.
- Prompts contain only validated tokens (numbers, SHAs, branch names, ticket). Issue and PR text never enters a prompt or a scope.

## Merging
The dispatcher merges, not an agent, and only when **all** hold: a recorded PASS from the opposite agent for the **exact** current head, every check on that head completed green, the PR is mergeable and not a draft, and the branch belongs to a configured agent. The merge passes `--match-head-commit`, so GitHub refuses it if the head moved after the verdict. PRs that target another agent's branch (e.g. a fix PR) follow the same rule. After a merge the dispatcher comments on the linked issue and moves the board card (`done` for merges into `main`, otherwise `in review`). Issue closure stays with GitHub `Closes #n` keywords. **Merged is not deployed and not verified working.**

## Completion is a post-condition, not an exit code
review → a valid verdict recorded; fix → a new head pushed; implement → a PR open from the branch. Exit 0 without it is `incomplete`: retried once with a fresh launch, then `blocked` (`needs-homeowner`). A checker that throws counts as not met and logs only the error class.

## D-019 restart
`autoRestart: true` (set by the dispatcher) restarts a job that stopped on a usage limit **fresh** from issue, Git and handover state. A provider session id is passed only when that provider's `resume` capability is `supported` (today neither is). Wait = reported reset + 2 minutes; if no reset was reported, parsed in the future and provider-reported: 1 h, then 2 h, then 4 h, then `blocked` (three restarts at most). No provider call happens while waiting. No paid fallback; overage use blocks for a human (see #21). It is allowed when the provider supports `launch` and `non_interactive`; the older `autoResume` (session resume) still requires every capability verified. **The reset parser stays `unverified` until the first real limit hit per provider is captured as a fixture.**

## D-020 access
Interactive launcher (`/root/bin/ai-agent`): Codex `--dangerously-bypass-approvals-and-sandbox`, Claude `--permission-mode auto`. Provider manifests carry `access.standard` and `access.full` argument lists; adapters append them (no provider branch in core). A job gets full access only when its spec says `access: "full"`, only for roles listed in `supervisor/access.json` (`devtest`), and the dispatcher refuses to launch anything unless `D-020` is `homeowner-approved` in the register merged on `origin/main`. Other roles and jobs without the field run `standard`. D-007, D-009, D-010, no reboot, no production Home Assistant change and no secret disclosure still bind (stated in every full-access prompt).

## Evidence (2026-10-30, Tower)
- Supervised Codex with `access: full`: `codex exec --dangerously-bypass-approvals-and-sandbox` ran `node --test "tests/**/*.test.mjs"` itself: exit 0, 35/35, session policy `danger-full-access`, approval `never`. This is the check that failed before with `bwrap: pivot_root`.
- Supervised Claude (`--permission-mode auto`, identical to interactive) with `access: full`: its Bash tool ran `node --test "tests/**/*.test.mjs"` without a prompt: exit 0, 35/35, in the worktree. The first attempt found 0 tests because a supervised Claude shell **starts in `/root`** (the shell profile changes directory; `pwd` printed `/root`), not in the job's worktree. Every job prompt now says to begin each command with `cd <worktree>` (tested); the Codex job did not have this problem.
- Not live-verified: the dispatcher against real jobs, merge, restart after a real allowance limit, and the cron integration.
