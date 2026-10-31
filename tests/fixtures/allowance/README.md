# Allowance fixtures (issue #20)

| File | Origin |
|---|---|
| `claude-2.1.314-rate_limit_event.allowed.json` | **Captured live** from Claude Code 2.1.314, `claude -p ... --output-format stream-json --verbose`, 2026-10-30. Session id replaced. |
| `codex-0.166-token_count.not-reached.json` | **Captured live** from a Codex CLI session rollout, 2026-10-30. Message text is not part of the record. |

Both are the *allowed / not reached* state. **No exhausted-state output has been captured for either CLI.** Exhausted cases in the tests are built in code from these shapes, are labelled SIMULATED, and never set `verified`.
| `codex-0.165.0-interactive-usage-limit.txt` | **Captured live (first real exhausted state)** from the homeowner's interactive Codex CLI 0.165.0, 2026-10-30 ~09:25 UK, passed on by the overseer; email and session id removed. The `codex exec --json` form of this condition is still uncaptured. Resume behaviour is uncaptured. |
| `claude-2.1.314-stream-tool_result.shape.json` | **Redacted shape of the misread event (issue #33).** A stream-json `user`/`tool_result` line whose content merely *quotes* usage-limit wording (an agent reading this project's handover). The supervisor persists no raw output, so the incident's real 45,788-character line is not available; the shape and the two over-long lines were established from the job's own Claude session transcript, and the text here is a short stand-in. Tests pad `content` past 16 KiB so the supervisor's cut produces the same unparseable fragment. |
