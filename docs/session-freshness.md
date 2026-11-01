# Fresh context per job (issue #74)

Every turn re-sends the whole context, and the provider's prompt cache expires after about an hour idle. `supervisor/session.mjs` therefore decides, before each provider launch, whether to resume the provider session or start a fresh one. It applies to every adapter (Claude, Codex, future ones) because the decision is made in `runProcess`.

- **New job:** the first attempt always starts a fresh session. A job record never inherits a session id.
- **Later attempt of the same job** (auto-resume, retry, limit pause, restart): resume only if the session was active within 55 minutes and its last context was at most 150,000 tokens. Otherwise the stored session id is dropped and a fresh session starts, with the prompt seeded from the job's handover file (first 6,000 characters, plus the last checkpoint HEAD) and the job prompt.
- **Configuration:** per-job spec fields `sessionMaxContextTokens` and `sessionResumeWindowMs`. The window can be shortened, never extended past 55 minutes.
- **Record per job** (`job.sessions`, shown by `status`): `started`, `resumes`, `freshRestarts`, `tokensRecached`, `contextTokens`, `lastActiveAt`, `lastDecision`. `tokensRecached` is Claude's `cache_creation_input_tokens`, or Codex's uncached input (`input_tokens - cached_input_tokens`). The dashboard (#72) can read these fields; no dashboard change is made here.

Limits: context size is the input of the provider's last reported usage line, an approximation. A context-limit event still clears the session as before.
