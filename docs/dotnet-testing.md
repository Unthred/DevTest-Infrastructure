# .NET testing, coverage and artifacts (issue #4)

`dotnet/testing.mjs` (`runDotnetTests`) runs `dotnet test` through the trusted runner for SDK 8, 9 or 10 (xUnit, NUnit and MSTest all work, because they are driven by `dotnet test`; the test project selects its own target framework, e.g. `net8.0`/`net9.0`/`net10.0`, validated by `--framework`). There is still no second CLI; `dev-test dotnet test` (issue #8) will call this module.

## Arguments
Only fixed flags reach `dotnet`, all as separate argv entries (no shell): `--results-directory /out/results`, `--logger trx;LogFileName=results.trx`, optional `--collect "XPlat Code Coverage"` (`coverage: true`) and an optional `--filter` limited to `[A-Za-z0-9_.()=!~&|<>,:* -]`, 256 characters. Anything else (including `coverage`/`filter` on build/restore) is refused.

## Artifacts
Each run gets a new directory `<runsRoot>/<UTC timestamp>-<run id>` (`20261031T120000Z-<id>`); an existing directory is never reused. It holds `result.json` (cli.v1 result fields plus `summary`) and `artifacts/`: `results.trx`, `results.junit.xml` (converted from the TRX, so no extra logger package is needed) and `coverage.cobertura.xml`, each recorded with `kind`, `path`, `sha256`, `bytes`. Files over 64 MiB are skipped and symlinks in the run volume are never followed. Raw container output is not persisted (the runner discards it because it can contain credentials); failure messages come from the TRX and are capped at 500 characters. Redaction is not applied to TRX content.

## Exit codes and summary
0 passed; 1 subject failed (failing tests, a build failure, no tests discovered, no TRX produced, or coverage requested but absent); 5 timeout; 6 runner fault; 7 cleanup incomplete; 130 interrupted. `summary` lists totals, up to 20 failing test names with messages, the line-coverage percentage and an actionable `message`.

## Retention
After each run `pruneRuns` keeps the newest `keep` (default 20) timestamped directories and removes older ones. It only removes real directories matching the run-name pattern, never symlinks or other entries, and never the current run. Evidence retention policy beyond this count is open question OQ-4.

## Fixture and limits
`tests/fixtures/dotnet` has a minimal API (`Api`), a Razor component library (`Blazor`), a passing xUnit project (`Tests`) and a deliberately failing one (`FailingTests`); `FixtureTfm` selects net8.0/net9.0/net10.0. Containers have no network, so `xunit`, `Microsoft.NET.Test.Sdk` and `coverlet.collector` must already be in the SDK's NuGet cache (restore from a local feed, see `docs/dotnet-builds.md`). Coverage needs `coverlet.collector` in the test project.
Verification status: unit tests drive the real argv/mount planner with a fake container runner. A real Docker test run on Tower is **not** done: the packages above are not in any offline cache and cannot be fetched without a network phase.
