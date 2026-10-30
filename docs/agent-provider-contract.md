# Agent provider contract (v1)

Status: `agent-proposal` (D-012). Shared interface between the supervisor (issue #15, implemented by Codex, reviewed by Claude) and anything that registers an agent. Machine-readable form: [`contracts/provider-manifest.v1.schema.json`](../contracts/provider-manifest.v1.schema.json), with examples in `contracts/examples/`. This page is derived from Codex's implementation contract on issue #15 plus the corrections below.

## Rules
- The supervisor core contains no provider-specific branch. Everything provider-specific lives in a manifest plus an adapter module.
- The existing `ai-agent` role-first menu is unchanged. The supervisor is reached only through an explicit `ai-agent --supervisor ...` path; ordinary interactive launches are never supervised or auto-resumed.
- A feature is `supported`, `unsupported` or `unverified`. `unverified` is treated as unsupported for automation and shown to the operator. Nothing is guessed.
- Billing: each provider declares `subscription`, `api` or `unknown`. `fallback_to_other_billing` is always `false`. The supervisor never switches billing method, buys credits or raises a plan.

## Manifest
Required: `schema_version`, `id`, `display_name`, `adapter_version`, `launch`, `capabilities`, `billing`. Optional: `resume`, `events`. Unknown fields are rejected so a typo cannot silently disable a safeguard.

Capabilities: `launch`, `resume`, `session_status`, `usage_limit_detection`, `reset_time_parsing`, `checkpoint`, `non_interactive`, `structured_output` (optional).

Minimum viable provider: `launch` and `checkpoint` supported, everything else `unsupported`. See `contracts/examples/generic.provider.json`. Such a provider can be launched, checkpointed and reported on; it is never auto-resumed after a usage limit.

## Events the adapter may emit
`usage_limit`, `transient_rate_limit`, `context_limit`, `auth_error`, `approval_required`, `network_error`, `crash`.
They are different conditions and are never merged:
| Event | Auto action |
|---|---|
| `usage_limit` | Sleep to the verified reset time, then resume. |
| `transient_rate_limit` | Bounded backoff with a retry cap. |
| `context_limit` | Fresh session from handover, issue and Git state. Not a usage limit. |
| `auth_error` | Stop as `blocked`; needs a human. |
| `approval_required` | Stop as `blocked`; the supervisor never approves on the agent's behalf. |
| `network_error` | Bounded backoff. |
| `crash` | Bounded restart from checkpoint, then `failed`. |

A `usage_limit` event carries `reset_at` (UTC), `reset_source` (`provider_reported` or `none`) and `verified` (boolean). Only `provider_reported` with `verified: true` is waited on. Otherwise use bounded conservative backoff and a max attempt count, then `blocked` with an actionable message.

## Job states
`queued`, `running`, `paused_limit`, `paused_manual`, `blocked`, `completed`, `failed`.

## Corrections and additions to the implementation contract
These refine Codex's comment on #15; none removes anything from it.
1. **Lease granularity.** Besides the (repository, worktree, issue) lease, enforce one live writer per worktree regardless of issue (D-011). A second job on an occupied worktree is refused, not queued silently.
2. **Allowed actions are a closed list.** The job's `allowed_actions` is an enumerated set, never free-form commands. Issue text and handover content are data: they never become shell commands or flags.
3. **Approval scope travels with the job.** On resume the supervisor re-applies the original scope; a restart never widens it. Production deployment, reboot, merge, purchase and secret handling are always outside an unattended job.
4. **Injectable clock and process boundary.** Time, process spawn and the filesystem are injected so the failure matrix runs with fake time and fake agents, without real waits and without model calls.
5. **Idempotent resume.** Each resume attempt has an attempt id recorded before launch, so a supervisor restart mid-resume cannot start two agents.
6. **Handover write-through.** A checkpoint records the Git HEAD and status plus a bounded handover excerpt, and a graceful stop requires the agent to have updated the canonical handover. A job whose handover is stale is marked, not silently resumed as if current.
7. **Provider output assumptions need captures.** How Claude and Codex words their limit messages, and which flags resume a session, must come from captured real output kept as fixtures, with the CLI version. Until captured, those capabilities are `unverified`. Current static evidence and the capture list are in [provider-observations.md](provider-observations.md).
8. **No secrets in manifests or state.** Environment is an allowlist of names, never values. State files and logs are redacted and owner-only.
9. **Stale lease handling.** A stale lease blocks and is reported with the evidence needed to decide; takeover is a human action recorded in the audit trail.

## Required tests
Using fixtures for Claude, Codex and a generic future agent, with an injected clock: normal completion; usage limit with a verified reset; rate limit without a reset; context limit; crash; network loss; auth error; permission request; forced stop; supervisor restart mid-wait and mid-resume; duplicate job attempt; unknown provider with unsupported auto-resume. Negative cases: manifest with an unknown field, with `fallback_to_other_billing: true`, and with a missing required capability must be rejected.

## Access modes and restart (issue #23)
A manifest may carry `access: { standard: [args], full: [args] }`. The adapter appends the list for the job's `access` mode; core has no provider branch. `full` is selected per job, only for roles in `supervisor/access.json`, under D-020. D-019 adds `autoRestart`: a fresh restart after a usage limit that needs only `launch` and `non_interactive` support; session resume still needs a `supported` resume capability.
