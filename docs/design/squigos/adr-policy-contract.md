# ADR-0011: Policy contract (standing permissions tagged with risk tiers)

> Draft for issue #238 (part of #107). Proposed text for the SquigOS ADR pull request in Unthred/SquigOS; the last child of #107 (#243) copies it there. The number 0011 follows the adapter-contract draft (ADR-0010, #237) and is confirmed when the pull request is opened. Design only: no code and no schema files here (the JSON Schema is #241).

## Status
Proposed

Acceptance is recorded by Human merge of the PR that introduces this ADR. Until then nothing here authorises implementation.

Extends ADR-0009 (capability-first re-sequencing) and is consistent with ADR-0010 (agent adapter contract). It adds no new risk model; it uses ADR-0009's targets, kinds and risk tiers and its rule that the host computes the tier.

## Date
2026-11-03

---

## Context

ADR-0009 fixes the vocabulary used below:

- **Target** and its **kind**: `git`, `live-system`, `host`.
- **Risk tiers**: 0 read only; 1 sandboxed and reversible; 2 shared and reversible; 3 security-sensitive or hard to undo.
- The tier is **computed by the host** (SquigOS, or Foreman until SquigOS replaces it). It is never taken from an agent's description of its own work, and tiers are monotonic within a Run.

ADR-0010 says an adapter is told a tier and may not change it, and that whether an adapter may work at tier 2 or 3 is host policy ("the policy contract, #238"). This ADR is that policy.

Today the homeowner is asked about actions they would always approve (release a lease whose process is gone, retry a job after a provider reset, install a reviewed merged commit, rebase a conflicting PR, file an agent-fixable issue). Each question costs attention and, when asked in chat, is lost. The host needs a small, reviewable list of **standing permissions**: actions pre-authorised in configuration so the host does them without asking, with everything else becoming a dashboard card for the Human.

## Decision

### D1 — A policy is a versioned file of standing permissions

- The policy is a single JSON document, versioned in Git and reviewed like code. It carries `contract` (a version string, e.g. `policy.v1`), `policyVersion` (an integer that increases with every change) and `entries`.
- A **local override** may exist on the host. It can only **narrow** the committed policy: disable an entry, lower a bound, shrink a scope. It can never add an entry, enable a disabled one, raise a bound, widen a scope or change a tier. The loader computes the merge and rejects the whole override, not just the offending field, if any part widens (see D5).
- The policy is data. The host never executes a policy field as a command; an entry names an **action class** from a catalogue compiled into the host (D3).
- An unknown field, an unknown `contract` version, or an unparseable file makes the loader reject the file. With no valid policy loaded the host runs with an empty one: nothing is pre-authorised and everything becomes a card.

### D2 — Entry shape

Every entry has these fields. All are required unless marked optional.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable, unique, kebab-case. Recorded in every Activity row written under the entry. |
| `description` | string | One sentence for the Human: what the host will do on its own. |
| `action` | string | An action class from the host catalogue (D3). |
| `tier` | integer 0 to 2 | The ADR-0009 tier the author claims for this action. Checked against the host's own classification (D4). Never 3. |
| `scope` | object | Where the permission applies (below). |
| `bounds` | object | Limits on how often and how much (below). |
| `enabled` | boolean | `false` keeps the entry for review but grants nothing. |
| `onReject` | string, optional | Plain text for the card shown when a bound is hit or the action is not covered: what happens if the Human rejects. Falls back to the action class default. |

`scope` selects what the entry may touch. It contains only keys the action class declares, for example:

- `targets`: a list of `{ "kind", "name" }` (ADR-0009 target kinds). `*` is not allowed for `name` at tier 2.
- `paths`: glob patterns the action may touch, for actions on files.
- `subjects`: the kinds of item it applies to (`lease`, `job`, `pr`, `issue`, `commit`).
- `conditions`: named, host-evaluated checks that must hold at the moment of action, for example `process-gone`, `provider-reset-passed`, `reviewed-and-merged`, `ci-green`, `no-open-conflict-with-owner-edit`. Conditions are evaluated by the host from its own observations, never from an agent's report.

`bounds` limits use:

- `maxPerHour`, `maxPerDay` (integers, required at tier 2, optional at tiers 0 and 1);
- `maxPerSubject` (integer, how many times for the same item before a card is raised);
- `maxChangedLines`, `maxFiles` (for actions that change files);
- `window` (optional: days and hours when the entry applies).

Required bounds are stricter as the tier rises. An entry at tier 2 without `maxPerDay`, a `targets` list and at least one `condition` is rejected at load.

### D3 — Action classes are a closed catalogue owned by the host

- An **action class** is a named, parameter-checked operation implemented in the host (for example `lease.release`, `job.retry`, `commit.install`, `pr.rebase`, `issue.file`). The catalogue ships with the host and changes only with the host. A policy cannot define a new action class and cannot name a shell command, script or URL.
- Each action class declares in the catalogue: its **minimum tier** (the lowest tier the host will ever assign it), its permitted `scope` keys and `conditions`, its default `onReject` text, and the **events** it emits (ADR event contract, #239).
- Whether an action class exists at all is a code change reviewed with the host, not a policy change.

### D4 — The host computes the tier; the policy only tags it

- The `tier` on an entry is a **tag for the reader and a check**, not a source of truth. At load the host compares it with the action class's minimum tier. If the tag is lower than the minimum the loader rejects the entry. A tag higher than the minimum is allowed (it is stricter, for example to require stricter bounds).
- At use the host computes the tier of the concrete action as ADR-0009 requires (from target, environment, action and the paths or resources involved). The entry applies only if the computed tier is **less than or equal to** the entry's tag and **at most 2**. If the real action is higher, for example it touches a path that makes it tier 3, the entry does not cover it and the host raises a card (D6). The Run is held when the action is part of a Run (ADR-0009 `ScopeBreach`).
- A model name, an adapter name or an adapter's `trustedForHighRisk` declaration (ADR-0010) is never a permission and cannot make an entry apply.

### D5 — Tier 3 and the hard limits cannot be granted

Two rules, both enforced by the loader and again at use:

1. **Tier 3 cannot be granted.** No entry may have `tier: 3`, and no entry may cover an action whose computed tier is 3. A tier 3 action always needs a Human decision at the time, recorded as `ActionResolved`. There is no standing permission for it, no time-limited form of one and no override that enables one.
2. **The hard limits are outside the policy.** They are not entries and are not a list the policy can edit. They are fixed in host code and listed here:
   - no reboot of the host or any machine;
   - no change to a production live-system target (for the homeowner's house: production Home Assistant) beyond read only;
   - no paid overage, credits or switch to paid API billing;
   - no bypassing a review or merge gate (an author does not merge their own work; opposite-agent review stands);
   - no public exposure of a service, and no firewall or remote-access change;
   - no disclosure, creation or change of a credential.

   The loader rejects any entry whose `action` class, `scope.targets`, `scope.paths` or `conditions` touch a hard limit. Each action class in the catalogue is marked in code as touching a hard limit or not; a class that does is simply not selectable by a policy.

Because the loader rejects the file, a policy author learns of the problem at review time, not at the moment an action is attempted. The host also checks the hard limits at use, so a bug in the loader or a hand-edited file cannot grant one.

Local override and merge:

- The merged effective policy must be a subset of the committed one: every entry id exists in both, no bound is higher, no scope is wider, `enabled` is not flipped from `false` to `true`, `tier` is unchanged.
- Any violation rejects the override and the host keeps the committed policy, with an alert.

### D6 — Anything not covered becomes one Approve/Reject card

- An action that is not covered by an enabled entry, exceeds a bound, or fails a condition becomes an **action-required item**: one card on the dashboard "Needs you" panel. It states what will happen, on what, at which computed tier, and what happens on reject. It is never a question in chat or in an agent's report; agent prompts say so.
- One card per distinct action on one subject. Repeating the same uncovered action does not raise another card while one is open.
- **Approve** carries out that single action once. It does not create or widen an entry. **Reject** records the decision and takes the action's reject path (`onReject`), for example: leave the item as it is and do not retry for the cooldown period.
- Making an approval standing means editing the policy file in Git and passing review (D1). The host may suggest an entry when the Human approves the same action repeatedly; it does not write one.
- Tier 3 actions raise a card whose approval is a single, explicit Human decision. The card shows the computed tier and the reason.

### D7 — Every action under a standing permission is recorded

- Each action taken under an entry emits `PolicyActionTaken` (ADR event contract, #239) with the entry `id`, `policyVersion`, the subject, the computed tier and the time. It is shown in Activity, and a covered action can be traced to the entry and policy version that allowed it.
- Each card raised emits `ActionRequired` and each decision `ActionResolved` with the Human as actor.
- A rejected policy file or override emits `PolicyRejected` with the reason (no secret, no raw file content).
- Events never carry secrets or raw logs.

### D8 — The policy is evaluated by the host, never by an agent

- Agents and adapters do not read the policy, cannot ask what is covered and cannot claim that something is. The adapter contract has no policy operation.
- The host evaluates the policy from its own state at the moment of action, and checks the conditions then, not when the policy was loaded.

## Example policy

A policy file with five entries, all at tiers 0 to 2. The tier tag follows the action class minimum shown in the rationale column. Hard-limit and tier 3 examples follow.

```json
{
  "contract": "policy.v1",
  "policyVersion": 7,
  "entries": [
    {
      "id": "release-dead-lease",
      "description": "Release a lease whose owning process is gone.",
      "action": "lease.release",
      "tier": 1,
      "scope": {
        "targets": [ { "kind": "host", "name": "dispatcher" } ],
        "subjects": [ "lease" ],
        "conditions": [ "process-gone" ]
      },
      "bounds": { "maxPerHour": 10 },
      "enabled": true
    },
    {
      "id": "retry-after-provider-reset",
      "description": "Retry a job once its provider usage limit has reset.",
      "action": "job.retry",
      "tier": 1,
      "scope": {
        "targets": [ { "kind": "git", "name": "devtest-infrastructure" } ],
        "subjects": [ "job" ],
        "conditions": [ "provider-reset-passed" ]
      },
      "bounds": { "maxPerDay": 20, "maxPerSubject": 2 },
      "enabled": true
    },
    {
      "id": "file-agent-fixable-issue",
      "description": "File an issue for a failure an agent can fix.",
      "action": "issue.file",
      "tier": 2,
      "scope": {
        "targets": [ { "kind": "git", "name": "devtest-infrastructure" } ],
        "subjects": [ "issue" ],
        "conditions": [ "classified-agent-fixable" ]
      },
      "bounds": { "maxPerDay": 5, "maxPerSubject": 1 },
      "enabled": true
    },
    {
      "id": "rebase-conflicting-pr",
      "description": "Rebase a pull request that conflicts with main and has no owner edits.",
      "action": "pr.rebase",
      "tier": 2,
      "scope": {
        "targets": [ { "kind": "git", "name": "devtest-infrastructure" } ],
        "subjects": [ "pr" ],
        "paths": [ "**" ],
        "conditions": [ "no-open-conflict-with-owner-edit", "ci-green-before-rebase" ]
      },
      "bounds": { "maxPerDay": 5, "maxPerSubject": 1, "maxFiles": 40 },
      "enabled": true,
      "onReject": "The pull request stays as it is and is not retried for 24 hours."
    },
    {
      "id": "install-reviewed-merged-commit",
      "description": "Install a commit that is merged to main after opposite-agent review and green CI.",
      "action": "commit.install",
      "tier": 2,
      "scope": {
        "targets": [ { "kind": "host", "name": "foreman" } ],
        "subjects": [ "commit" ],
        "conditions": [ "reviewed-and-merged", "ci-green" ]
      },
      "bounds": { "maxPerDay": 6 },
      "enabled": false
    }
  ]
}
```

Notes on the example:

- `install-reviewed-merged-commit` is `enabled: false`: it is kept so the Human can review it, and it grants nothing. Until it is enabled in Git, installs raise a card.
- A local override may set `enabled` to `false` on any entry or lower `maxPerDay` on `retry-after-provider-reset` to 10. It may not add a sixth entry, set `enabled` to `true` on the install entry, or raise any bound.

### Entries the loader rejects

Each of these fails at load, with the entry id and rule in the message.

```json
{ "id": "restart-tower", "action": "host.reboot", "tier": 1, "...": "..." }
```
Rejected: `host.reboot` touches a hard limit (no reboot). Not selectable.

```json
{ "id": "tune-ha", "action": "ha.service-call",
  "scope": { "targets": [ { "kind": "live-system", "name": "home-assistant-production" } ] } }
```
Rejected: a production live-system target beyond read only is a hard limit.

```json
{ "id": "auto-merge-own-work", "action": "pr.merge", "tier": 3, "...": "..." }
```
Rejected twice: `tier: 3` cannot be granted, and merging past the review gate is a hard limit.

```json
{ "id": "rotate-token", "action": "credential.rotate", "tier": 2, "...": "..." }
```
Rejected: the action class computes to tier 3 and touches a hard limit (credentials); a lower tag does not help (D4).

```json
{ "id": "retry-more", "action": "job.retry", "tier": 0, "...": "..." }
```
Rejected: the tag 0 is below the action class minimum (1).

## Rationale

- **System boundaries.** The policy is data and the action catalogue is code. A policy author cannot widen what the host is capable of, only choose from what it already can do safely.
- **Layering.** The hard limits live in code, below the policy. The policy has no way to name them, so there is nothing to misconfigure. The loader check is early feedback, the use-time check is the guarantee.
- **Safe default.** An empty or invalid policy means everything becomes a card. The failure mode is more questions, not more authority.
- **Narrowing only.** A host-local override is useful for pausing something quickly, and cannot become a quiet way to grant more than review allowed.
- **Traceability.** `policyVersion` and entry `id` in every action make "why did it do that without asking" answerable from the event log.
- **Testability.** Each rule has a direct test: a covered action runs unasked; an uncovered one raises exactly one card; approve and reject each take effect; an override cannot widen; a hard-limit or tier 3 entry is rejected at load.

## Consequences

### Positive
- Routine, reversible actions stop interrupting the Human, with the permission written down and reviewed in Git.
- The Human sees every uncovered action as one card with the consequence of each choice.
- Agents are told nothing about policy, so a prompt cannot talk the host into an action.
- Foreman and SquigOS evaluate the same file.

### Negative
- Every new kind of routine action needs a host code change (a new action class) before it can be pre-authorised.
- Authors must keep bounds and conditions tight; a tier 2 entry is deliberately verbose.
- Approving an action repeatedly does not become standing by itself; the Human must edit the policy through review.
- Foreman does not evaluate conditions the same way as a future SquigOS unless both implement the same named conditions; the catalogue must be documented per condition.

## Alternatives Considered

- **Let tier 3 be granted with a time limit or a second confirmation.** Rejected: ADR-0009 treats tier 3 as security-sensitive or hard to undo; a pre-authorisation defeats the point of asking at the time.
- **Hard limits as ordinary policy entries marked "deny".** Rejected: they would be editable, and an editing mistake could remove one. They are fixed in code.
- **Free-form action fields (shell commands, scripts) in entries.** Rejected: it turns a reviewed data file into arbitrary execution and bypasses tier computation.
- **Trusting the tier on the entry.** Rejected by ADR-0009; the host computes it and the tag is only checked.
- **Approval that creates a standing entry automatically.** Rejected: permission changes are reviewed in Git, not made by a click.
- **A local override that can also add entries.** Rejected: it would let a host-only file grant authority that review never saw.
- **Letting agents ask the policy what is allowed.** Rejected: it invites agents to plan around the boundary; the host simply decides.

## Notes

- Extends ADR-0009 (D2 targets and tiers, D4 no credentials for Implementers, D5 mechanical scope). Consistent with ADR-0010 (the host owns tiers and every consequential action; `trustedForHighRisk` is not a permission). Does not supersede either.
- Related drafts: adapter contract (#237), event contract (#239; event names used here: `PolicyActionTaken`, `PolicyRejected`, `ActionRequired`, `ActionResolved`, to be confirmed there). JSON Schema drafts: #240 to #242, the policy file schema is #241. Implementation: #102 after the Human accepts this ADR.
- Open questions for review: whether `maxPerDay` should be required at tier 1 too; whether the host should be allowed to suggest a new entry after repeated approvals; whether `window` is needed in the first version.
