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
| implement or continue job, event `blocked`, `crash`, `incomplete`, `retry_exhausted` or `auth_error` | implement bounced |
| review verdict PASS | review passed |
| review verdict CHANGES | review bounced |
| cifix job, event `created` (one per job) | ci bounced |
| rebase entry (a completed rebase) | rebase passed |
| rebase job, event `blocked` | rebase bounced |
| merge entry | merge passed |

Every other entry (a fix or review job, a started or created event, an unknown job kind) is not a step and is ignored. A completed rebase job is not counted again: its rebase entry is the step.

- `laps` is the number of bounced steps followed by a later step in the window.
- `bin` is decided in this order: `merged` (has a merge step), `needs_you` (the current Needs you list names the issue or pull request), `failed` (the last step is bounced and nothing followed), else `moving`.
- `title` is the dashboard view's title, or null when it does not know the item.
- The reply carries `window` (`hours`, `start`, `end`), `counts` per bin over every qualifying item, `truncated` (true when more than 200 items qualify) and `items`: the 200 most recently active, newest first.
- **Install is not a peg.** Foreman records no install event per pull request, so the model cannot place one without inventing it. A later item may add it when such an event exists.

## Schema subset

`validate.mjs` has no imports and supports only `$ref` (same file, and other files by `$id`), `allOf`, `anyOf`, `type` (one or a list), `enum`, `const`, `required`, `properties`, `additionalProperties`, `items`, `minimum`, `maximum`, `pattern` and `format: date-time` (UTC, ending in `Z`). It returns a list of strings, each starting with the path of the fault. Schemas must stay inside this subset.

## Wiring

`supervisor/dashserver.mjs` wraps its request handler with `withApi` (`supervisor/api/dashwire.mjs`). The router checks the Host and the method itself so that a POST to `/api/v1/` that no route module declares gets a JSON 405 and not the dashboard's plain-text one; every other path reaches the unchanged handler. For tests, `DEVTEST_API_DIR` names a folder holding `models/`, `routes/` and `schemas/` in place of the package's own.
