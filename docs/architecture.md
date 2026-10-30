# Architecture

Status: source design for issue #1. Decisions it relies on are in [DECISIONS.md](DECISIONS.md) (`D-nnn`). Nothing here is deployed.

## Purpose
Give agents and humans one reliable way to build and test .NET code and to render and inspect web UIs on Tower, without persistent toolchains, without exposing the host, and with evidence that survives the run.

## Shape

```
agent / human
      |  (only entry point, D-001)
   dev-test CLI  ------------------------------+
      |                                        |
 policy gate (refuses before anything starts)  |  doctor / report / cleanup
      |                                        |
 trusted host-side runner  <-- OpenBao (scoped, read-only, D-008)
      |   starts, limits, observes, removes
      +--> Track A container: official .NET SDK 8/9/10 (pinned digest)
      +--> Track B container: official Playwright image (pinned digest)
      |
 /mnt/cache/appdata/devtest-infrastructure/{cache,runs,evidence,state}   (D-005, D-006)
```

The **supervisor** for unattended agents (issue #15) is a separate component. It launches agents; it does not run builds. Agents inside it call `dev-test` like anyone else.

The host-side Docker foundation for issue #2 is implemented in [`docker/runner.mjs`](../docker/runner.mjs) with an immutable [image lock](../docker/images.lock.json). It is a module for the future `dev-test` CLI, not a second command surface. See [docker-runner.md](docker-runner.md) for its current limits and Tower smoke evidence.

## Tracks (D-002)
| | Track A: .NET | Track B: Browser |
|---|---|---|
| Image | official `mcr.microsoft.com/dotnet/sdk` 8, 9, 10 | official Playwright image |
| Pinning | digest recorded in the lock file (D-004) | digest recorded in the lock file |
| Network | restore: package sources only; build/test: none (D-016) | declared targets only (OQ-2) |
| Output | build log, TRX, coverage | screenshots per profile, DOM/console report |
| Depends on the other track | no | no (no .NET runtime) |

## Runner responsibilities
1. Validate the request against policy; refuse with exit code 4 before starting anything.
2. Create `runs/<run-id>/{src,work,out}`. Source is mounted read-only; the container writes only to `work` and `out` (separate per run, never a shared mutable tree).
3. Start the container with the hardening baseline (D-015), a unique name carrying the run id, resource and time limits.
4. Consume bounded stdout/stderr without persisting raw subject output; Docker logging is disabled. Never put secrets in arguments, logs or exported artifacts (D-008).
5. Always stop and remove the container, on success, failure, timeout and interrupt (D-003). Report leftovers as exit code 7.
6. Move artifacts to `evidence/<run-id>` with checksums and write the JSON result.

## Security model
- Trust boundary: the runner is trusted; everything in a container (project code, test code, a browsed page) is not.
- No Docker socket, no privileged mode, no host network, no host paths other than the per-run directories (D-007).
- Credentials are short-lived and scoped, delivered by a mechanism chosen in #7; they are redacted from every artifact before evidence is stored.
- Production systems are reached read-only and only when a run declares the target and its approval (D-009).
- The project never reboots infrastructure (D-010).

## Concurrency and ownership (D-011, D-018)
Two agents work at once on different issues in different worktrees. Runs are independent: every run has its own id, directory and container, so parallel `dev-test` invocations cannot share mutable state. The shared caches are append-only and keyed by content.

## Failure semantics
The CLI distinguishes a failing subject (exit 1) from refused (4), missing environment (3), timeout (5), internal (6) and incomplete cleanup (7). See [cli-contract.md](cli-contract.md). An unattended agent must treat 3, 4 and 6 as "do not trust, report", never as a test failure or success.

## What is not decided here
Secret delivery (OQ-1), browser egress enforcement (OQ-2), where Docker-dependent CI runs (OQ-3) and evidence retention (OQ-4). Each is owned by a later issue and recorded in the register.

## Reuse
Other projects (for example Blazor apps) consume the CLI and contracts; they do not copy tooling. The first reference consumer is issue #11.
