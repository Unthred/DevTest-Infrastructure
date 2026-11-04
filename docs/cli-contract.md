# `dev-test` CLI contract (v1)

Status: `agent-proposal` (D-017), implemented in source by issue #8 (`cli/`, `bin/dev-test`); see [Implementation](#implementation). The machine-readable form is [`contracts/cli.v1.json`](../contracts/cli.v1.json); the validator checks that this page and that file agree.

## Commands
| Command | Purpose |
|---|---|
| `dev-test version` | Print CLI and contract versions. |
| `dev-test help [command]` | Usage. |
| `dev-test doctor` | Read-only check of Docker, pinned images, cache and run directories, OpenBao reachability and policy state. For #8: `doctor` uses `checkHealth` from `broker/openbao.mjs` (no credential), and a run with secrets goes through `withSecrets` in `broker/broker.mjs` (see [secrets.md](secrets.md)); the run spec gains `secrets: [names]`. |
| `dev-test dotnet build --sdk <8\|9\|10> --project <path>` | Build in a pinned SDK container. |
| `dev-test dotnet test --sdk <8\|9\|10> --project <path> [--coverage]` | Test; produce TRX and coverage artifacts (see [dotnet-testing.md](dotnet-testing.md)). |
| `dev-test web screenshot --url <url> --profile <name> [--browser <engine>] [--full-page] [--root <dir>]` | Capture one screenshot. |
| `dev-test web responsive --url <url> --profiles <list> [--assert <rule>...] [--browser <engine>] [--root <dir>]` | Capture across profiles and apply responsive assertions. |
| `dev-test web a11y --url <url> --profiles <list> [--browser <engine>] [--root <dir>]` | Accessibility scan with axe-core (WCAG 2.1 A and AA tags), run from the pinned cache with no network. Violations exit 1; incomplete results are listed for a person. The report states that automated checks do not cover everything ([browser-runner.md](browser-runner.md)). |
| `dev-test web ha [--live] [--browser <engine>]` | Home Assistant read-only browser profile ([ha-readonly.md](ha-readonly.md)). Without `--live`: the anonymised local fixture. With `--live`: reports why the real instance is blocked (exit 4); contacts nothing. |
| `dev-test report <run-id>` | Show a stored result. |
| `dev-test cleanup [--run-id <id>] [--older-than <duration>] [--dry-run]` | Remove run workspaces; never evidence unless named. |

Global options: `--json`, `--run-dir`, `--timeout`, `--no-color`. Arguments are never interpreted by a shell; values are passed as separate argv entries.

## Output
- Human text goes to stderr. With `--json`, stdout holds exactly one JSON result object and nothing else.
- Every run has a unique `run_id`. Re-running never reuses a workspace.

## Exit codes
| Code | Name | Meaning |
|---|---|---|
| 0 | ok | Completed and every check passed. |
| 1 | subject_failed | The system under test failed (tests, assertions, responsive defect). Infrastructure worked. |
| 2 | usage | Invalid command or argument. Nothing started. |
| 3 | environment | Precondition missing (Docker, pinned image, writable cache, OpenBao). Nothing ran. |
| 4 | policy_refused | Refused before any container started (socket, privileged, disallowed mount, secret in arguments, unapproved target, mutating action). |
| 5 | timeout | Time limit exceeded; container stopped and removed. |
| 6 | internal | `dev-test` or the runner failed. Not evidence about the subject. |
| 7 | cleanup_incomplete | Finished, but something could not be removed. |
| 130 | interrupted | Interrupted by signal; containers stopped and removed. |

## Result object
Required fields: `schema_version`, `run_id`, `command`, `status` (`passed`, `failed`, `error`, `refused`, `timeout`, `interrupted`), `exit_code`, `started_at`, `ended_at`, `workspace`, `artifacts`, `cleanup`.
Each artifact: `kind` (`log`, `trx`, `coverage`, `screenshot`, `report`, `metadata`), `path`, `sha256`, `bytes`.
Also recorded: the image reference and digest used, the Git commit of the source, and whether redaction was applied.

## Compatibility
`contract_version` is 1. Adding fields is allowed; changing or removing an exit code or required field needs a new contract version and a new register entry.

## Implementation
Issue #8. `bin/dev-test` runs `cli/main.mjs`, which only plans and starts runs through the trusted runner (`docker/runner.mjs`, `dotnet/`, `browser/`); there is no second launcher and no shell is involved anywhere. The Docker socket is never mounted and no container is privileged (D-007); containers have no network (D-016) and are removed after every run (D-003).

### Setup
- `DEV_TEST_CONFIG` names the runner configuration (default `/mnt/cache/appdata/devtest-infrastructure/state/runner.json`; start from `docker/runner.example.json`). It holds policy only: `allowedProjects` (exact directories under `/mnt/user/projects`), `storageRoot`, `uid`/`gid`, `limits`, and optionally `lockFile`, `evidenceRoot`, `keepRuns` (newest run directories kept per evidence root, default 200) and `openbao: { address, policyFile }`. The dev-test repository itself must be in `allowedProjects` for `web` commands, because the browser scripts run from its read-only mount.
- `web` commands need the Playwright cache once: `node browser/prepare-cache.mjs` (deliberate, uses the network) and `node browser/restore-cache.mjs` (restore phase, writes the marker) ([browser-runner.md](browser-runner.md)). `dev-test doctor` shows whether it is ready.
- Images are never pulled by a run. A missing pinned image is exit 3 with the image name.

### Targets and policy
- `dotnet`: `--project` is a project/solution file or a directory with exactly one, inside an allowlisted project (symlinks are resolved first). Otherwise exit 4.
- `web`: `--url` is a `file://` URL of a page inside an allowlisted project. The CLI serves that page's directory (or `--root`, for sites that use root-absolute links such as `/style.css`) read-only from a host-side Unix socket; the browser container reaches only that origin. `http(s)` URLs are refused with exit 4 until a network target is approved (OQ-2, D-016). A URL with credentials, or with a query/fragment key or value that looks like a credential, is refused with exit 4 and never echoed (D-008).
- `--timeout` (seconds, or `90s`, `5m`, `2h`) may lower the configured limit; a larger value is refused (exit 4). `--run-dir` selects the evidence root (default `<storageRoot>/evidence`).
- Runs that need secrets are not exposed by v1 commands: no argument can name or carry a secret (D-008). The broker (`withSecrets`) is for the authenticated-run issue; `doctor` already uses `checkHealth` and validates the policy file without reading any value.

### Exit mapping
.NET: runner outcomes map one to one (build/test failure 1, timeout 5, runner fault 6, incomplete cleanup 7, interrupt 130). Browser: the wrapper's own code is kept in `data.wrapper_exit`; page errors (10), navigation timeout (11), blocked undeclared destination (12), TLS (13) and layout failure (15) are subject failures (exit 1). A wrapper fault (2, 14, anything else, or a "pass" with no screenshot) is exit 6, not evidence about the page. `--assert <rule>` narrows which layout rules fail the run; other findings are counted in `data.ignored_failures`, and a profile that did not render still fails.

### Result and evidence
Every command prints one result object with `--json` (extra fields: `contract_version`, `message`, `image: { reference, digest }`, `source_commit`, `redaction`, `data`). Runs store `<run-dir>/<UTC timestamp>-<run-id>/result.json` and `artifacts/` with hashes. As documented in [dotnet-testing.md](dotnet-testing.md), raw subject output is never persisted, so `dotnet build` keeps only `result.json`. `report <run-id>` reads a stored result from the selected run directory. `cleanup` removes idle workspaces under `<storageRoot>/runs` (never one with a mounted volume or an existing container), accepts `--older-than` and `--dry-run`, and removes evidence only for a named `--run-id`.

### Evidence of operation
`node --test tests/cli.test.mjs` (arguments, policy refusals, exit mapping, cleanup, with a fake runner) and, on Tower only, `ionice -c 3 nice -n 19 node tests/cli-smoke.mjs` (real Docker: screenshots, responsive pass/fail, `dotnet build` pass/fail, refusals, missing Docker and image, report and cleanup, nothing left behind). A real `dotnet test` with TRX/coverage through the CLI is not proven: it stays blocked on offline test packages (see [dotnet-testing.md](dotnet-testing.md)).
