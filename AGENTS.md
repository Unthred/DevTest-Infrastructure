# DevTest Infrastructure — agent entrypoint

Normative for every agent (Claude, Codex or any registered provider). Short on purpose: the detail lives in the linked files, and no task state is kept here.

## Read first, in this order
1. The shared AI-Rules loaded by your launcher (host safety, secrets, change control, decision governance). This file adds project rules; it does not replace them.
2. [`docs/DECISIONS.md`](docs/DECISIONS.md) — binding decisions. Check your plan against every entry before significant work; a conflict stops you until the homeowner approves a new dated entry.
3. [`docs/ai/CURRENT_HANDOVER.md`](docs/ai/CURRENT_HANDOVER.md) — current state, owners, blockers, next actions.
4. The issue you are working and its live branch/PR. Issues and PRs follow [`docs/work-items.md`](docs/work-items.md) (acceptance lists, live checks, the `## Requirements check` table).
Resume from repository state, never from assumed chat memory.

## Rules that always apply
- **Coding standards.** Follow [`docs/coding-standards.md`](docs/coding-standards.md); it applies to every change.
- **One entry point.** Build and test through the `dev-test` CLI ([`docs/cli-contract.md`](docs/cli-contract.md)). No ad-hoc `docker run`, no second launcher.
- **One writer per worktree.** Work on `<agent>/issue-<n>-<slug>` in `DevTest-Infrastructure-<agent>-<n>`. Never edit, reset, stash or clean another agent's worktree, and never overwrite a shared handover. Git fixtures in tests use independent clones or `git init`, never a linked worktree.
- **Independent review (D-024)** before any merge: a fresh session on a different model from the writer of the head; a different provider is not required. You do not merge your own PR.
- **Secrets.** OpenBao only, scoped and read-only. Never in Git, logs, artifacts, issue text or command-line arguments.
- **No Docker socket, no privileged containers**, images pinned by digest, containers removed after every run.
- **Read-only against production.** No unattended mutation of Home Assistant, applications or the network. No reboots. Firewall or remote-access changes need fresh explicit homeowner approval.
- **Handover is edited on main only (D-023).** Feature branches never touch `docs/ai/CURRENT_HANDOVER.md`; CI fails a PR that does (a `docs/handover-*` docs PR is exempt). Record progress in the PR description and issue comments; the dispatcher state and dashboard are the live record, and the handover is updated after merge. Report *implemented*, *CI/review passed*, *deployed* and *verified working* separately ([`docs/acceptance-gates.md`](docs/acceptance-gates.md)).
- **Decisions: proposals only (issue #303).** Add register entries as `Status: agent-proposal`. Never mark an entry `homeowner-approved`, or change a status to or from it, yourself. CI (`tools/ci/validate-decision-status.mjs`) fails the PR unless the repository owner recorded `homeowner-approval: D-0NN` in a PR comment that the entry's Source links. Foreman raises a Needs you item for each proposal in an open PR. Code gates exist for D-020, D-021, D-024 (`decisionApproved`) and D-025 (verdict carry); other entries are policy enforced by validators, CI or review.
- **No AI attribution, anywhere (homeowner rule, top priority).** No "Generated with/by …" footer, no session link, no AI co-author trailer or bot e-mail in a commit message, pull request body, issue, comment or file, and no replacement credit line. Remove such text if a tool adds it; do not rewrite merged history. CI enforces it on commit messages and the PR body ([`tools/ci/validate-commit-attribution.sh`](tools/ci/validate-commit-attribution.sh)).
- **Secret-shaped test fixtures are assembled at runtime, never literal.** A fake token, key or Bearer value used by a test (for example a redaction fixture) is built from parts when the test runs, so secret scanners such as GitGuardian never flag the repository (issue #142).
- **Do not start an issue whose prerequisites are not closed.** The issue's **Prerequisites** line is authoritative.

## Coding standards (full text: docs/coding-standards.md)
Write code another developer or agent can understand, debug, change and test. Maintainability beats the smallest diff.
- Single responsibility per method, class, module and component. Keep presentation, business logic and infrastructure apart.
- Decisions are pure functions of their inputs; code that touches the outside world carries them out.
- Composition over inheritance. No speculative extensibility, one-off interfaces or generic helper dumps.
- Warning thresholds: method 50 lines, class 400, file 500, Blazor component 250, 7 constructor dependencies, 6 parameters, line 160 characters. Do not split just to meet a number.
- Ratchet: anything already over a threshold must not grow. Put new behaviour in a new focused unit; shrinking old code is separate, authorised work.
- One statement per line. Long text (prompts, templates) lives in its own file, not inline.
- Never append unrelated behaviour to a large class or module because it is convenient. Inspect the architecture first and choose the right place.
- No unrelated refactoring or scope growth unless authorised. Structural moves are their own change with no behaviour change.
- Comments say why, not what. Remove obsolete code and unused dependencies you introduced.
- Before finishing: each changed unit has one clear responsibility, no new duplication, thresholds checked, tests cover the behaviour, build, tests and static analysis pass.
- Reviewers block on new architectural deterioration in changed code, even when it works. Old debt the change did not worsen is a follow-up, not a blocker.

## Checks before you push
```
node tools/validate-project.mjs
node --test "tests/**/*.test.mjs"
node tools/ci/check-size.mjs
```

## Map
Foreman MCP tools are listed in [`docs/foreman-mcp.md`](docs/foreman-mcp.md); the Inbox tools are `foreman_inbox` (compact card list, issue #1197), `foreman_inbox_items` (search), `foreman_propose` and `foreman_proposal_status`.

[`README.md`](README.md) · [`docs/cooperative-work.md`](docs/cooperative-work.md) · [`docs/architecture.md`](docs/architecture.md) · [`docs/agent-provider-contract.md`](docs/agent-provider-contract.md) · [`contracts/`](contracts/)
