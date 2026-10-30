# Allowance fixtures (issue #20)

| File | Origin |
|---|---|
| `claude-2.1.314-rate_limit_event.allowed.json` | **Captured live** from Claude Code 2.1.314, `claude -p ... --output-format stream-json --verbose`, 2026-10-30. Session id replaced. |
| `codex-0.166-token_count.not-reached.json` | **Captured live** from a Codex CLI session rollout, 2026-10-30. Message text is not part of the record. |

Both are the *allowed / not reached* state. **No exhausted-state output has been captured for either CLI.** Exhausted cases in the tests are built in code from these shapes, are labelled SIMULATED, and never set `verified`.
