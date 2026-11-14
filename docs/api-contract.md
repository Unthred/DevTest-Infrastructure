# The versioned read contract (`/api/v1/`)

Issue #1248. A second interface, and the overseer, read Foreman through one stable shape instead of reshaping the large dashboard view each time. The contract lives beside the existing routes and changes none of them. All code is in `supervisor/api/`.

## Envelope

Every model reply under `/api/v1/` is a JSON object with exactly these fields: `contract` (the string `1.0`), `model` (the model name), `generated_at` (UTC ISO 8601, ending in `Z`), `freshness`, `cursor` and `data`.

`freshness` holds `state` (`fresh`, `stale` or `unknown`), `tick_at` (time of the last finished tick, or null), `age_seconds`, `stale_after_seconds`, `reason_code` and `reason_text`. With no finished tick the state is `unknown` and `tick_at` and `age_seconds` are null. `cursor` is the id of the last change event; it is the fixed string `e-0` until the change stream exists.

Every reply, including errors and schemas, carries the header `Foreman-Contract: 1.0` and the dashboard's usual security headers.

Not wrapped: a schema file (`/api/v1/schemas/NAME`) is served as the plain schema, and an error is `{"error": {"code": "...", "text": "..."}}`.

## Rules for every model

- No HTML, no colours, no CSS class names.
- Times are UTC ISO strings ending in `Z`, never epoch numbers.
- Durations are whole seconds in fields ending `_seconds`.
- A value the core does not have is `null`, never `0`.

## Routes

| Request | Answer |
| --- | --- |
| `GET /api/v1/<model path>` | 200, the enveloped model |
| `GET /api/v1/meta` | 200, the meta model: loaded models, the state vocabulary, commands and events (taken from the optional `commands` and `events` exports of the route modules; empty when none export them) |
| `GET /api/v1/schemas/NAME` | 200, a schema file, only if `NAME` is exactly a file name in `supervisor/api/schemas/` as listed at start; otherwise 404 |
| any other path under `/api/v1/` | 404, error code `not_found` |
| `GET`/`POST` of a route module path | the module's own reply (see Adding a route module) |
| a method other than GET or HEAD, with no route module for it | 405, error code `method_not_allowed` |
| a Host the dashboard does not serve | 421, error code `unexpected_host` |

HEAD answers with the same headers and no body.

## Shared definitions

`supervisor/api/schemas/common.schema.json` defines `timestamp`, `condition` (state, attention, reason_code, reason_text, since; attention is `none`, `homeowner`, `fault` or `unknown`), `ref` (kind, key, label, title, source, project, url), `action` (command, input, enabled, tier, reversible, refusal_code, refusal_text; tier is `direct`, `approval` or `person_only`), `freshness` and `envelope`.

## Adding a model

1. Add `supervisor/api/models/<name>.mjs` exporting `name`, `path` (the part after `/api/v1/`), `schema` (the file name of its schema) and a pure `build(view, context)` that returns the `data` object. The context holds `now` (ms), `coreVersion`, `models` (the loaded modules), `routes` (the loaded route modules), `query`, `params` and `root` (the state root) and `config` (the current validated configuration). `build` may return a promise, and may return `notFound(text)` (exported by `supervisor/api/router.mjs`) to answer 404 with the code `not_found`. Optionally export `usesView = false` when the model needs no dashboard view, so the router does not prepare one.
2. Add `supervisor/api/schemas/<name>.schema.json`, using `allOf` with `common.schema.json#/$defs/envelope` as `meta.schema.json` does.
3. Add a test that fetches it through the dashboard handler and checks the reply with `supervisor/api/validate.mjs`.

The router lists `models/`, `routes/` and `schemas/` when the dashboard handler is created, so no router file changes. A module without the four exports is skipped and logged.

### Paths with a key and the query

A model `path` may hold a segment in braces, for example `work-items/{key}`. A request matches when every fixed segment is equal; each braced segment is given in `context.params` under its name. A value may hold only letters, digits, dot, underscore and hyphen, at most 64 characters; any other value (a percent sign, a slash, 65 characters) answers 404 as JSON. `context.query` is a plain object of the request query parameters: at most 20 names (the first 20), each value a string cut at 200 characters.

## Adding a route module

A route module is for a reply the envelope does not fit (a stream, a command). Add `supervisor/api/routes/<name>.mjs` exporting `name`, `method` (`GET` or `POST`), `path` (as for models, braces allowed) and `handle(req, res, context)`. The router lists the folder at start; a module without that shape is skipped with one logged line. For a matching request the router calls `handle` and the module writes the whole reply (it does not get the envelope). A GET route also answers HEAD with the same status and headers and no body. POST under `/api/v1/` is accepted only for a route module that declares it; every other POST answers 405.

Optional exports: `events` and `commands` (arrays of objects) fill the same lists of the meta model; `cursor(root)` returns the envelope cursor (the first loaded module that exports it wins; without one the cursor stays `e-0`).

The context holds everything a model gets (`now`, `coreVersion`, `models`, `routes`, `query`, `params`, `root`, `config`) plus `headers` (the security headers), `reply(req, res, code, type, body, extra)`, `fail(req, res, code, errorCode, text, extra)` and `guard`. `guard` hands over the dashboard's write checks, so a route copies none of them: `originAllowed(req)`, `proofValid(value)`, `reserveCooldown(name, ms)` (returns `{ ok }` or `{ ok: false, retryAt }`), `releaseCooldown(name)`, `invalidateView()` (drop the prepared view so the next read is fresh) and `wake(reason)` (ask for a pass). A write route must call `originAllowed` and `proofValid` itself before it changes anything.

## The outcomes model

Issue #1307. `GET /api/v1/outcomes?hours=N` answers, for a time window, which issues and pull requests had activity, which pegs each passed or bounced off in order, how many laps it took and where it stands. A screen can draw and replay it with no logic of its own. It is built when asked from the retained timeline, the dashboard view and the current Needs you list: no timer, nothing stored. The logic is the pure builder `supervisor/outcomes.mjs`.

- `hours` is a whole number from 1 to 168, default 24. Any other value answers 400 with the error code `invalid_hours`.
- One item per issue or pull request with at least one step in the window. An issue and its pull request are one item, keyed `pr-N` once the pull request exists (the issue number stays in `issue`), else `issue-N`. The link comes from a merge entry or a pull request row of the view.
- A step has `at`, `peg` (`implement`, `ci`, `review`, `rebase`, `merge`) and `result` (`passed` or `bounced`). The mapping is fixed:

| Timeline entry | Step |
| --- | --- |
| implement or continue job, event `completed` | implement passed |
| implement or continue job, event `blocked`, `crash`, `incomplete`, `retry_exhausted`, `auth_error` or `stale_handover` | implement bounced |
| review verdict PASS | review passed |
| review verdict CHANGES | review bounced |
| cifix job, event `created` (one per job) | ci bounced |
| rebase entry (a completed rebase) | rebase passed |
| rebase job, event `blocked`, `crash`, `incomplete`, `retry_exhausted`, `auth_error` or `stale_handover` (Foreman records a blocked job under its cause) | rebase bounced |
| merge entry | merge passed |

Every other entry (a fix or review job, a started or created event, an unknown job kind) is not a step and is ignored. A completed rebase job is not counted again: its rebase entry is the step.

- `laps` is the number of bounced steps followed by a later step in the window.
- `bin` is decided in this order: `merged` (has a merge step), `needs_you` (the current Needs you list names the issue or pull request), `failed` (the last step is bounced and nothing followed), else `moving`.
- `title` is the dashboard view's title, or null when it does not know the item.
- The reply carries `window` (`hours`, `start`, `end`), `counts` per bin over every qualifying item, `truncated` (true when more than 200 items qualify) and `items`: the 200 most recently active, newest first.
- **Install is not a peg.** Foreman records no install event per pull request, so the model cannot place one without inventing it. A later item may add it when such an event exists.

## The live board model

Issue #1310. `GET /api/v1/liveboard` gives a screen everything it needs to draw the queue working: waiting work, a ball leaving on a lane when a job starts, and the ball landing in a box that says how the job ended. The screen holds no rules. It is built when asked from the dashboard view, the configuration and the time of the request: no GitHub call, no clock of its own, no stored state. The logic is the pure builder `supervisor/board.mjs`.

**When to ask again.** There is no timer. The change stream (`/api/v1/events`) appends one `model_changed` event, which names every loaded model including `liveboard`, when the tick moves. A client asks again on that event.

- `agents`: one entry per configured agent with `id`, `display_name`, `condition`, `weekly`, `short` and `reading`, built by the app bar code (`agentEntries` in `supervisor/api/models/appbar.mjs`), plus `out_until`, `out_reason` and `icon`. `icon` is the path of the agent's icon route (`/api/v1/agent-icon/<agent>`) when an acceptable icon file exists, else `null` (the screen then draws a plain ball); see the next section. `out_until` is the reset time reported for the agent's current job when it is paused on a usage limit (the dashboard view carries the reset time for that job only), else the next attempt time of its paused jobs, else the end of its allowance hold (reviews only, or waiting for the reset) while that is still ahead; `null` means the agent can take work. A paused job whose reset time is not reported gives `out_until` null and an `out_reason` that says so.
- `lanes`: one entry per agent and model the configuration can launch (every `models.agents.<agent>` entry and review candidate), then any pair a running or landed job used. `id` is `<agent>/<model>`, or `<agent>/default` with a null `model` when the provider default is used; `job_types` lists the job kinds that run on it (`cifix` is the kind name of `ci-fix`). A new agent or model appears with no code change.
- `waiting`: the planned work in plan order (`place` from 1; an action already launched is not waiting). `tied_agent` is the agent the work must go to: the planned agent for `fix`, `cifix`, `continue` and `rebase` (a fix returns to its writer), the agent an issue is configured for on `implement`, else null (any agent with a free slot). `held` is `{ kind, reason }` from the tick's plan ledger, or null when the work can start.
- `running`: one entry per running job with `job_id`, `lane_id`, `job_type`, `number`, `title`, `started_at`, `typical_seconds` and `laps`. `typical_seconds` is the median (p50) for that job type from Foreman's own estimates, null with fewer than 5 recorded jobs of that type.
- `landed`: one entry per job that ended in the last 24 hours (an end exactly 24 hours ago is kept), newest first, with `job_id`, `lane_id`, `job_type`, `number`, `title`, `ended_at`, `box`, `tokens`, `cost_pence` and `laps`. A job paused for a usage limit or by hand has landed in its box. `cost_pence` is the usage-equivalent estimate converted with the configured pounds per dollar; unknown tokens and cost are null. `number` is the issue for `implement` and `continue`, otherwise the pull request.
- `counts` is the number of qualifying landed jobs per box; `landed` keeps the newest 300 and `truncated` is true when more than 300 qualify. `skipped_jobs` counts job records with a status Foreman does not know; they are ignored, not an error.

### The agent icon

Issue #1311. `GET /api/v1/agent-icon/{agent}` serves the icon of one agent: the file `<state root>/agent-icons/<agent>.svg`. The repository holds no logo (it is public); the homeowner places the files on Tower. The `{agent}` in the request is looked up in the configured agent ids only and is never joined to a directory, so `..`, an empty name, a name with a slash or an unconfigured agent answer 404 with the code `not_found`, as does a missing file. The file is read on each request (the route and the liveboard model); there is no timer and no stored copy.

A file is acceptable only when the pure check `supervisor/agenticon.mjs` passes it: at most 20,000 bytes; an `svg` root element; no `script` element, no `foreignObject` element (a namespace prefix does not hide either), no `set` or `animate` element that writes an `href` or an `on` attribute, no attribute whose name begins with `on`, no entity declaration, no processing instruction other than the leading xml declaration, no DOCTYPE with a `SYSTEM` or `PUBLIC` identifier, no character reference (`&#`), no reference (`href`, `xlink:href`, `url(...)`) to anything but a fragment inside the same file, and no `style` element (prefixed or not) with an `@import`, a `url` or a backslash escape (a `style` attribute with an `@import` or a backslash is refused too). An unacceptable file answers 404 and the reason is logged once per change of that file. An accepted file is answered as `image/svg+xml` with `cache-control: no-cache`, `x-content-type-options: nosniff` and `content-security-policy: default-src 'none'; style-src 'none'; sandbox`.

**How to add an icon.** Save one SVG file per agent in the `agent-icons` folder under the state root, named after the agent id with the `.svg` extension (for example `claude.svg` and `codex.svg`). Each must be a single colour shape on a transparent background, because the screen uses it as a mask and paints it in the job type colour. The liveboard model then gives that agent an `icon` path; without a file it gives `null`.

### The box table

The first row that matches wins. A review's verdict is the one recorded on its own job when it was ingested; for older jobs without one, the first verdict on its pull request recorded after the job started and before the next review job of that pull request started.

| Box | A job lands here when |
| --- | --- |
| `merged` | a review with verdict PASS whose pull request has since merged |
| `needs_you` | its issue or pull request (an issue counts as its pull request once one exists) is named in the current Needs you list |
| `passed` | a review with verdict PASS, not yet merged |
| `changes_asked` | a review with verdict CHANGES |
| `out_of_allowance` | the job is paused for a usage limit |
| `failed` | the job failed or was blocked |
| `stopped` | the job was stopped or paused by hand |
| `to_review` | an implement, continue, fix, cifix, rebase or split job that completed |
| `done` | any other completed job, for example an Inbox job |

`laps` is the number of earlier jobs for the same issue or pull request that started inside the last 7 days and whose box was `changes_asked`, `failed` or `out_of_allowance`. The lap count applies the table without its `needs_you` row, so naming the item in Needs you does not remove its laps.

## Schema subset

`validate.mjs` has no imports and supports only `$ref` (same file, and other files by `$id`), `allOf`, `anyOf`, `type` (one or a list), `enum`, `const`, `required`, `properties`, `additionalProperties`, `items`, `minimum`, `maximum`, `pattern` and `format: date-time` (UTC, ending in `Z`). It returns a list of strings, each starting with the path of the fault. Schemas must stay inside this subset.

## Wiring

`supervisor/dashserver.mjs` wraps its request handler with `withApi` (`supervisor/api/dashwire.mjs`). The router checks the Host and the method itself so that a POST to `/api/v1/` that no route module declares gets a JSON 405 and not the dashboard's plain-text one; every other path reaches the unchanged handler. For tests, `DEVTEST_API_DIR` names a folder holding `models/`, `routes/` and `schemas/` in place of the package's own.
