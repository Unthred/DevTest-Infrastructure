# Opt-in unattended supervisor (issue #15)

**Implementation state:** first version on `codex/issue-15-supervisor`; installation and independent review are tracked separately in `docs/ai/CURRENT_HANDOVER.md`.

## Contract

`ai-agent` remains role-first and interactive by default. The optional `ai-agent --supervisor ...` path forwards to `ai-supervisor`; no existing tmux session is inspected or modified. Each job specifies a registered provider, repository, dedicated feature worktree, issue number, approved scope, allowed actions, task prompt and optional handover path. The repository and worktree must be distinct roots of the same Git repository. Jobs for different issues can run in parallel in different worktrees. A worktree or issue is exclusively leased until the terminal job is explicitly released.

The registry `supervisor/providers.json` is schema version 1. A provider entry names a command and a module in `supervisor/adapters/`. The adapter supplies command construction, output classification, subscription preflight and capabilities. Claude and Codex currently support session resume and narrow usage-reset detection. A future provider may use the base adapter to launch, checkpoint and report status, but its `usageReset` capability is false and automatic reset handling is unavailable. Provider commands are not read from issue content.

Job state and event summaries are stored under `/mnt/cache/ai-supervisor` (mode 0700; job files 0600) with atomic rename/fsync. Raw provider output is processed in memory and discarded. Checkpoints record Git HEAD, up to 80 tracked status lines, and a hash of the first 64 KiB of an optional handover. They do not copy file contents. The worker checkpoints every 60 seconds and on exit. Each process has an exact PID/start-time claim; stale workers and leases require explicit recovery. `reconcile` can restart an eligible paused job after reset, while a running orphan becomes blocked for inspection. Run `daemon` under an approved persistent host manager to reconcile every minute after a host restart.

A verified usage-limit response with a reset timestamp waits until at least two minutes after reset, with a minimum five-minute delay. Without a timestamp, retries use 1, 2 and 4 hour waits, then block. Transient rate limits use 1, 2 and 4 minute waits. Context exhaustion, auth failure and approval requests block immediately; network errors and crashes fail for inspection. The worker makes no provider call during a wait. Resume reuses the session ID if captured, and always instructs the agent to reread the same issue, Git state and handover. Without a captured ID, the adapter starts a fresh session from those durable sources.

Claude and Codex launch only when their local CLI reports subscription login. API-key environment variables are removed from child environments. This avoids silent API-key fallback; it does not guarantee the provider will never change its CLI behavior. Authentication material stays in the existing CLI secure storage. No OpenBao secret is needed for these subscription sessions; future credentials should use a scoped OpenBao identity and must not be added to job specs, logs or the registry.

## Job spec and commands

Create a private JSON file outside Git:

```json
{
  "role": "devtest",
  "provider": "codex",
  "repository": "/mnt/user/projects/DevTest-Infrastructure",
  "worktree": "/mnt/user/projects/DevTest-Infrastructure-codex-15",
  "issue": 15,
  "scope": "Implement issue #15 on the feature branch",
  "allowedActions": ["edit", "test", "push feature branch"],
  "prompt": "Continue the approved issue. Preserve the handover and stop at review/merge gates.",
  "handover": "docs/ai/CURRENT_HANDOVER.md",
  "autoResume": true
}
```

Run `ai-agent --supervisor dry-run --spec FILE`, then `ai-agent --supervisor start --spec FILE`. Use `status [ID]`, `logs ID`, `pause ID`, `stop ID`, `resume ID`, `auto-resume ID --no-auto-resume`, `reconcile` and `release ID`. `start --foreground` is for supervised testing. `release` only accepts terminal jobs. Never put credentials in the spec. The spec is operator supplied; its scope remains subject to project and role policy.

## Validation and limits

Run `node --test tests/supervisor.test.mjs` and `node tests/real-smoke.mjs WORKTREE`. The latter performs one read-only prompt per installed subscription CLI and summarizes results without exposing provider output. Fake-clock tests cover explicit reset, unknown reset, transient rate limit, auth, context, approval, network, crash, duplicate job and stale-worker cases.

Provider usage-limit text and reset formats are based on narrow simulated fixtures; real subscription-limit output has not yet been observed. A provider response that changes format will block or fail safely rather than claim a valid reset. The daemon needs an approved host startup mechanism for reboot recovery. The process is not an independent acceptance authority and cannot grant permission for deployment, purchases or merges.

## Rollback

Stop or pause only supervisor-owned jobs, remove the optional `--supervisor` forwarding block from the backed-up `ai-agent` launcher, and remove the versioned supervisor wrapper/install. Preserve the private state directory and handover for recovery. Existing interactive tmux sessions do not require changes.

## Tower installation

After reviewing the branch and confirming no other launcher edit is in progress, run `bash tools/install-supervisor.sh`. It runs the fake test suite, copies the committed supervisor to `/root/lib/ai-supervisor-<commit>`, backs up `/root/bin/ai-agent`, adds only an explicit `--supervisor` forwarding case, and installs `/root/bin/ai-supervisor`. Verify `bash -n /root/bin/ai-agent`, `/root/bin/ai-agent-tests`, and `ai-agent --supervisor help`. This opt-in path does not start a daemon or touch existing tmux sessions. Roll back the launcher with `bash tools/rollback-supervisor.sh COMMIT` after pausing supervisor-owned jobs; retain state for recovery.
