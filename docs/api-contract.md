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
| `GET /api/v1/meta` | 200, the meta model: loaded models, the state vocabulary, commands and events (both empty for now) |
| `GET /api/v1/schemas/NAME` | 200, a schema file, only if `NAME` is exactly a file name in `supervisor/api/schemas/` as listed at start; otherwise 404 |
| any other path under `/api/v1/` | 404, error code `not_found` |
| a method other than GET or HEAD | 405, error code `method_not_allowed` |
| a Host the dashboard does not serve | 421, error code `unexpected_host` |

HEAD answers with the same headers and no body.

## Shared definitions

`supervisor/api/schemas/common.schema.json` defines `timestamp`, `condition` (state, attention, reason_code, reason_text, since; attention is `none`, `homeowner`, `fault` or `unknown`), `ref` (kind, key, label, title, source, project, url), `action` (command, input, enabled, tier, reversible, refusal_code, refusal_text; tier is `direct`, `approval` or `person_only`), `freshness` and `envelope`.

## Adding a model

1. Add `supervisor/api/models/<name>.mjs` exporting `name`, `path` (the part after `/api/v1/`), `schema` (the file name of its schema) and a pure `build(view, context)` that returns the `data` object. The context holds `now` (ms), `coreVersion` and `models` (the loaded modules). Optionally export `usesView = false` when the model needs no dashboard view, so the router does not prepare one.
2. Add `supervisor/api/schemas/<name>.schema.json`, using `allOf` with `common.schema.json#/$defs/envelope` as `meta.schema.json` does.
3. Add a test that fetches it through the dashboard handler and checks the reply with `supervisor/api/validate.mjs`.

The router lists `models/` and `schemas/` when the dashboard handler is created, so no router file changes. A module without the four exports is skipped and logged.

## Schema subset

`validate.mjs` has no imports and supports only `$ref` (same file, and other files by `$id`), `allOf`, `anyOf`, `type` (one or a list), `enum`, `const`, `required`, `properties`, `additionalProperties`, `items`, `minimum`, `maximum`, `pattern` and `format: date-time` (UTC, ending in `Z`). It returns a list of strings, each starting with the path of the fault. Schemas must stay inside this subset.

## Wiring

`supervisor/dashserver.mjs` wraps its request handler with `withApi` (`supervisor/api/dashwire.mjs`). The router checks the Host and the method itself so that a POST to `/api/v1/` gets a JSON 405 and not the dashboard's plain-text one; every other path reaches the unchanged handler. For tests, `DEVTEST_API_DIR` names a folder holding `models/` and `schemas/` in place of the package's own.
