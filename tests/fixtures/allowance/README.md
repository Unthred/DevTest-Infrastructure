# Allowance fixtures (issue #20)

| File | Origin |
|---|---|
| `claude-2.1.314-rate_limit_event.allowed.json` | **Captured live** from Claude Code 2.1.314, `claude -p ... --output-format stream-json --verbose`, 2026-10-30. Session id replaced. |
| `codex-0.166-token_count.not-reached.json` | **Captured live** from a Codex CLI session rollout, 2026-10-30. Message text is not part of the record. |

Both are the *allowed / not reached* state. **No exhausted-state output has been captured for either CLI.** Exhausted cases in the tests are built in code from these shapes, are labelled SIMULATED, and never set `verified`.
| `codex-0.165.0-interactive-usage-limit.txt` | **Captured live (first real exhausted state)** from the homeowner's interactive Codex CLI 0.165.0, 2026-10-30 ~09:25 UK, passed on by the overseer; email and session id removed. The `codex exec --json` form of this condition is still uncaptured. Resume behaviour is uncaptured. |
