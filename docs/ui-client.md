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

## The live board screen (issue #1312)

Shown when the page address ends in `#/board`; with no such ending the main area holds one link to it, and the app bar is the same on both. It draws the `liveboard` read model (`docs/api-contract.md`) and holds no rules: every box, hold and count comes from the model.

| File | Job |
| --- | --- |
| `board.mjs` | the screen: asks for the model when it opens and again on a `model_changed` event naming `liveboard` (or `resync_required`, or a reconnect), redraws in place, opens and closes the side panel, keeps the last good board marked stale on an error |
| `boardlayout.mjs` | pure: the one `LAYOUT` table (every position and size), the nine boxes, ball places in the hopper, lanes and boxes, ride height, allowance fractions, the rows of the side panel |
| `boardsvg.mjs` | draws the SVG (no library) from the geometry |
| `boardlists.mjs` | the same content as HTML lists, the error line and the side panel |
| `boardmotion.mjs` | pure: compares two liveboard replies into launch, land and return events, plans every travel path, carries the laps a returning ball shows |
| `boardtravel.mjs` | holds the travels under way and puts each back on its ball after every redraw with the Web Animations API |
| `board.css` | the board styles; job and agent colours are named once at the top |

- **Layout (first version).** Lanes rise up the left, grouped by agent, with the allowance under each group; the hopper is at the foot of the lanes; the peg board fills the middle; the nine result boxes run along the bottom. To move anything change `LAYOUT` in `boardlayout.mjs`.
- **Hopper.** The waiting entries in plan order, the next one in the top row nearest the lanes. A held ball is greyed and shows its hold reason on hover and focus; a ball tied to an agent carries that agent's colour mark. What does not fit is counted as "+N more" and is in the list.
- **Running.** A ball's height is elapsed time against `typical_seconds`, capped at 0.92 of the lane. With no estimate it sits at mid height and is marked; past the typical time it changes colour and says running long.
- **Lists.** Below 640 px wide the board is not drawn and the lists are the screen. At wider widths the same lists are present for screen readers only. A box click shows that box's list under the board; each Needs you row links to the Inbox page found by the item's number (`/inbox?state=all&search=<number>`).
- **Data.** One request when the screen opens and one per change event; no timer fetches data. A failed request shows the error with Retry and keeps the last board marked stale. Travel (issue #1313) is described under "Ball travel" below.
- **Tests.** `tests/ui-boardlayout.test.mjs` (pure module); `node tests/ui-board-browser.mjs <dir>` (Tower, pinned Chromium) runs `browser/ui-board-scenario.mjs` at 1280 and 390 wide against a fixture model from `tests/ui-board-fixture.mjs`.

## Ball travel (issue #1313)

Part 2 of the live board. Travel starts only from the comparison `board.mjs` makes when the change stream says `liveboard` changed (`changed()`); opening the screen, Retry and a resize never start one, and no timer does.

- **Events** (`diffBoard`): *launch* (a job is running that was not), *land* (a job is in `landed` that was not there before; it leaves the top of its lane if it was running, the foot if it was unseen), *return* (an item whose ball landed in Changes asked, Failed or Out of allowance is waiting again; its laps go from the landed figure to one more). An empty first reply gives no events.
- **Paths.** Launch: hopper place to the lane, 0.9 s, and the remaining hopper balls close up. Land: from the lane over the pegs into the box, 1.5 to 3 s, five pegs touched; the path is a function of the job id, the lane and the box (a hash of the id, no random numbers, no physics). Return: along the bottom back to the hopper, 1.8 s. The pegs are the ones `boardsvg.mjs` draws (`PEG`).
- **Rules.** More than 12 events in one change are shown at once and the line "N things changed" is shown. Reduced motion (`prefers-reduced-motion`) and widths below 640 px: nothing travels. A moving ball is a normal ball and can be clicked; a newer change for the same ball (it ran, landed or moved on) ends its travel at its new place.
- **Laps.** A waiting entry of the model carries no laps, so a return remembers the figure it raised for as long as the item waits. After a reload, a waiting ball shows none until it runs.
- **Tests.** `tests/ui-boardmotion.test.mjs` (pure module); `node tests/ui-boardmotion-browser.mjs <dir>` (Tower, pinned Chromium) runs `browser/ui-boardmotion-scenario.mjs` at 1280 wide.
