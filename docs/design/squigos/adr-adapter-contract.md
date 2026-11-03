# ADR-0010: Agent adapter contract (run, review, usage, capabilities)

> Draft for issue #237 (part of #107). Proposed text for the SquigOS ADR pull request in Unthred/SquigOS; the last child of #107 (#243) copies it there. The number 0010 is the next free one after ADR-0009 at the time of writing and is confirmed when the pull request is opened. Design only: no code and no schema files here (the JSON Schema is #240).

## Status
Proposed

Acceptance is recorded by Human merge of the PR that introduces this ADR. Until then nothing here authorises implementation.

Extends ADR-0009 (capability-first re-sequencing). It adds no new risk model; it uses ADR-0009's targets, kinds and risk tiers and its rule that the host computes the tier.

## Date
2026-11-03

---

## Context

ADR-0009 puts SquigOS between the Overseer and the Implementer and requires both to be agent agnostic. It fixes the vocabulary used below:

- **Target** and its **kind**: `git`, `live-system`, `host`.
- **Risk tiers**: 0 read only; 1 sandboxed and reversible; 2 shared and reversible; 3 security-sensitive or hard to undo.
- The tier is **computed by the host** (SquigOS, or Foreman until SquigOS replaces it) from target, environment, action and the paths or resources the brief covers. It is never taken from an agent's description of its own work. Tiers are monotonic within a Run.
- Agent output is a **Claim**; host-produced validation output is **WorkEvidence**. A Claim such as "tests pass" is not true without Evidence (ADR-0009 D5).
- Publication (push, PR, apply) is done by the host, never by the agent; Implementers hold no credentials (ADR-0009 D4).

ADR-0009 does not say how a host talks to a concrete agent (Claude, Codex, Cursor, a local model). Today the DevTest Foreman hard-codes provider behaviour and lets agents call `gh` and push. Foreman will later be replaced by SquigOS, so the contract must be implementable by a Node host and a C# host without sharing code.

## Decision

### D1 — An adapter is a standalone CLI speaking JSON

An adapter is an executable with this protocol:

- The host starts it with one argument, the operation name: `run`, `review`, `usage` or `capabilities`. No other arguments carry data.
- **One JSON request on stdin**, UTF-8, then end of input. **One JSON result on stdout**, then exit. Nothing else is written to stdout. Human-readable and diagnostic text goes to stderr and is advisory only.
- The exit code (D4) says whether a valid result was produced; the result carries the outcome of the work.
- Credentials never appear in argv, the request or the result. The adapter process receives no GitHub or forge credentials and no host credentials (ADR-0009 D4). Provider authentication for the agent itself is the adapter's own, configured out of band on the host.
- Every request has `contract` (a version string, e.g. `adapter.v1`), `op`, and `requestId`. Every result echoes `contract`, `op` and `requestId`. Unknown fields in a request are rejected; unknown fields in a result are ignored by the host and logged.
- The host validates every request before sending it and every result before using it. A result that fails validation is treated as exit code 5 (see D4) regardless of the process exit code.
- An adapter can be run from a plain shell: `echo '{...}' | adapter run`. It is stateless between calls; any session state is referenced by an opaque `sessionRef` the adapter returned earlier.
- Transcripts and logs are returned as references to files the adapter wrote under a host-provided directory, not inline, so stdout stays small and bounded. The host redacts them before storing or showing them.

### D2 — Four operations

#### `run`

Do a task in a prepared worktree. The host prepares the worktree and the brief; the adapter edits files and may run its own local commands inside the worktree, then returns.

Request:

```json
{
  "contract": "adapter.v1",
  "op": "run",
  "requestId": "01JD8Z3K9Q0000000000000001",
  "task": {
    "ref": "issue-237",
    "brief": "Write the adapter contract ADR draft.",
    "inScope": ["docs/design/squigos/"],
    "outOfScope": ["code", "schema files"],
    "allowedPaths": ["docs/design/squigos/**"],
    "changeBudget": { "maxFiles": 3, "maxChangedLines": 800 }
  },
  "target": { "kind": "git", "name": "devtest-infrastructure" },
  "riskTier": 1,
  "worktree": "/work/wt",
  "model": "sonnet",
  "timeLimitSeconds": 1800,
  "outputDir": "/work/out",
  "sessionRef": null,
  "answers": []
}
```

`riskTier` is supplied by the host as information and as a limit on what the adapter may attempt. The adapter must not change it, and the result has no tier field: the host reclassifies the real change set after the run (ADR-0009 D2).

Result:

```json
{
  "contract": "adapter.v1",
  "op": "run",
  "requestId": "01JD8Z3K9Q0000000000000001",
  "status": "finished",
  "summary": "Added docs/design/squigos/adr-adapter-contract.md.",
  "changes": [
    { "path": "docs/design/squigos/adr-adapter-contract.md", "why": "the ADR draft" }
  ],
  "claims": [ { "text": "validate-project passes" } ],
  "question": null,
  "transcriptRef": "transcript.jsonl",
  "sessionRef": "opaque-session-id",
  "usage": { "inputTokens": 120000, "outputTokens": 9000, "cachedTokens": 80000, "costEquivalentUsd": null }
}
```

`status` is one of:

- `finished`: the adapter believes the task is done. `changes` is a per-file report with a reason; an unexplained change is a breach (ADR-0009 D5). `claims` are recorded as Claims, never as Evidence.
- `failed`: the adapter could not complete the task. `reason` (short code such as `agent-error`, `cannot-complete`, `limit-reached`) and `summary` are required.
- `needs-input`: the agent needs a human decision. `question` (text and optional choices) is required. The host turns this into an action-required item for the Human, never a chat question. The host resumes with a new `run` request carrying `sessionRef` and `answers`.

`failed` and `needs-input` are normal outcomes and exit with code 0.

#### `review`

Judge a diff. The reviewer is a fresh session given only the issue, the diff and the host's check results. It does not run tests and does not touch the forge.

Request:

```json
{
  "contract": "adapter.v1",
  "op": "review",
  "requestId": "01JD8Z3K9Q0000000000000002",
  "subject": { "ref": "pr-512", "headSha": "0123456789abcdef0123456789abcdef01234567" },
  "issue": { "title": "Adapter contract ADR draft", "body": "Part of #107 ..." },
  "diff": "diff --git a/docs/design/squigos/adr-adapter-contract.md ...",
  "checkResults": {
    "source": "host",
    "headSha": "0123456789abcdef0123456789abcdef01234567",
    "steps": [ { "name": "validate-project", "status": "passed", "failures": [] } ]
  },
  "riskTier": 1,
  "model": "opus",
  "timeLimitSeconds": 1200,
  "outputDir": "/work/out"
}
```

Result:

```json
{
  "contract": "adapter.v1",
  "op": "review",
  "requestId": "01JD8Z3K9Q0000000000000002",
  "headSha": "0123456789abcdef0123456789abcdef01234567",
  "verdict": "approve",
  "findings": [
    { "kind": "follow-up", "text": "Link the exit-code table from the README." }
  ],
  "usage": { "inputTokens": 40000, "outputTokens": 2000, "cachedTokens": 0, "costEquivalentUsd": null }
}
```

`verdict` is `approve` or `reject`. This generalises today's validated verdict schema (`PASS`/`CHANGES`, finding kinds `blocking`/`follow-up`, `contracts/verdict.v1.schema.json`). Rules the host enforces on the result:

- `reject` requires at least one `blocking` finding; `approve` allows none.
- `headSha` must equal the request's; a mismatch is invalid.
- The adapter did not run the checks, so the old `commandsRun` field is dropped. Evidence for the verdict is the host's `checkResults`, which the host produced from a clean copy of the head.
- The host, not the adapter, decides reviewer independence (a fresh session, a model that differs from the author's). The adapter cannot waive it.

#### `usage`

Report remaining allowance. Request carries only `contract`, `op`, `requestId`.

```json
{
  "contract": "adapter.v1",
  "op": "usage",
  "requestId": "01JD8Z3K9Q0000000000000003",
  "metered": true,
  "limits": [
    { "name": "weekly", "used": 0.42, "unit": "fraction", "resetsAt": "2026-11-08T09:00:00Z" },
    { "name": "5h", "used": 0.10, "unit": "fraction", "resetsAt": "2026-11-03T14:00:00Z" }
  ],
  "observedAt": "2026-11-03T10:15:00Z"
}
```

For an unmetered (local) model the result is `{ "metered": false, "limits": [] }` and the host budgets by host load instead. `resetsAt` is null when the provider does not report it; the host then falls back to its own backoff (D-019 in DevTest). Usage is advisory: a provider's report may lag, and a limit reached during `run` is returned as `failed` with reason `limit-reached`.

#### `capabilities`

Declare what the adapter and its models can do. Request carries only `contract`, `op`, `requestId`.

```json
{
  "contract": "adapter.v1",
  "op": "capabilities",
  "requestId": "01JD8Z3K9Q0000000000000004",
  "adapter": { "name": "claude", "version": "1.0.0" },
  "operations": ["run", "review", "usage", "capabilities"],
  "models": [
    { "id": "sonnet", "contextTokens": 200000, "costTier": "medium", "roles": ["implement", "review"] }
  ],
  "shell": true,
  "resumable": true,
  "trustedForHighRisk": false
}
```

Capabilities are **declarations, not authority**. `trustedForHighRisk` is an input to the host's policy; it never lowers a tier and never grants a permission. The host verifies declarations with a conformance task before assigning real work: implement a trivial change and return `finished`, review one seeded-bad and one seeded-good diff correctly, return `usage` in this shape, and return `capabilities`. An adapter that fails conformance gets no work.

### D3 — Host-provided check step

A `check` summary (build, tests, lint, format: counts per step plus the first few failures, bounded and redacted) is a **host service the adapter may call**, not a fifth adapter operation. How an agent invokes it (tool, command in its worktree) is the adapter's concern. The host never relies on the agent's report of passing tests; the final gate is the host's own clean-copy run. (Shapes: #108.)

### D4 — Exit codes

Exit codes separate "the adapter produced a valid result" from "the adapter or its environment failed", so a host never mistakes an infrastructure fault for a task outcome, or the reverse (compare DevTest D-017).

| Code | Name | Meaning | Stdout | Host action |
|---|---|---|---|---|
| 0 | `ok` | A valid result was written. Includes `failed`, `needs-input` and `reject`. | one JSON result | Use the result. |
| 2 | `bad-request` | stdin was not valid JSON, failed validation, or named an unknown contract version. | error object | Fix the host; do not retry unchanged. |
| 3 | `unsupported` | The operation, model or a requested capability is not supported. | error object | Reassign or reconfigure. |
| 4 | `refused` | The adapter refused on safety grounds: a credential found in the request, a worktree path outside the allowed root, a tier it will not act under. | error object | Stop; raise to the Human. Never retry with the guard weakened. |
| 5 | `bad-result` | The adapter could not produce a result in the contract shape, or the host's validation of the result failed (the host assigns this code itself in that case). | none or partial | Treat as an adapter defect; no retry loop. |
| 6 | `unavailable` | The agent or provider could not be reached or is not logged in, or a usage limit prevented any work. | error object | Back off; mark the adapter unavailable. |
| 7 | `timeout` | The time limit passed. The adapter stopped its work; partial changes may exist in the worktree. | error object | Host decides: discard the worktree or continue. |
| 70 | `internal` | An unexpected adapter fault. | none | Report as an adapter defect. |

Error objects on stdout have the form `{ "contract", "op", "requestId", "error": { "code": "<name>", "message": "<short, no secrets>" } }`. Killed by signal is treated as 7 when the host's own timer fired and as 70 otherwise. All other codes are reserved; the host treats an undefined code as 70.

### D5 — The host owns risk tiers and every consequential action

- The tier comes from the host's own computation (ADR-0009 D2). It appears in a request as information and a limit. It is absent from every result, and a result field that tries to carry one is ignored and logged.
- After `run`, the host reclassifies the actual change set. A change that exceeds the approved tier holds the Run (ADR-0009 `ScopeBreach`).
- The adapter has no GitHub or forge access. Branches, pushes, pull requests, review posts and merges are done by the host from adapter results. A result field is never executed as a command.
- A `trustedForHighRisk` declaration, a model name or an adapter name is not a permission. Whether an adapter may work at tier 2 or 3 is the host's policy (the policy contract, #238).

## Rationale

- **System boundaries.** Process-level JSON keeps the host free of provider names and works from Node or C# alike. The host owns Git, worktrees, checks and publication; the adapter owns only the agent conversation.
- **Event sourcing.** Each call and result maps to host events (`RunStarted`, `RunFinished`, `ReviewSubmitted`; see #239). The adapter writes no events; it returns data the host records.
- **Layering.** One shape for all providers lets role assignment, allowance handling and conformance live in the host, in config, with no `if (provider == ...)` in core.
- **Testability.** The contract can be exercised with a fake adapter, a shell one-liner, and golden request/result files; a failing fake must receive no work.

## Consequences

### Positive
- Agents are switchable by configuration; a fake third adapter can pass conformance and receive work.
- Agents never hold forge credentials, so no agent can publish on its own.
- Reviewers do not burn tokens rerunning tests; the host's check results are the evidence.
- The same contract is used by Foreman now and SquigOS later, so the swap does not change adapters.

### Negative
- Every existing adapter (Claude, Codex) must be converted to the CLI form (#106).
- A process per call costs start-up time, and session state must round-trip through `sessionRef`.
- A new field or exit code needs an ADR update and a contract version bump (`adapter.v2`), so the contract is slow to extend.
- Usage reporting depends on what each provider exposes; some limits will be `unknown` or lag.

## Alternatives Considered

- **A library per host language (Node package, C# interface).** Rejected: it ties adapters to one runtime, and ADR-0009 wants the Implementer to be any CLI.
- **A long-lived server per adapter (HTTP or MCP).** Rejected for now: it adds lifecycle, ports and auth for a single-user, single-host deployment. A CLI wrapper can front a server later without changing the contract.
- **Letting agents call the forge directly (today's behaviour).** Rejected: it breaks ADR-0009's no-credentials rule and makes scope and tier checks advisory.
- **A single non-zero failure code.** Rejected: an unattended host must tell "the task failed" (exit 0, `failed`) from "the adapter failed" (2-7, 70).
- **Adapter-reported risk tier.** Rejected by ADR-0009.

## Notes

- Extends ADR-0009 (D2 targets and tiers, D4 no credentials for Implementers, D5 mechanical scope, D6 usage). Does not supersede it.
- Related drafts: policy contract (#238), event contract (#239). JSON Schema drafts: #240 to #242. Implementation: #106 and #108 after the Human accepts this ADR.
- Open question for review: whether `check` should later become a fifth operation for agents that cannot call a host tool.
