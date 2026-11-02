# Blazor end-to-end demonstration and cross-project reuse (issue #11)

`tools/blazor-demo.mjs` drives one sample through the single `dev-test` CLI (D-001) and checks the outcome. It starts no container itself, mounts no Docker socket and publishes no port (D-007, D-016).

```
node tools/blazor-demo.mjs [--project-root <dir>] [--sdk 8|9|10] [--require-tests] [--no-docker-check] [--run-dir <dir>] [--cli <path>]
```
Human text goes to stderr; stdout is one JSON object (`ok`, `steps`, `artifacts`). Exit 0 only if every step passed, 1 otherwise, 2 for a usage error.

## What it does
1. `dev-test dotnet build` of the Razor component library `tests/fixtures/dotnet/Blazor` in the pinned SDK image.
2. `dev-test dotnet test` of `tests/fixtures/dotnet/Tests`. **Blocked today**: xunit and the test SDK are not in any offline NuGet cache ([dotnet-testing.md](dotnet-testing.md)). The step is recorded as `blocked`, never `passed`; `--require-tests` turns it into a failure. Only that offline-restore case (exit 1, status failed, no test summary, cleanup complete) is `blocked`; real test failures, exit 3/4/6/7 and incomplete cleanup fail the demo.
3. `dev-test web screenshot` of the sample page (`tests/fixtures/blazor-demo/wwwroot`) at the `desktop` and `phone` profiles, and `dev-test web responsive` at the 8 standard profiles.
4. Negative cases: the defective `browser/fixture/broken.html` must fail as a subject failure (exit 1), and an `http://` URL must be refused with exit 4.
5. Stable artifacts: every run has its own evidence directory `<run-dir>/<UTC timestamp>-<run-id>/` (default `<storageRoot>/evidence`) holding `result.json` and `artifacts/` with hashes; the demo checks each artifact exists with a matching shape and that run directories are distinct.
6. Nothing left running: container and loop-device counts are compared before and after.

## What this does not prove (read before reporting "working")
- The sample page is a **static stand-in** for the compiled component, not a running Blazor app. A real Blazor Server or WebAssembly app needs either a published site served as static files (WebAssembly publish needs packages that are not cached offline) or a TCP listener the browser can reach, which is blocked on OQ-2 (any firewall or network-namespace change needs fresh homeowner approval). The demo therefore does not claim a running Blazor app was driven.
- The build step proves the component compiles in the pinned SDK; the test step is blocked as above.
- Implemented and unit-tested here; a real Tower run, if any, is reported separately in the PR as *verified*, never inferred from CI.

## Applying the runner to Surveyor and BuildMonitor
No path to another project is embedded in this repository, and those repositories are not modified. Per project, the homeowner or operator:
1. Adds the project's directory to `allowedProjects` in the machine-local runner configuration named by `DEV_TEST_CONFIG` (default `/mnt/cache/appdata/devtest-infrastructure/state/runner.json`, shape in `docker/runner.example.json`). Directories outside the list are refused with exit 4.
2. Builds and tests with `dev-test dotnet build|test --sdk <8|9|10> --project <path-to-project-or-solution>`. Evidence lands in the same stable run directories; nothing is written into the project (it is mounted read-only).
3. For UI checks, publishes or renders the pages to static files (inside the project's own pipeline or by hand), then runs `dev-test web screenshot|responsive --url file://<page> --root <site-root>`. The dev-test repository itself must also be in `allowedProjects` because the browser scripts run from its read-only mount.
4. Needs from the project: a restorable offline package set for tests (see [dotnet-testing.md](dotnet-testing.md)) and, for live servers, an approved network target (OQ-2). Until then a project with only compile checks or static pages is supported; one needing a live server is not.
Use `tools/blazor-demo.mjs --project-root <dir>` only for the bundled sample; it resolves the sample relative to that root.

## Real Tower run (2026-11-02, isolated storage root, removed afterwards)
`dev-test dotnet build --sdk 8` of the Blazor library: **exit 0, build succeeded**. `dotnet test`: exit 1, blocked as described (recorded `blocked`). The browser steps (screenshots, responsive, broken-page negative) were **not** run for real: the Playwright cache had not been prepared on this host (`node browser/prepare-cache.mjs` needs the network and was not run), so they exited 3 (environment). The negative `http://` refusal (exit 4) ran for real and passed; no container or loop device was left behind. The browser half is therefore implemented and unit-tested only, not verified against real Docker.

## Evidence
`node --test tests/blazor-demo.test.mjs` drives every branch with a fake CLI: all-pass, tests blocked vs required, build failure, a broken page that passes, an unrefused network URL, a failed screenshot, a missing artifact file and a leftover container.
