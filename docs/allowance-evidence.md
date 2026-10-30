# Allowance evidence and recovery (issue #20)

Status: evidence record. Nothing here marks a provider capability verified. Production manifests still refuse `autoResume`.

## What stopped the sessions (diagnosis, 2026-10-30)
Inspected: Codex session rollouts for 2026-10-30 (event types and rate-limit fields only, no message text), Claude Code transcripts for error/limit entries, `tmux` and process state.
- All four Codex sessions of the day ended with `task_complete`, a normal end of turn. None recorded `rate_limit_reached_type`, an error event or a non-zero exit. At the time they ended the 5-hour window was 9–46% used and the weekly window 35–41% used.
- A fresh Claude Code probe at 07:3x UTC reported `status: allowed`, 5-hour and 7-day utilization 6%.
- No Claude transcript contains an API error or limit entry (searched `isApiErrorMessage`, `error`, system limit text).
- Conclusion: **no local evidence of an allowance exhaustion.** The sessions stopped because an interactive agent finishes its turn and waits for input; the supervisor only manages `exec`/`print` jobs, so an idle tmux session is invisible to it. If a limit hit at another time, no record of it survives locally. This is a **different gap** from limit recovery: unattended progress needs a job that keeps going to the next unblocked issue, not just a limit watcher (tracked as follow-up on #20).

## Structured allowance data that exists today
| Provider | Where | Fields | Observed live |
|---|---|---|---|
| Claude Code 2.1.314 | `rate_limit_event` line in `--output-format stream-json` | `status`, `resetsAt` (epoch s), `rateLimitType`, `overageStatus`, `isUsingOverage`, `unifiedWindows{five_hour,seven_day:{utilization,resetsAt,status}}` | `allowed` only |
| Codex CLI 0.165/0.166 | thread rollout file `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl`, `token_count.rate_limits` (not in `exec --json`) | `primary`/`secondary{used_percent,window_minutes,resets_at}`, `credits`, `plan_type`, `rate_limit_reached_type` | not reached only |

These give provider-reported reset times without parsing prose. `supervisor/allowance.mjs` reads them: Claude from the stream, Codex from the rollout tail after the process exits (message text is never read into state). A failed run whose allowance shows exhaustion becomes `usage_limit` with the reported reset; overage use becomes `approval_required` (never retried). A successful run is never reclassified. Every derived limit is `verified: false`.

## Not known (blocks enabling auto-resume)
1. The exhausted-state values: Claude `status` strings other than `allowed`, Codex `rate_limit_reached_type` values, and the exact exit code/stream shape when a request is refused.
2. Whether `claude --resume <id>` and `codex exec resume <id>` continue the same session after a reset.
3. Whether Codex's in-product credits or model switching act silently when a limit is reached (must remain blocked).

## Live capture plan (no credits burned on purpose)
Codex's 5-hour window was ~46% used at 07:18 UTC and resets at **11:44 UTC**; the weekly window resets 2026-11-04 07:18 UTC. When a real limit occurs on any supervised or interactive run: read the last `token_count.rate_limits` record from that thread's rollout (fields above, no text) and the final stream lines, redact, and add them to `tests/fixtures/allowance/` with the CLI version. Only then change that capability to `supported` in a reviewed PR. Do not force a limit.

## Operator recovery
- `ai-agent --supervisor status [ID]`, `logs ID` (event log), `status ID` now includes the last `allowance`.
- A `blocked` job with `usage_limit` and no reset: re-check after the earliest window reset, then `resume ID`.
- `approval_required` after overage: a human decides; the supervisor never spends.
- Stale lease or worker: `recover`/`release` per `docs/supervisor.md`.
