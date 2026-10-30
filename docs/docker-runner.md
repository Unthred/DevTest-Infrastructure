# Docker foundation (issue #2)

This module is the trusted host-side container boundary for future `dev-test` commands. It does not expose a new end-user launcher. Build and browser commands will enter through the single `dev-test` CLI in issue #8. The [runner example](../docker/runner.example.json) shows the trusted configuration shape; [Compose](../docker/compose.example.yaml) documents equivalent hardening without becoming a separate run path.

## Image and storage policy

[`images.lock.json`](../docker/images.lock.json) records official MCR image tags, immutable RepoDigests and the 2026-10-30 Tower inspection date. This is a local observation, not a claim that the tags are current upstream. The runner accepts only these exact repositories and 64-character lowercase SHA-256 digests. It uses `--pull=never`; a missing digest is a reported environment precondition, never an implicit download or tag fallback. Image updates belong to issue #12.

The trusted host caller provides an exact allowlist of real project roots under `/mnt/user/projects`, a storage root under `/mnt/cache`, a non-root UID/GID and bounded CPU, memory, PID, shared-memory and wall-time limits. The source tree mounts read-only at `/src`. Only a unique run workspace (`/work`, `/out`) and a cache directory under the cache pool are writable. The caller must select a command preset or otherwise validate arguments so no secret value is put in a command line; the runner rejects control characters and never passes the host environment into the container. Network access is `none` in this foundation. Later restore/browser phases need a separately reviewed policy.

Each run uses a unique name and run-id label, drops every Linux capability, denies privilege gain, makes the root filesystem read-only and uses an explicit tmpfs. The host runner starts Docker without a shell. On success, subject failure, timeout or interruption it verifies container ownership by label and removes only its own leftover container. An unverifiable Docker daemon or foreign name collision reports incomplete cleanup; it never removes another container. Run workspaces remain under the cache pool for later evidence handling; the smoke removes its own fixture workspace.

## Validation

Run `node tools/validate-project.mjs` and `node --test 'tests/**/*.test.mjs'`. The Docker tests cover malformed digests, foreign images, exact allowlists, unsafe paths/IDs/limits/network/argv, hardening flags, foreign-container refusal, success, subject failure, timeout and incomplete cleanup. On Tower, `node tests/docker-smoke.mjs` runs positive and failing-subject probes through the local pinned .NET SDK image with no network, checks the positive marker, then verifies neither test container remains. It touches only generated cache-pool run workspaces and does not alter a production service. Keep the command result and image digest on issue #2; do not treat a simulated unit test as a real Docker smoke.

## Limits

The runner has no OpenBao access because this foundation does not need credentials. Issue #7 designs scoped secret delivery. Issue #8 wires the single CLI and result contract. A host reboot, production application mutation, or new image pull is outside this smoke.
