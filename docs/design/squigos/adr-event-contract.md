# ADR-0012: Event contract (append-only envelope and initial event types)

> Draft for issue #239 (part of #107). Proposed text for the SquigOS ADR pull request in Unthred/SquigOS; the last child of #107 (#243) copies it there. The number 0012 follows the policy-contract draft (ADR-0011, #238) and is confirmed when the pull request is opened. Design only: no code and no schema files here (the JSON Schema is #242).

## Status
Proposed

Acceptance is recorded by Human merge of the PR that introduces this ADR. Until then nothing here authorises implementation.

Extends ADR-0009 (capability-first re-sequencing) and is consistent with ADR-0010 (agent adapter contract) and ADR-0011 (policy contract). It adds no new risk model; it uses ADR-0009's targets, kinds and risk tiers and its rule that the host computes the tier.

## Date
2026-11-03

---

## Context

ADR-0009 fixes the vocabulary used below: **targets** and their **kinds** (`git`, `live-system`, `host`); **risk tiers** 0 to 3, computed by the host and never taken from an agent; agent output is a **Claim** and host-produced validation output is **WorkEvidence**.

ADR-0010 says each adapter call and result maps to host events and that an adapter writes none. ADR-0011 says every action under a standing permission, every card raised and every decision is recorded as an event. Both point here for the shape.

Today the DevTest Foreman keeps state in several places (dispatcher state, job records, comments on pull requests, a handover) and the dashboard reads a mix of them. "What happened, in what order, and who did it" cannot be answered from one place, and a view can disagree with the thing it describes. The host needs one record that every view is built from.

## Decision

### D1 — The event log is the only source for the dashboard

- The host keeps one **append-only event log**. Everything the dashboard (Activity, Needs you, status of tasks and runs) shows is a projection computed from that log and from nothing else.
- A dashboard never reads agent output, a pull request, a file in a worktree or a job record directly to decide what is true. If a fact is not in the log, the dashboard does not show it, and the fix is to emit an event, not to add a second source.
- Projections may be cached or stored in a database for speed. They are disposable: deleting every projection and replaying the log rebuilds the same state.
- Events record what the host observed or did. An agent's claim enters the log only as the payload of a host-written event, labelled as a Claim where it appears (ADR-0009 D5).

### D2 — Envelope

Every event is one JSON object with these fields. All are required unless marked optional.

| Field | Type | Meaning |
|---|---|---|
| `contract` | string | Contract version, `event.v1`. |
| `id` | string | Unique event id, assigned by the host when the event is appended. A ULID or UUIDv7, so ids sort by creation. |
| `seq` | integer | Position in the log, starting at 1, increasing by exactly 1. Assigned by the log writer at append. |
| `time` | string | When the event was appended, RFC 3339 in UTC, to the millisecond. |
| `subject` | object | What the event is about (below). |
| `actor` | object | Who or what caused it (below). |
| `type` | string | One of the event types in D4. |
| `payload` | object | Type-specific data. Its keys are fixed per type (D4), plus the one optional common key `dedupeKey` (D5.5). |
| `causedBy` | string, optional | The `id` of the event that led to this one, to link a chain. |

`subject` is `{ "kind", "id" }`. Kinds: `task`, `run`, `pr`, `commit`, `card`, `install`, `policy`. `id` is the stable id the host uses for it, for example `task:239`, `run:r-0192`, `pr:458`, `commit:b5dd647`. Events about a pull request or run that belong to a task also carry `payload.task`.

`actor` is `{ "kind", "id" }`. Kinds: `human`, `host` (SquigOS or Foreman; `id` names the component), `agent` (an adapter and model, `id` such as `claude/sonnet-5-5`), `ci`. The actor is set by the host from what authenticated the action, never from a field an agent supplied.

Unknown keys in the envelope make the event invalid. Unknown keys in a payload (any key not fixed for the type in D4 and not the common optional `dedupeKey`) are rejected for a known `type`; a reader meeting an unknown `type` skips it and keeps going (D3).

### D3 — Append-only and versioning

- Events are appended and never edited, reordered or deleted. A mistake is corrected by a new event that refers to the earlier one with `causedBy`.
- The log is a sequence of JSON Lines or equivalent rows. The writer holds one lock, assigns `seq` and `time` under it, and writes the event durably before the action it announces is reported done.
- Retention may archive a prefix of the log to cold storage. It does not rewrite events. A projection is rebuilt from the archive plus the live tail.
- New event types and new optional payload keys are added by a new contract version. A reader must tolerate an unknown `type` and must refuse a `contract` value it does not know.

### D4 — Initial event types

Twelve types are fixed by this ADR. Two more, `PolicyActionTaken` and `PolicyRejected`, are required by ADR-0011. Payload keys are fixed per type; examples are in the next section.

| Type | Subject | Emitted when | Payload keys |
|---|---|---|---|
| `TaskQueued` | task | A unit of work is accepted into the queue. | `task`, `title`, `source`, `reference`, `priority` |
| `AgentAssigned` | run | The host picks an agent and model for a task and role. | `task`, `role`, `adapter`, `model`, `tier` |
| `RunStarted` | run | An adapter `run` or `review` call begins. | `task`, `operation`, `adapter`, `model`, `tier`, `worktree` |
| `RunFinished` | run | The adapter returned (any outcome). | `task`, `outcome`, `exitCode`, `durationMs`, `usage` |
| `ChecksCompleted` | pr | The host or CI finished validation of a head. | `task`, `head`, `result`, `checks`, `evidence` |
| `ReviewSubmitted` | pr | A review verdict is recorded for a head. | `task`, `head`, `verdict`, `reviewer`, `findings` |
| `FailureClassified` | run | The host classifies a failed run or check. | `task`, `class`, `retryable`, `summary` |
| `ActionRequired` | card | An uncovered action raises a Needs you card. | `action`, `onSubject`, `tier`, `reason`, `onReject` |
| `ActionResolved` | card | The Human approves or rejects a card. | `decision`, `action`, `onSubject`, `tier` |
| `Merged` | pr | The host merges a pull request. | `task`, `head`, `mergeCommit`, `gates` |
| `Installed` | install | A commit is installed on a host target. | `commit`, `target`, `previous`, `result` |
| `RolledBack` | install | An install is reverted. | `commit`, `target`, `restored`, `reason` |
| `PolicyActionTaken` | policy | An action ran under a standing permission (ADR-0011 D7). | `entry`, `policyVersion`, `action`, `onSubject`, `tier` |
| `PolicyRejected` | policy | A policy file or override was refused at load (ADR-0011 D7). | `policyVersion`, `source`, `rule`, `entry` |

Notes:

- `tier` is always the tier the host computed (ADR-0009), never an agent's value.
- `outcome` for `RunFinished` is one of `ok`, `failed`, `blocked`, `timeout`, `unavailable`, mirroring the adapter exit-code classes in ADR-0010.
- `verdict` is `pass`, `changes-requested` or `blocked`. `decision` is `approved` or `rejected`.
- `usage` carries token and cost counters reported by the adapter, as numbers only.
- `evidence` and `findings` hold references (ids or relative paths into the evidence store) and short summaries, not logs (D6).

### D5 — Ordering

1. **Total order.** `seq` is the order. Two events never share a `seq`. Readers sort by `seq`, not by `time` or `id`.
2. **Time is informational.** `time` is monotonic non-decreasing in `seq` order because the writer assigns both under one lock; if the host clock steps backwards the writer clamps to the previous event's time. Clock skew cannot reorder events.
3. **Causality.** An event that reports the outcome of something cites the event that started it with `causedBy`, and its `seq` is higher. Required pairs: `RunFinished` after `RunStarted`; `ActionResolved` after `ActionRequired`; `RolledBack` after `Installed`; `Merged` after at least one `ReviewSubmitted` with `verdict: pass` and a `ChecksCompleted` with `result: pass`, for the same `head`.
4. **Intent before effect.** The event announcing an effect (`RunStarted`, `Merged`, `Installed`) is written before the effect is reported, so a crash leaves an event without a result, never a result without an event. A reader treats a `RunStarted` with no `RunFinished` and a dead owner as an interrupted run and the host appends a `RunFinished` with `outcome: failed` and a `FailureClassified`.
5. **At least once, idempotent.** A producer that retries after a crash sends a stable `dedupeKey` (for example `run` plus `operation`) inside the payload where one applies. `dedupeKey` is an optional string allowed in the payload of every event type, in addition to that type's fixed keys in D4; it is the only payload key common to all types; the writer drops a second event with the same type and key. Projections must also tolerate a duplicate without double counting.
6. **Per-subject order.** For one subject the order of its events is the order of their `seq`. Nothing relies on order between unrelated subjects.

### D6 — No secrets and no raw logs

- An event never contains a credential, token, cookie, private key, secret value or an environment dump. This is the ADR-0009 rule for agents extended to the log, and the log is treated as readable by anyone who can see the dashboard.
- An event never contains raw output: no agent transcript, no command output, no log excerpt, no diff, no file contents, no raw prompt. Those stay in the evidence store with their own retention and redaction; an event refers to them by `evidence` id or relative path and carries at most a short `summary` (a plain sentence of 300 characters or fewer, written by the host).
- The writer enforces this, not the producer. It rejects an event that fails the schema, that has a string longer than the cap in a field not marked for text, or whose values match the secret scanner's patterns (the same scanner the run output goes through). A rejected event is not stored; the host appends a `FailureClassified` naming the type and rule but not the offending value.
- Tests build secret-shaped fixtures at runtime from parts, never literally, so the repository itself stays clean.
- Paths in events are relative to a named root; no absolute paths, no hostnames of private systems beyond the target name.

## Examples

One example per event type. Ids and times are illustrative.

`TaskQueued`
```json
{ "contract": "event.v1", "id": "01JC0A0000000000000000001A", "seq": 4101,
  "time": "2026-11-03T08:00:00.120Z",
  "subject": { "kind": "task", "id": "task:239" },
  "actor": { "kind": "host", "id": "foreman" },
  "type": "TaskQueued",
  "payload": { "task": "task:239", "title": "SquigOS ADR draft: event contract",
               "source": "github-issue", "reference": "issue:239", "priority": "normal" } }
```

`AgentAssigned`
```json
{ "contract": "event.v1", "id": "01JC0A0000000000000000002B", "seq": 4102,
  "time": "2026-11-03T08:00:02.004Z",
  "subject": { "kind": "run", "id": "run:r-0192" },
  "actor": { "kind": "host", "id": "foreman" },
  "type": "AgentAssigned", "causedBy": "01JC0A0000000000000000001A",
  "payload": { "task": "task:239", "role": "implement", "adapter": "claude",
               "model": "sonnet-5-5", "tier": 1 } }
```

`RunStarted`
```json
{ "contract": "event.v1", "id": "01JC0A0000000000000000003C", "seq": 4103,
  "time": "2026-11-03T08:00:05.310Z",
  "subject": { "kind": "run", "id": "run:r-0192" },
  "actor": { "kind": "host", "id": "foreman" },
  "type": "RunStarted", "causedBy": "01JC0A0000000000000000002B",
  "payload": { "task": "task:239", "operation": "run", "adapter": "claude",
               "model": "sonnet-5-5", "tier": 1, "worktree": "worktrees/claude-239",
               "dedupeKey": "r-0192:run" } }
```

`RunFinished`
```json
{ "contract": "event.v1", "id": "01JC0A0000000000000000004D", "seq": 4160,
  "time": "2026-11-03T08:14:41.870Z",
  "subject": { "kind": "run", "id": "run:r-0192" },
  "actor": { "kind": "host", "id": "foreman" },
  "type": "RunFinished", "causedBy": "01JC0A0000000000000000003C",
  "payload": { "task": "task:239", "outcome": "ok", "exitCode": 0, "durationMs": 876560,
               "usage": { "inputTokens": 412000, "outputTokens": 18400 } } }
```

`ChecksCompleted`
```json
{ "contract": "event.v1", "id": "01JC0A0000000000000000005E", "seq": 4171,
  "time": "2026-11-03T08:17:09.002Z",
  "subject": { "kind": "pr", "id": "pr:470" },
  "actor": { "kind": "ci", "id": "validate-project" },
  "type": "ChecksCompleted",
  "payload": { "task": "task:239", "head": "9f3c2ab", "result": "pass",
               "checks": [ { "name": "validate-project", "result": "pass" },
                           { "name": "unit-tests", "result": "pass" } ],
               "evidence": [ "evidence/pr-470/9f3c2ab/checks.json" ] } }
```

`ReviewSubmitted`
```json
{ "contract": "event.v1", "id": "01JC0A0000000000000000006F", "seq": 4190,
  "time": "2026-11-03T08:31:55.440Z",
  "subject": { "kind": "pr", "id": "pr:470" },
  "actor": { "kind": "agent", "id": "codex/gpt-5-codex" },
  "type": "ReviewSubmitted",
  "payload": { "task": "task:239", "head": "9f3c2ab", "verdict": "pass",
               "reviewer": { "adapter": "codex", "model": "gpt-5-codex" },
               "findings": [] } }
```

`FailureClassified`
```json
{ "contract": "event.v1", "id": "01JC0A0000000000000000007G", "seq": 4205,
  "time": "2026-11-03T09:02:11.730Z",
  "subject": { "kind": "run", "id": "run:r-0197" },
  "actor": { "kind": "host", "id": "foreman" },
  "type": "FailureClassified",
  "payload": { "task": "task:240", "class": "provider-usage-limit", "retryable": true,
               "summary": "The provider reported a usage limit; retry after its reset." } }
```

`ActionRequired`
```json
{ "contract": "event.v1", "id": "01JC0A0000000000000000008H", "seq": 4230,
  "time": "2026-11-03T09:40:00.015Z",
  "subject": { "kind": "card", "id": "card:c-0031" },
  "actor": { "kind": "host", "id": "foreman" },
  "type": "ActionRequired",
  "payload": { "action": "commit.install", "onSubject": "commit:b5dd647", "tier": 2,
               "reason": "No enabled policy entry covers this install.",
               "onReject": "The commit stays uninstalled; it is not offered again for 24 hours." } }
```

`ActionResolved`
```json
{ "contract": "event.v1", "id": "01JC0A0000000000000000009J", "seq": 4234,
  "time": "2026-11-03T09:44:30.600Z",
  "subject": { "kind": "card", "id": "card:c-0031" },
  "actor": { "kind": "human", "id": "homeowner" },
  "type": "ActionResolved", "causedBy": "01JC0A0000000000000000008H",
  "payload": { "decision": "approved", "action": "commit.install",
               "onSubject": "commit:b5dd647", "tier": 2 } }
```

`Merged`
```json
{ "contract": "event.v1", "id": "01JC0A000000000000000000AK", "seq": 4260,
  "time": "2026-11-03T10:05:12.220Z",
  "subject": { "kind": "pr", "id": "pr:470" },
  "actor": { "kind": "host", "id": "foreman" },
  "type": "Merged",
  "payload": { "task": "task:239", "head": "9f3c2ab", "mergeCommit": "c41d7e0",
               "gates": { "checks": "pass", "review": "pass", "mergeable": true } } }
```

`Installed`
```json
{ "contract": "event.v1", "id": "01JC0A000000000000000000BM", "seq": 4275,
  "time": "2026-11-03T10:20:48.900Z",
  "subject": { "kind": "install", "id": "install:i-0044" },
  "actor": { "kind": "host", "id": "foreman" },
  "type": "Installed", "causedBy": "01JC0A0000000000000000009J",
  "payload": { "commit": "c41d7e0", "target": { "kind": "host", "name": "foreman" },
               "previous": "b5dd647", "result": "ok" } }
```

`RolledBack`
```json
{ "contract": "event.v1", "id": "01JC0A000000000000000000CN", "seq": 4281,
  "time": "2026-11-03T10:23:02.310Z",
  "subject": { "kind": "install", "id": "install:i-0044" },
  "actor": { "kind": "host", "id": "foreman" },
  "type": "RolledBack", "causedBy": "01JC0A000000000000000000BM",
  "payload": { "commit": "c41d7e0", "target": { "kind": "host", "name": "foreman" },
               "restored": "b5dd647", "reason": "Health check failed after install." } }
```

`PolicyActionTaken`
```json
{ "contract": "event.v1", "id": "01JC0A000000000000000000DP", "seq": 4290,
  "time": "2026-11-03T10:30:00.010Z",
  "subject": { "kind": "policy", "id": "policy:release-dead-lease" },
  "actor": { "kind": "host", "id": "foreman" },
  "type": "PolicyActionTaken",
  "payload": { "entry": "release-dead-lease", "policyVersion": 7, "action": "lease.release",
               "onSubject": "lease:l-0012", "tier": 1 } }
```

`PolicyRejected`
```json
{ "contract": "event.v1", "id": "01JC0A000000000000000000EQ", "seq": 4301,
  "time": "2026-11-03T10:41:19.000Z",
  "subject": { "kind": "policy", "id": "policy:local-override" },
  "actor": { "kind": "host", "id": "foreman" },
  "type": "PolicyRejected",
  "payload": { "policyVersion": 7, "source": "local-override",
               "rule": "override-widens-bound", "entry": "retry-after-provider-reset" } }
```

### Events the writer rejects

These examples are abbreviated: they omit required envelope fields (`id`, `seq`, `time`, `subject`, and `actor` where absent), so a real submission would also fail for those. Each shows only the reason that matters.

```json
{ "contract": "event.v1", "type": "RunFinished", "payload": { "outcome": "failed", "log": "…full command output…" } }
```
Rejected: `log` is not a payload key, and raw output never enters the log (D6).

```json
{ "contract": "event.v1", "type": "RunStarted", "actor": { "kind": "agent", "id": "claude/sonnet-5-5" }, "payload": { "tier": 0 } }
```
Rejected at the host: the actor and tier of a host event come from the host's own state, not from a value an agent supplied (D2, D4).

```json
{ "contract": "event.v1", "type": "Merged", "payload": { "head": "9f3c2ab" } }
```
Rejected: there is no earlier `ReviewSubmitted` with `verdict: pass` and `ChecksCompleted` with `result: pass` for that head (D5.3).

## Rationale

- **One source.** A dashboard fed only by the log cannot disagree with the host; a wrong view is a missing or wrong event, which is a bug with a single place to fix.
- **Append-only.** The history stays trustworthy and replayable; corrections are visible rather than silently rewritten.
- **`seq` over timestamps.** Order does not depend on clocks, which on a single host and across a Node and a C# implementation would otherwise drift.
- **Small closed set.** Twelve types cover the lifecycle the Human cares about (queue, assign, run, check, review, fail, ask, merge, install, undo) and two cover policy. Detail belongs in the payload or the evidence store, not in more types.
- **No logs in events.** Keeps the log small, safe to show and cheap to retain forever, and puts redaction in one place.
- **Testability.** Each rule has a direct test: a rejected event is not stored; replay of the log rebuilds identical projections; a crash between `RunStarted` and the result leaves an interrupted run that is closed; a duplicate `dedupeKey` is dropped; a secret-shaped value is refused.

## Consequences

### Positive
- Activity, Needs you and any status view are consistent and explainable from one record.
- Foreman and SquigOS can emit the same events, so the dashboard can move between hosts with its history.
- "Why did it do that" for a covered action traces to the entry, policy version and event chain (ADR-0011 D7).

### Negative
- Every fact a view needs must be an event first; adding a view may need a new event type or payload key, which needs a contract version.
- The writer is a single serialised point; throughput is bounded by it. Expected volume (tens of events per minute at most) makes this acceptable.
- Rebuilding a projection from a long log costs time; snapshots of projections may be kept, tagged with the `seq` they cover.
- Foreman today does not emit these events. Until it does, its dashboard has other sources and this contract is not yet true of it.

## Related
- ADR-0009 (vocabulary, tiers computed by the host), ADR-0010 (adapter contract, #237), ADR-0011 (policy contract, #238).
- JSON Schema drafts: #240 to #242 (this contract's schema is #242). Implementation: after the Human accepts this ADR.
