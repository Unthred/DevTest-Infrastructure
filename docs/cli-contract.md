# `dev-test` CLI contract (v1)

Status: `agent-proposal` (D-017), to be implemented in issue #8. The machine-readable form is [`contracts/cli.v1.json`](../contracts/cli.v1.json); the validator checks that this page and that file agree.

## Commands
| Command | Purpose |
|---|---|
| `dev-test version` | Print CLI and contract versions. |
| `dev-test help [command]` | Usage. |
| `dev-test doctor` | Read-only check of Docker, pinned images, cache and run directories, OpenBao reachability and policy state. |
| `dev-test dotnet build --sdk <8\|9\|10> --project <path>` | Build in a pinned SDK container. |
| `dev-test dotnet test --sdk <8\|9\|10> --project <path> [--coverage]` | Test; produce TRX and coverage artifacts. |
| `dev-test web screenshot --url <url> --profile <name>` | Capture one screenshot. |
| `dev-test web responsive --url <url> --profiles <list> [--assert <rule>...]` | Capture across profiles and apply responsive assertions. |
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
