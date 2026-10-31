# Responsive audit (issue #6)

Status: implemented in source on `claude/issue-6-responsive`, **stacked on #27 — do not merge before #27**; independent review pending. It runs on the browser track of [browser-runner.md](browser-runner.md): same pinned image, same `--network=none`, same declared-target boundary, same cleanup.

```
node /src/browser/responsive.mjs --target <name> --path /page.html [--profiles standard|all|a,b,c] \
     [--browser chromium|firefox|webkit] [--wait load|domcontentloaded|networkidle] [--timeout-ms 15000] --name <stem>
```

## Profiles
`standard` is the width ladder from the issue: `phone-360`, `phone-390`, `phone-430`, `tablet-768`, `tablet-1024`, `desktop-1280`, `desktop-1440`, `desktop-1920` (phones/tablets: touch, mobile, DPR 2; desktops: pointer, DPR 1). Variants: `phone-390-landscape`, `tablet-768-landscape`, `tablet-1024-portrait`, `desktop-1280-hidpi` (DPR 2), `desktop-1280-touch`. `all` runs every profile. `phone` and `desktop` keep their #5 meaning for `capture.mjs`.

## What is checked (in a real browser, in the page)
| Check | Fails when |
|---|---|
| `document-overflow` | the document is wider than the viewport (sideways scrolling) |
| `beyond-viewport` | an element extends past the viewport edge outside any `overflow:auto/scroll` container (outermost offender only) |
| `clipped` | an `overflow:hidden/clip` box cuts content off without an ellipsis (cards, titles) |
| `escapes-parent` | a control or `[data-ui]` box sticks out of its parent |
| `target-offscreen` / `target-too-small` / `target-covered` | a link, button, input, select, textarea, summary or `role=button` is outside the viewport, under 24x24 CSS px (WCAG 2.2 2.5.8), or has another element over its centre |
| `chips-wrapped` | a `[data-chips]` row (not `data-chips="wrap"`) wraps onto several lines |
Warnings only: `truncated` (ellipsis) and, on touch profiles, `target-below-44`. A horizontally scrollable row (`overflow-x:auto`) is an intentional scroller and is not a failure.

## Evidence and exit codes
Per profile: `<name>-<profile>-<browser>.png` (full page) and `.layout.json`; overall `<name>.summary.json` (`schema_version` 1) and `<name>.report.md` (concise human report). Exit codes extend the browser track: **15** layout failure or a profile that was not rendered, 12 undeclared destination (outranks), 11 timeout, 13 TLS, 14 launch, 10 page errors, 2 usage, 0 pass.

**No visual acceptance is claimed.** A profile only counts as *rendered* when a real PNG at least viewport x DPR exists; the report states that the checks are layout heuristics, "not that a person has accepted how it looks". There is no pixel or baseline comparison; that would be a later, separately decided feature.

## Fixtures
`browser/fixture/responsive/broken.html` is deliberately broken (700px block, clipped card title, 500px input, 12px button, wrapping chips, overlay over a button); `fixed.html` is the corrected page. `tests/responsive-smoke.mjs` proves the broken page fails at every standard profile with each seeded defect in Chromium, Firefox and WebKit, and the corrected one passes at all eight with PNG widths exactly viewport x DPR.

## Evidence
`node tests/responsive-smoke.mjs` (Tower, real Docker; needs `node browser/prepare-cache.mjs`). Unit tests: `tests/responsive.test.mjs`. Not covered: authenticated or TCP targets (OQ-2, #10), pixel baselines, the `dev-test` CLI (#8).
