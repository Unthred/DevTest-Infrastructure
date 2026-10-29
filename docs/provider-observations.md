# Provider observations

Evidence for the adapter fixtures required by [agent-provider-contract.md](agent-provider-contract.md) (correction 7). **Method: static inspection of the installed CLI binaries and `--help` output on Tower, 2026-10-29.** This shows which messages and flags exist. It is **not** a captured live run, so every capability below stays `unverified` until a real capture is stored as a fixture with the CLI version.

| CLI | Version inspected |
|---|---|
| Claude Code | 2.1.312 |
| Codex CLI | 0.165.0 |

## Claude Code 2.1.312
- Session flags: `-c/--continue` (most recent conversation), `-r/--resume [id]`, `--session-id <uuid>`, `-p/--print`, `--output-format` (`stream-json` with `--print`).
- Distinct message families exist for: `Usage limit reached`, a countdown form (`... resets in ...`), a 5-hour limit, a group usage limit, a spend/budget limit (`Budget limit reached`, `spend limit reached`), and generic rate limiting. Spend and budget limits are different from the subscription usage limit and must not be treated as resumable by waiting.
- Claude Code can itself wait in-session for a usage-limit reset. It states that if the session moves to the background or Claude Code is relaunched during that wait, "the task will not resume on its own when the usage limit resets (send a prompt then to continue)". A supervisor must therefore not assume the agent resumes itself, and must not send a prompt before the reset.
- Internally a billing error is reported as blocked ("usage limit reached — check plan") and a rate limit as blocked. These are different from a context limit.

## Codex CLI 0.165.0
- Session flags: `codex resume [SESSION_ID] [PROMPT]` and `--last`; named profiles with `--profile`.
- Usage-limit messages exist in at least two wordings (for example "Usage limit reached. You've reached your usage limit. Increase your limits to continue using codex." and an upgrade variant). Windows named in the binary include daily, monthly and annual limits, so a reset time can be far away.
- A short retry hint is parsed by pattern `try again in <number> s|ms|seconds`. That is a transient rate-limit delay, not a subscription reset time, and must map to `transient_rate_limit`.
- **Safety-relevant features that the supervisor must never trigger or silently accept:**
  - an in-product action to reset current usage limits ("Reset your current usage limits", "usage limit resets"), which may consume a user entitlement or cost;
  - automatic model switching "due to usage limits" and switching back when ordinary usage returns.
  An adapter reports a model switch as a visible event and never invokes a reset action. This follows the no-silent-billing rule (D-012).

## What still has to be captured
1. The exact text and reset timestamp (or countdown) of a real subscription usage-limit stop for each CLI, including the time zone and whether it is absolute or relative.
2. The exit status and stream (`stdout`/`stderr`/structured) on which each CLI reports it in non-interactive mode.
3. Whether resume by id restores context after a limit stop and after a crash.
4. The wording of an approval request, an auth failure and a network failure.
Each capture is stored with the CLI version and a redacted transcript. Adapters parse only what was captured; anything else is reported as `unverified`, never guessed.

## Consequences for the contract
- `usage_limit_detection` and `reset_time_parsing` stay `unverified` in the example manifests.
- The supervisor treats spend/budget limits as `blocked` (needs a human), not `paused_limit`.
- The supervisor must not send input to an agent that is in its own in-session wait before the verified reset time.
