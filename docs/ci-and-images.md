# CI, image provenance, updates and caching (issue #12)

Implements the policy for D-004 (official images, immutable digests) and D-005 (cache pool, reused layers). Code: `tools/ci/check-ci.mjs`, tests: `tests/check-ci.test.mjs`, workflows: `.github/workflows/`.

## Where each check runs (answers OQ-3, proposal)

| Check | Hosted GitHub runner | Tower only |
|---|---|---|
| `node tools/validate-project.mjs`, `node --test "tests/**/*.test.mjs"` (fixtures, fakes, unit tests) | yes (`project-contract`) | also |
| `node tools/ci/check-ci.mjs` (shell syntax, workflow safety, image lock) | yes (`ci-lint`) | also |
| Image digest freshness (`--max-age-days 45`) | weekly schedule, not a merge gate (`image-freshness.yml`) | also |
| Docker smokes (`tests/docker-smoke.mjs`, `browser-smoke.mjs`, `dotnet-smoke.mjs`, `broker-smoke.mjs`) | **no** | yes, run by hand or the supervisor, low priority (`ionice -c 3 nice -n 19`) |

Hosted CI never runs Docker, never uses a self-hosted runner (Tower stays out of GitHub-triggered execution), holds no secret and has `contents: read` only. A Docker-dependent claim therefore needs Tower evidence (command, exit code, image digest) in the issue; a green hosted run proves only the fixtures. This follows D-007 and the completion states in `acceptance-gates.md`. OQ-3 stays open until the homeowner confirms this split; D-028 (agent-proposal) records it and the Dependabot/Renovate stance for approval.

Not covered yet: executable pruning of image layers and the NuGet/Playwright caches (issue #12's "cache pruning" is documentation plus the existing run pruning only). A tested prune tool needs its own issue.

## What `check-ci` enforces (positive and negative tests exist for every rule)
- **Shell:** every `*.sh`/`*.bash` file and every file with a `sh`/`bash` shebang (including `env -S bash`) passes `bash -n` and has a shebang. (No ShellCheck: it is not installed on Tower and would add a download to CI.)
- **Workflows:** top-level `permissions:` with no `<scope>: write` of any kind (or `write-all`); `timeout-minutes` on every job under `jobs:`; no `pull_request_target`, no `self-hosted`, no `secrets.*`; `github.token` only as a `GH_TOKEN`/`GITHUB_TOKEN` env value, never inline; no docker/podman/nerdctl command (a best-effort text match, not a parser: it cannot see a command built indirectly, so review still matters); every `uses:` pinned to a 40-hex commit SHA, except official `actions/*` major tags (a recorded exception, because GitHub owns the namespace).
- **Image lock (`docker/images.lock.json`):** schema version, dates, every `reference` is `registry/repo@sha256:<64 hex>` on an allow-listed official registry (`mcr.microsoft.com`), the tag is explicit and not `latest`, tag and reference name the same repository, no duplicate digests, `playwright-core` equals the version in the Playwright image tag and has an sha512 integrity, and any digest used elsewhere in code or config appears in the lock.
- **Freshness** only with `--max-age-days N`, so a pull request never fails because the calendar moved (reproducibility). `--now` makes it deterministic for tests.

## Pin and version strategy
- Tags are resolved to digests once, recorded in the lock with tag and date, and never trusted afterwards. Floating tags (`latest`, `8`) are rejected.
- Compatible versions travel together: the Playwright npm package, the Playwright image tag and the browsers inside the image share one version. Update all three in one change; `check-ci` fails on a mismatch. The three .NET SDK majors (8, 9, 10) are tracked independently.
- Code never embeds a digest that the lock does not list.

## Update cadence
- Security-relevant base-image updates: re-resolve the digests at least every **45 days** and sooner for a published vulnerability in the pinned image or browsers. The weekly workflow fails (and so notifies) when a digest is older than 45 days; the lock was resolved on 2026-10-30, so the first failure is expected about 2026-12-14. That failing run is the reminder: it is handled as a normal re-pin issue (opened by the homeowner or Foreman's Needs you list), not by an agent acting unprompted.
- An update is a normal pull request: new digest and date in the lock, the Playwright triple together, then the Tower smokes against the new digest, with the digest and results in the PR. No unattended updates and no automatic merge.
- **Dependabot/Renovate are not enabled.** They would open pull requests from a bot identity outside the agent workflow and cannot resolve the MCR digests this project needs. If wanted later, a new dated decision must approve it with a scope (for example the `github-actions` ecosystem only).
- Vulnerability review: before re-pinning, compare the registry's published image advisories for the candidate tag. This is a manual step; no scanner or network call is added to CI.

## Cache and workspace pruning
- Run workspaces: `pruneRuns` keeps the newest `keep` runs (default 20) and removes older ones; evidence is stored separately and is not touched (`docs/dotnet-testing.md`, D-006).
- Run volumes and the restore cache: the runner's start-up sweep releases only stale DevTest loop volumes (`docs/docker-runner.md`).
- Image layers: superseded pinned images are removed by hand once their replacement has passed its smoke, using `docker image rm <old digest reference>` on the host (never `docker system prune`, which would delete other services' images). Keep the previous digest until then so a rollback is possible.
- NuGet and Playwright package caches grow only on an explicit restore phase; purge a per-SDK cache directory under `/mnt/cache/appdata/devtest-infrastructure/cache/` only when no run is active.
- Evidence retention period is still OQ-4.

## Reproducibility
Same lock, same commit, same command gives the same image digests and the same fixture results. Hosted CI uses pinned Node 22 and pinned actions; the only moving parts are `ubuntu-latest` and Node's minor version, which affect fixtures, not images.

## Security review checklist (recorded for this issue)
- No test container mounts the Docker socket or runs privileged (validator rule, D-007); no secret reaches a container's environment or argv (D-008, D-022).
- CI has no secret, no write token and no self-hosted runner; third-party actions need a commit SHA.
- Review findings and Tower evidence are recorded on the pull request, not in the handover (D-023).
