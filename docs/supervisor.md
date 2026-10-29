# Opt-in unattended supervisor (issue #15)

**Implementation state:** first version on `codex/issue-15-supervisor`; installation and independent review are tracked separately in `docs/ai/CURRENT_HANDOVER.md`.

## Contract

`ai-agent` remains role-first and interactive by default. The optional `ai-agent --supervisor ...` path forwards to `ai-supervisor`; no existing tmux session is inspected or modified. Each job specifies a registered provider, repository, dedicated feature worktree, issue number, approved scope, allowed actions, task prompt and optional handover path. The repository and worktree must be distinct roots of the same Git repository. Jobs for different issues can run in parallel in different worktrees. A worktree or issue is exclusively leased until the terminal job is explicitly released.

The registry `supervisor/providers.json` is schema version 1 and points to versioned provider manifests and adapter modules. The manifests follow Claude’s issue #1 provider contract: unknown fields and missing capabilities are rejected, capability values are `supported`, `unsupported` or `unverified`, and `billing.fallback_to_other_billing` must be `false`. Claude and Codex launch and checkpoint successfully, but real limit detection, reset parsing and session resume remain **unverified**. `autoResume: true` is rejected for these production manifests until redacted real output and resume evidence are captured. A future provider can register an adapter and manifest without changing the core. Provider commands are never read from issue or handover content.

Job state and event summaries are stored under `/mnt/cache/ai-supervisor` (mode 0700; job files 0600) with atomic rename/fsync. Raw provider output is processed in memory and discarded. Checkpoints record Git HEAD, up to 80 tracked status lines, a hash of the first 64 KiB of an optional handover, and up to four allowlisted heading labels. Handover body text is not copied. If Git changes while the handover does not, the job is marked stale and a later resume blocks until the handover is updated. The worker checkpoints every 60 seconds and on exit. Each process has an exact PID/start-time claim; stale workers and leases require explicit recovery. `reconcile` can restart an eligible paused job after reset, while a running orphan becomes blocked for inspection. Run `daemon` under an approved persistent host manager to reconcile every minute after a host restart.

For a provider whose capabilities have been verified as supported, a provider-reported verified reset waits until at least two minutes after reset, with a minimum five-minute delay. Long waits are divided into day-sized sleeps and never wake early. An unverified or absent reset gets conservative 1, 2 and 4 hour waits, then blocks. Transient rate limits get bounded minute-scale retries. Context exhaustion starts a fresh session from issue, Git and handover state; network errors and crashes get bounded retries. Authentication failures, approval requests and spend/budget limits block for a human. The worker makes no provider call during a wait. It records a unique attempt ID before each launch. A session ID is reused only when that provider’s resume capability is verified as supported; otherwise the adapter starts fresh with the original approval scope.

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
  "allowed_actions": ["edit", "test", "push_feature_branch"],
  "prompt": "Continue the approved issue. Preserve the handover and stop at review/merge gates.",
  "handover": "docs/ai/CURRENT_HANDOVER.md",
  "autoResume": false
}
```

The `allowed_actions` values are a closed list: `read`, `edit`, `test`, `push_feature_branch`, `create_pr`, `update_issue`, `update_handover`. Run `ai-agent --supervisor dry-run --spec FILE`, then `ai-agent --supervisor start --spec FILE`. Use `status [ID]`, `logs ID`, `pause ID`, `stop ID`, `resume ID`, `auto-resume ID --no-auto-resume`, `reconcile` and `release ID`. `start --foreground` is for supervised testing. `release` only accepts terminal jobs. Never put credentials in the spec. The spec is operator supplied; its scope remains subject to project and role policy.

## Validation and limits

Run `node --test tests/supervisor.test.mjs` and `node tests/real-smoke.mjs WORKTREE`. The latter performs one read-only prompt per installed subscription CLI and summarizes results without exposing provider output. Fake-clock tests cover verified and unverified resets, long waits, transient rate limit, auth, context, approval, network, crash, duplicate job, stale-worker and handover cases. Manifest negatives cover unknown fields, missing capabilities and billing fallback.

Provider usage-limit text and reset formats are based on narrow simulated fixtures; real subscription-limit output has not yet been observed. A provider response that changes format will block or fail safely rather than claim a valid reset. The daemon needs an approved host startup mechanism for reboot recovery. The process is not an independent acceptance authority and cannot grant permission for deployment, purchases or merges.

## Rollback

Stop or pause only supervisor-owned jobs, remove the optional `--supervisor` forwarding block from the backed-up `ai-agent` launcher, and remove the versioned supervisor wrapper/install. Preserve the private state directory and handover for recovery. Existing interactive tmux sessions do not require changes.

## Tower installation

After reviewing the branch and confirming no other launcher edit is in progress, run `bash tools/install-supervisor.sh`. It runs the fake test suite, copies the committed supervisor to `/root/lib/ai-supervisor-<commit>`, backs up `/root/bin/ai-agent`, adds only an explicit `--supervisor` forwarding case, and installs `/root/bin/ai-supervisor`. Verify `bash -n /root/bin/ai-agent`, `/root/bin/ai-agent-tests`, and `ai-agent --supervisor help`. This opt-in path does not start a daemon or touch existing tmux sessions. Roll back the launcher with `bash tools/rollback-supervisor.sh COMMIT` after pausing supervisor-owned jobs; retain state for recovery.

For a reviewed follow-up commit after installation, run `bash tools/upgrade-supervisor.sh`. It keeps the original launcher and existing job state, copies the new committed version, backs up the prior wrapper and switches only the wrapper path. Active workers continue on their originally loaded version; pause them first if adapter behavior must be consistent across a switch.
