# Browser runner (issue #5, Track B)

Status: implemented in source on `claude/issue-5-playwright`; independent review pending. Decisions: D-002 (no .NET in this track), D-004 (official image, digest), D-015 (hardening), D-016 (browser runs reach only declared targets).

## What runs
The official Playwright image, pinned by digest in `docker/images.lock.json` with the tag and the date it was resolved from, runs under the same runner as the .NET track: non-root, `--cap-drop=ALL`, `no-new-privileges`, read-only root, fixed-size loop images for `/work` + `/out` (hard ENOSPC ceiling), bounded CPU/memory/PIDs/time, no raw output persisted, every mount released on every outcome. No .NET runtime is involved.

`playwright-core` is not inside the image. `browser/prepare-cache.mjs` (host side, deliberate, uses the network) downloads exactly the version in the lock file and refuses it unless its npm integrity matches. A `restore`-phase run then unpacks it into the cache image, which later `test`-phase runs mount read-only.

```
node browser/prepare-cache.mjs                 # host: fetch + verify playwright-core (git-ignored browser/vendor/)
restore run:  tar -xzf /src/browser/vendor/playwright-core-<v>.tgz -C /cache
test run:     node /src/browser/capture.mjs --target <name> --path /page.html --profile phone|desktop \
                --browser chromium|firefox|webkit [--full-page] [--wait load|domcontentloaded|networkidle] \
                [--timeout-ms 15000] [--trace] --name <file-stem>
```

## Network: what is enforced
The container always has `--network=none`: no interface except loopback and no route. The only way out is a **declared target**: `targets: ["fixture"]` in the run spec mounts the host-side Unix socket `<storage>/sockets/<run-id>/fixture.sock` read-only at `/targets/fixture.sock`. The runner refuses a target that is not a real socket in a private (0700) run directory it owns. Inside the container `capture.mjs` bridges one loopback port to that socket; the browser may request only that origin (plus inline `data:`/`blob:`/`about:`). Any other request is aborted before it leaves the browser, recorded without its query string, and makes the run exit 12. Chromium additionally gets `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`.

`browser/static-server.mjs` is the host-side static server for fixtures: GET/HEAD only, files below one root, no listing, no symlinks, socket mode 0600 owned by the container user.

**Blocked on OQ-2 (not done, needs no firewall change to stay safe but cannot be offered yet):** a target that is a real TCP service (a Blazor app on a LAN address, Home Assistant for #10). Reaching it needs either a network namespace with a host firewall rule limiting it to one `ip:port`, or a trusted host-side forwarder. A Docker bridge, even `--internal`, gives the container the host's gateway address and with it every host service listening on all interfaces, so none is offered. The runner still refuses every `network` value other than `none`. Raising it requires the explicit homeowner approval OQ-2 describes.

## Wrapper exit codes (the container's own result; the runner reports it as `subjectExit`)
| Code | Meaning |
|---|---|
| 0 | Page loaded, screenshot written, no console errors, page errors, HTTP errors (>= 400) or failed requests |
| 2 | Usage error, or the declared target is not mounted |
| 10 | The page reported errors (screenshot still taken) |
| 11 | Navigation timed out (explicit, bounded by `--timeout-ms`) |
| 12 | The page tried to reach an undeclared destination (blocked and recorded) |
| 13 | TLS error: certificate validation is never bypassed |
| 14 | The browser could not be launched |

Output in `/out`: `<name>-<profile>-<browser>.png`, `.report.json` (schema_version 1: status, durations, console/page/HTTP/failed/blocked lists, no query strings), and with `--trace` a `.trace.zip`. Profiles: `phone` 390x844 @2x touch, `desktop` 1280x800 @1x.

## Known limits
- Chromium runs with Playwright's default `--no-sandbox` inside the container; the container hardening is the boundary, not the browser sandbox.
- Browser engines are the ones bundled in the pinned image (Chromium 156, Firefox, WebKit proven with a screenshot each).
- **A trace is not redacted.** Reviewing a real trace showed it keeps full request URLs including query strings, and DOM snapshots (page HTML). The report is redacted; the trace is not. Traces are opt-in (`--trace`), written 0600, and the report says `trace.redacted: false`. Never trace a page that shows or sends a secret, and treat a trace as sensitive evidence (OQ-4 retention).
- Wrapping this in the single `dev-test` CLI is issue #8 (Codex), which depends on #5 and #6. Not done here.

## Interface for #8
#8 should call the runner API, not the wrapper's internals: `createPlan({ project, runId, image: 'playwright', phase: 'restore'|'test', targets: [...], command }, config)` then `runContainer(plan)` from `docker/runner.mjs`, with the host-side target started by `createStaticServer` + `listenOnSocket(…, targetSocketPath(storage, runId, name), …)` from `browser/static-server.mjs` and closed afterwards. The container command is `node /src/browser/capture.mjs …` (argument list above). Map the wrapper's own code (`subjectExit`: 0, 2, 10–14) onto the CLI contract's "subject failed" (exit 1) and keep the specific code in the `--json` result; read `<name>-<profile>-<browser>.report.json` from `/out` (use `withRunVolume` or `keepVolume` + `releaseVolumes`). Before the first `test` run the cache needs `node browser/prepare-cache.mjs` and a `restore` run.

## Evidence
`node tests/browser-smoke.mjs` (Tower only, real Docker, niced): restore; no route and no external connect from inside; desktop and phone screenshots (1280x800, 780x1688 PNG); broken page exit 10 with console error, page error and a 404; external page exit 12 with three destinations blocked and no token in the report; Firefox and WebKit screenshots; undeclared target exit 2; loops, mounts and containers back to baseline; no socket left behind. Unit tests: `tests/browser.test.mjs` (runner, server, arguments) and `tests/browser-capture.test.mjs` (wrapper exit codes and precedence against a fake Playwright).
