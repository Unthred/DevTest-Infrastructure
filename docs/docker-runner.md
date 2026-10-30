# Docker foundation (issue #2)

This module is the trusted host-side container boundary for future `dev-test` commands. It does not expose a new end-user launcher. Build and browser commands will enter through the single `dev-test` CLI in issue #8. The [runner example](../docker/runner.example.json) shows the trusted configuration shape; [Compose](../docker/compose.example.yaml) documents equivalent hardening without becoming a separate run path.

## Image and storage policy

[`images.lock.json`](../docker/images.lock.json) records official MCR image tags, immutable RepoDigests and the 2026-10-30 Tower inspection date. This is a local observation, not a claim that the tags are current upstream. The runner accepts only these exact repositories and 64-character lowercase SHA-256 digests. It uses `--pull=never`; a missing digest is a reported environment precondition, never an implicit download or tag fallback. Image updates belong to issue #12.

The trusted host caller provides an exact allowlist of real project roots under `/mnt/user/projects`, a storage root under `/mnt/cache`, a non-root UID/GID and bounded CPU, memory, PID, shared-memory and wall-time limits. The source tree mounts read-only at `/src`. Only a unique run workspace (`/work`, `/out`) and a cache directory under the cache pool are writable. The caller must select a command preset or otherwise validate arguments so no secret value is put in a command line; the runner rejects control characters and never passes the host environment into the container. Network access is `none` in this foundation. Later restore/browser phases need a separately reviewed policy.

Each run uses a unique name and run-id label, drops every Linux capability, denies privilege gain, makes the root filesystem read-only and uses an explicit tmpfs. The host runner starts Docker without a shell. On success, subject failure, timeout or interruption it verifies container ownership by label and removes only its own leftover container. An unverifiable Docker daemon or foreign name collision reports incomplete cleanup; it never removes another container. Run workspaces remain under the cache pool for later evidence handling; the smoke removes its own fixture workspace.
Before starting, the runner refuses any pre-existing container with the generated name, even if it carries the same run label. A reused run id cannot take over a container from a previous attempt.

The Docker CLI subprocess gets only `PATH`, `HOME` and, for a rootless daemon, an owner-only `XDG_RUNTIME_DIR` with its matching Unix `DOCKER_HOST` socket. TCP Docker endpoints and other host environment values are refused or omitted. The container receives no host environment values.

## Validation

Run `node tools/validate-project.mjs` and `node --test 'tests/**/*.test.mjs'`. The Docker tests cover malformed digests, foreign images, exact allowlists, unsafe paths/IDs/limits/network/argv, hardening flags, foreign-container refusal, success, subject failure, timeout and incomplete cleanup. On Tower, `node tests/docker-smoke.mjs` runs positive and failing-subject probes through the local pinned .NET SDK image with no network, checks the positive marker, then verifies neither test container remains. It touches only generated cache-pool run workspaces and does not alter a production service. Keep the command result and image digest on issue #2; do not treat a simulated unit test as a real Docker smoke.

## Limits

The runner has no OpenBao access because this foundation does not need credentials. Issue #7 designs scoped secret delivery. Issue #8 wires the single CLI and result contract. A host reboot, production application mutation, or new image pull is outside this smoke.

## Review corrections (Claude, PR #19 review)
- **Disk budget (`diskMb`, `cacheMb`).** Bind mounts cannot carry a size limit. `--ulimit fsize` caps any single file at the budget (observed live: a 300 MB write stopped at 64 MB), and the runner measures allocated bytes under `/work`+`/out` and `/cache` every 200 ms without following symlinks, killing the container by name when over budget (`reason: disk_limit` or `cache_limit`, exit 1). This is a **soft** bound: overshoot is roughly write rate times the poll interval (observed 211 MB against a 64 MB budget with a tight 1 MiB write loop). A hard bound needs a filesystem quota on the run directory, which is a host change not made here.
- **Exit mapping.** The container is not started with `--rm`; its exit code and OOM flag are read before removal. Subject outcomes (127, 126, 137, OOM) are exit 1 with a `reason`; only a Docker failure with no container state is exit 6.
- **Logs.** Container stdout/stderr are written to `runs/<id>/logs/{stdout,stderr}.log`, each capped at 1 MiB, mode 0600, outside the container-writable mounts. They may contain whatever the subject prints; issue #7's secret scan must cover them.
- **Swap and init.** `--memory-swap` equals `--memory` and `--init` is set. On this Tower the kernel reports "does not support swap limit capabilities", so the swap flag is requested but **not enforced here**.
- **Project mount.** The whole project directory is readable by the subject, including untracked files such as `.env`. `--network=none` limits exfiltration to what is written under `/out`. Prefer a tracked-files export for projects holding local secrets.
- **Left-over containers.** Without `--rm`, a runner killed with SIGKILL leaves a stopped container labelled `devtest.run-id`; a sweeper belongs with issue #8.
