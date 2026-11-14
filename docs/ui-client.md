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
| `boardstyles.mjs` | pure: the ordered list of style names (`peg`, `marble`, `launch`) and the choice rule |
| `boardswitch.mjs` | loads the style modules when the screen opens, keeps the choice in the browser, draws the switch |
| `boardstyle-peg.mjs` | the first style: draws the pegs and plans the bounce path of a land |
| `boardtiming.mjs` | the timings and the job id hash every style uses |
| `boardtravel.mjs` | holds the travels under way and puts each back on its ball after every redraw with the Web Animations API |
| `boardball.mjs` | pure (issue #1317): the four job families, the letter, the accessible name, the lane text placement |
| `boardballdraw.mjs` | draws the body of a ball (icon mask or disc) and the model text of a lane |
| `boardicons.mjs` | asks for each agent icon once per open and keeps it as a data address |
| `boardlegend.mjs` | the legend of the four families |
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
- **Paths.** Launch: hopper place to the lane, 0.9 s, and the remaining hopper balls close up. Land: from the lane over the pegs into the box, 1.5 to 3 s, five pegs touched; the path is a function of the job id, the lane and the box (a hash of the id, no random numbers, no physics). Return: along the bottom back to the hopper, 1.8 s. The pegs are the ones the peg style draws (`PEG` in `boardstyle-peg.mjs`); since issue #1315 the style plans the path.
- **Rules.** More than 12 events in one change are shown at once and the line "N things changed" is shown. Reduced motion (`prefers-reduced-motion`) and widths below 640 px: nothing travels. A moving ball is a normal ball and can be clicked; a newer change for the same ball (it ran, landed or moved on) ends its travel at its new place.
- **Laps.** A waiting entry of the model carries no laps, so a return remembers the figure it raised for as long as the item waits. After a reload, a waiting ball shows none until it runs.
- **Tests.** `tests/ui-boardmotion.test.mjs` (pure module); `node tests/ui-boardmotion-browser.mjs <dir>` (Tower, pinned Chromium) runs `browser/ui-boardmotion-scenario.mjs` at 1280 wide.

## Board styles (issue #1315)

Part 3 of the live board: more than one look for the middle of the board, and the switch between them. The board looks and moves as before in the peg style; a style changes only the scenery in the middle and the route a ball takes through it. Balls, hopper, lanes, boxes, allowance, side panel and lists are drawn by `boardsvg.mjs` and `boardlists.mjs` and are the same in every style.

- **The three names**, in the order of the switch: `peg` (Peg board, present), `marble` (Marble run) and `launch` (Launch pad). The last two are their own items; until their files exist they do not load and are left out.
- **Adding a style adds files and edits none.** Add `supervisor/ui/boardstyle-<name>.mjs` directly in the UI folder (the file route serves no subfolder) with `<name>` one of the listed names. It exports `name`, `label`, `draw(geometry, svg)` and `plan(step)`, and imports from `boardlayout.mjs` and `boardtiming.mjs` only. A new name in `STYLE_NAMES` (`boardstyles.mjs`) is the one line that lists it.
  - `draw(geometry, svg)` returns `{ defs, nodes }`: what goes in `<defs>` and what is drawn under the lanes, from the layout table. `svg(tag, attributes, ...children)` builds an element.
  - `plan({ kind, jobId, lane, box, from, to, geometry })` returns `{ points, durationMs }` (a land may add `touches`). `kind` is `launch`, `land` or `return`; `from` and `to` are the points the common code found; `lane` and `box` are entries of the layout table (`null` where none applies). It must be a function of its inputs: the job id gives the variety, and no random numbers or clock are read. A land ends inside its box and lasts 1.5 to 3 seconds; every point is on the board.
  - `tests/boardstyle-rules.mjs` states these rules for every lane and box pair; a style's test calls `checkStyleRules(style)`, as `tests/ui-boardstyles.test.mjs` does for peg.
- **Loading.** When the screen opens it tries each listed style; peg is imported directly and is always present. A style that does not load or is not shaped like a style is left out of the switch, with one console line (`Board style <name> left out: …`) and no error on the page.
- **The switch.** A labelled radio group ("Board style") above the board: the chosen button is the one tab stop and the arrow keys move the choice. It is shown only when more than one style loaded and never below 640 px (where the board is not drawn). The choice is kept in the browser (`localStorage`, key `devtest.board-style`); when storage is blocked the switch still works for that visit. The chosen style is the saved one if it loaded, otherwise peg.
- **Using it.** The board redraws at once with every ball in its place; no travel plays because of a switch, and a travel in progress ends with its ball at the destination. Reduced motion and the 640 px rule are unchanged in every style. The only event is the click or key; there is no timer.
- **Tests.** `tests/ui-boardstyles.test.mjs` (list, choice rule, loading, storage, peg against the shared rules); `node tests/ui-boardstyles-browser.mjs <dir>` (Tower, pinned Chromium) runs `browser/ui-boardstyles-scenario.mjs` at 1280 and 390 wide, serving a fixture second style (`tests/boardstyle-marble-fixture.mjs`).

## What a ball and a lane look like (issue #1317)

Part 4 of the live board, common code only, so it is the same in every style.

- **The ball.** The shape says which agent, the colour says which kind of job. A ball whose agent has an icon (the `icon` path of the agent in the liveboard model) is drawn as that icon used as an alpha mask over a square painted in the job family colour. The issue or pull request number stays beside it, at its lower right. With no icon, or when the icon fails to load, the ball is a plain disc in the family colour carrying the first letter of the agent's display name; a disc never shows a broken image. A waiting ball with no agent yet is a disc with no letter; a waiting ball tied to an agent uses that agent's icon or letter. An agent with an empty display name gives a disc with no letter.
- **Colour families** (`FAMILIES` in `boardball.mjs`, the colours are named in `board.css`): *new work* (implement, continue, split), *fixing* (fix, ci-fix), *review* (review, interim-review), *housekeeping* (rebase, Inbox jobs and any type not listed). A held ball is grey and a running-long ball keeps its own colour, as before.
- **Contrast.** Each family colour against the board background (the `--surface` token): new work 4.88 to 1 light and 3.58 dark, fixing 4.99 and 3.50, review 4.67 and 3.74, housekeeping 5.25 and 3.32 (at least 3 to 1 in both themes). The white letter on a disc is 4.88, 4.99, 4.67 and 5.25 to 1 against the four discs (at least 4.5 to 1). A held disc and a running-long disc are opaque with their own fills (`--held-disc`, `--long-disc`): the letter is 4.83 and 5.93 to 1 on the held disc (light, dark) and 6.22 and 5.47 on the long disc. `tests/ui-boardball.test.mjs` measures these from `board.css` and `app.css`, and the browser check measures them on the page in both themes.
- **Legend.** A list of the four families with a swatch and the job types each holds, above the board, and above the lists on a phone. Each list item has its family swatch and the agent and model as text; each agent in the Agents list names its models.
- **Names.** The exact job type is in the side panel (row Job type) and in the accessible name of each ball: job type, issue or pull request number, agent, model, for example `review, pull request 1244, claude, opus`. Reviews, fixes, CI fixes and rebases are about a pull request, the other types about an issue. A lane with a null model says `default model`.
- **Lane text.** The model name is drawn faintly along each lane, reading from the foot upward, in place of the label that was under the lane. With exactly one ball in the lane it is placed in the half the ball is not in, so a running ball never hides the whole name; with no ball or two or more it stays at the foot. A name too long for its room is cut with an ellipsis; the full name is in the lists, which keep the model name as text for screen readers.
- **Icons.** Each agent icon is asked for once, with the screen's own request, each time the screen opens (`IconStore`); model changes, resizes and redraws ask for none, and no timer does. The file is read into a data address so the page needs no image source beyond `data:` (the security headers are unchanged), and is tried as an image first: until it has loaded, and if it answers an error, is not an SVG or does not decode, the agent's balls are discs with the letter. Only a path under `/api/v1/agent-icon/` is ever requested.
- **Tests.** `tests/ui-boardball.test.mjs` (pure module, icon store with an injected fetch, contrast from the stylesheet); `node tests/ui-boardball-browser.mjs <dir>` (Tower, pinned Chromium) runs `browser/ui-boardball-scenario.mjs` at 1280 and 390 wide, light and dark, against the real dashboard handler with a made up star icon for claude and none for codex.
