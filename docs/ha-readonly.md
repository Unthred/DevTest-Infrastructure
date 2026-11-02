# Home Assistant read-only browser profile (issue #10)

Status: implemented in source on `claude/issue-10-10-home-assistant`; independent review pending. **Live acceptance is BLOCKED** (see "Live Home Assistant"). Everything that was run, was run against the anonymised local fixture. Decisions: D-008 (secrets), D-009 (read-only), D-016 and OQ-2 (network), D-022 (secret delivery).

```
dev-test web ha [--browser chromium|firefox|webkit]     # the anonymised local fixture (default, runs today)
dev-test web ha --live                                  # contacts nothing; reports why the real instance is blocked (exit 4)
```
There is no `--url`: the profile serves only `browser/fixture/ha/` and a live address cannot be passed in. Container command (the CLI runs this through the same runner as `web responsive`): `node /src/browser/ha-readonly.mjs --target <name> [--page-set fixture|live] [--pages name=/path,...] [--profiles phone-390,desktop-1280] [--probe none|clicks] [--session /secrets/<name>] [--forward-websocket] ...`.

## What it does
For each page (`dashboard`, `heating-settings`, `heating-season`; live paths `/lovelace/0`, `/lovelace/heating-settings`, `/lovelace/heating-season`) and each profile (`phone-390`, portrait 390x844 @2x touch, and `desktop-1280`):
- navigates and saves a full-page screenshot (`ha-<page>-<profile>-<browser>.png`);
- runs the layout checks of [responsive-audit.md](responsive-audit.md): sideways overflow, clipping, controls sticking out, tiny or covered targets;
- writes `ha.summary.json` (schema_version 1) and `ha.report.md`. Page text, input values and cookies never reach either.

## Read-only enforcement (D-009), three independent layers
| Layer | Rule | Recorded as |
|---|---|---|
| Network | Only GET and HEAD to the declared target pass. Any other method is aborted before it leaves the browser. | `readOnly.blockedWrites` (`METHOD scheme://host/path`, no query) |
| WebSocket | Client frames are checked against an allow-list of read types (`get_states`, `subscribe_events`, `lovelace/config`, `ping`, ...). `call_service`, any `*/update`, `*/save`, `*/set_value` and any unknown or non-JSON frame is dropped. By default the socket is a mock that reaches nothing; `--forward-websocket` relays the allowed frames. | `readOnly.blockedFrames` (type label only, never the payload) |
| Page | A capture-phase listener on `window` (installed in every context) stops click, keyboard, input, change and submit events on anything that can change state: buttons, inputs, selects, switches, sliders, `hui-climate-entity-row`, `ha-climate-control`, `input_*` helper rows and others (`MUTATING_SELECTOR`), including inside shadow DOM (the event's composed path is checked). Links and tabs pass. | `readOnly.blockedInteractions` (`event:tag` labels) |

The test itself never clicks a control. An attempted write, a blocked interaction nobody asked for, or (in the probe) a handler that still ran is a failure with its own wrapper exit code **16**, mapped by the CLI to exit 1 with `wrapper_exit: 16`. Precedence: undeclared destination (12) > read-only violation (16) > layout (15) > page errors (10).

`--probe clicks` (fixture only; refused on the live page set) clicks and presses Space on every control the fixture marks `data-mutates` (22 across the three pages) and counts handlers that still ran. The guard must stop all of them: `mutated` must be 0.

## Isolated authentication
The profile accepts a Playwright storage state from the broker only as a mounted file (`--session /secrets/<name>`; any other path is refused, so a credential cannot arrive as an argument). The file is parsed, handed to a fresh browser context per page and profile, and never reported. Delivery, domain allow-list, expiry cap and the post-run leak scan are the broker's (D-022, [secrets.md](secrets.md)); a run with secrets refuses traces. No session exists for Home Assistant today, so authentication is covered by unit tests with a fake browser only.

## Live Home Assistant (`home.yeradonkey.com`): blocked
`dev-test web ha --live` evaluates `browser/ha-live-gate.mjs` and reports exit 4 with the reasons. As of this change:
1. **Credentials.** The policy entry `ha-test-login` is `production`; it is refused until `productionIdentity.confirmed` names a homeowner-approved decision *and* the identity starts with `devtest-`. No dedicated least-privilege Home Assistant test user or read-only OpenBao identity exists (secrets.md, "Homeowner actions").
2. **Network route.** The runner reaches only host-side Unix-socket targets (OQ-2). A TCP route to the Home Assistant host needs a firewall rule or forwarder, which requires fresh explicit homeowner approval. Not requested here.
3. **Permissions.** Whether the test user's role can only read the Heating pages is unconfirmed.

Even when all three are resolved the gate only says "ready"; the CLI still refuses to open a TCP target until a later, separately approved change adds one. Nothing in this repository logs in to, navigates to or changes the real Home Assistant, and no live success is claimed.

## Fixture
`browser/fixture/ha/`: three anonymised pages (invented names, no real entity ids, hosts or values) with climate rows, switches, a helper slider, select and text inputs, all counting handler runs; `attempts-write.html` POSTs a service call and sends a `call_service` frame; `broken-settings.html` overflows a phone. The fixture shares the dashboard's structure only loosely: it proves the harness, not that the real dashboard renders well.

## Evidence
- `tests/ha-readonly.test.mjs`: method and frame rules, the guard (positive and negative, with a mutation check), live-gate decisions (blocked today, blocked on a proposal, wrong domain, invalid policy), argument rules, and the wrapper against a fake Playwright (write aborted, frames dropped, undeclared host outranks, session passed and never reported).
- `tests/cli.test.mjs`: `web ha` result mapping, exit 16, no URL option, `--live` blocked and nothing started.
- `node tests/ha-readonly-smoke.mjs` (Tower, real Docker, needs `node browser/prepare-cache.mjs`): Chromium, Firefox and WebKit pass on the fixture (6 screenshots each, 780 or 1280 px wide), 22 controls clicked and all blocked with 0 mutations, the write-attempt page fails with exit 16, the overflow page fails on the phone only, cleanup back to baseline.

Not claimed: visual acceptance, a live run, a real authenticated session, pixel baselines.
