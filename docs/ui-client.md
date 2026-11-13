# Web UI client (issue #1266)

The first screen of the new UI is a static web shell with a one line app bar. It reads only the versioned contract under `/api/v1/` and changes none of the present dashboard pages.

## Where it is served

- `GET /api/v1/ui` answers `302` to `/api/v1/ui/index.html` (`supervisor/api/routes/ui-index.mjs`).
- `GET /api/v1/ui/{file}` serves the files of `supervisor/ui/` (`supervisor/api/routes/ui-files.mjs`). The file names are listed once when the module loads, and a request is only looked up in that list, never joined to a directory. A name not in the list (including `..` and anything with a percent sign) answers `404` as JSON with the code `not_found`. The content type follows the extension (`.html`, `.css`, `.mjs`, `.js`, `.json`) and the dashboard's security headers are set on every reply.
- A file added to `supervisor/ui/` is served after the dashboard restarts (the list is built at load).

The page works under the existing content security policy: script and style files from the same origin, no inline script, no external request and no build step. The scripts are plain ES modules.

## The modules

| File | Job |
| --- | --- |
| `index.html` | the shell: the bar, a line area for notices, `main` and the details panel |
| `app.mjs` | wiring: first fetch, refetch on a change, theme, opening and closing the panel |
| `client.mjs` | fetches a read model by name; opens the change stream at `/api/v1/events` and reports the connection state (connecting, live, reconnecting, behind after 35 seconds with nothing) |
| `status.mjs` | the one status function: a condition becomes a tone (the shape drawn by `app.css`) |
| `appbar.mjs` | draws the bar, the agent panel and the lines under the bar from the app bar model |
| `format.mjs` | percentages, durations such as `3h 23m`, Europe/London times, state words |
| `app.css` | named colour tokens (light and dark, 4.5 to 1 or better), the bar and the status shapes |

No agent name is in the code: the agents are drawn in the order the model serves them.

## How a change reaches the bar

On a `model_changed` or `command_applied` event naming `appbar`, or on `resync_required`, the client fetches `/api/v1/appbar` again. A heartbeat or `freshness_changed` event updates the freshness line without a fetch. After a reconnect the model is fetched again once the stream is live.

## Add a screen module

1. Create `supervisor/ui/<screen>.mjs` exporting a function that draws into the element it is given (use `textContent` or `createElement`, never markup built from model text).
2. Fetch its model with `fetchModel('<name>')` from `client.mjs`, and refetch when `onChange` names it (in `app.mjs`).
3. Take every tone from `toneOf` in `status.mjs` and every number or time from `format.mjs`; use the colour tokens of `app.css`.
4. Import it in `app.mjs` and give it `#main`. Keep the same rules: only paths under `/api/v1/`, no inline script, no build step.
5. Add a test beside `tests/ui-static.test.mjs` and, for what the person sees, a scenario run like `tests/ui-appbar-browser.mjs`.

## Tests

- `tests/ui-static.test.mjs`: the files, content types, security headers, HEAD, the redirect and the 404 cases through the real dashboard handler.
- `tests/ui-modules.test.mjs`: the status function, the formats, the stream client and the colour contrast.
- `node tests/ui-appbar-browser.mjs <dir>` (Tower, pinned Chromium, after `node browser/prepare-cache.mjs`): the real page and router at 1280 and 390 wide, on a temporary contract folder with a fixture app bar model; scenario in `browser/ui-appbar-scenario.mjs`.

## Notes on the chips and the lines under the bar

- An agent chip shows its status as a shape; the word for it is the chip's title (with the reason text) and its accessible name, and the panel header shows shape and word together.
- The stale line is shown when the envelope freshness state is anything other than fresh, so also when it is unknown (then it says no tick has been recorded). This is a deliberate choice: an unknown freshness must not look current.
