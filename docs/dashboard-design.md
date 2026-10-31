# Dashboard v2 design system (issue #54)

Source of truth: `supervisor/dashui/style.css` (tokens at the top). Tests read the tokens and check contrast.

- **Severity** (one scale everywhere): Action needed (red), Warning (amber), Info (blue), OK (green). Every badge carries an icon and a label, never colour alone. Mapping lives in `supervisor/dashui/logic.mjs` (`severityOf`).
- **Colour tokens**: light and dark sets (`:root`, `:root[data-theme=dark]`, and `prefers-color-scheme` when no choice is saved). Severity text on its background and body text meet 4.5:1 (7:1 for body); series colours meet 3:1 against the surface. Claude and Codex have one colour each (`--claude`, `--codex`), used in every chart and tag.
- **Type scale** 12/13/15/18/24/28 px; **spacing** 4/8/12/16/24 px; **radius** 10 px (6 px small); two elevations.
- **Icons**: 24x24 stroke icons drawn for this project, inlined as an SVG sprite. No third-party icon set or UI library is vendored, so nothing needs a digest or licence entry.
- **Components**: status badges, KPI tiles with sparklines, cards (drag handle, move earlier/later, expand, resize), designed empty states, skeleton class, sortable tables with footers and pagination.
- **Motion**: subtle transitions only; `prefers-reduced-motion` turns them off.
- **Breakpoints**: phone < 640 (bottom tab bar, tables become tap-to-expand cards, 44 px targets, reorder only), tablet 640-1099, desktop >= 1100 (Overview fits one screen). Layout is saved per breakpoint in `localStorage` (convenience only).

## Pages
`/` Overview, `/agents`, `/agents/<name>`, `/work`, `/work/pr/<n>`, `/work/issue/<n>`, `/activity`, `/usage`, `/reviews`, `/system`. Table state (`<id>.sort|dir|q|page|size`) and chart range (`range=24h|7d|30d`) are in the URL, so every view is bookmarkable and works without script.

## Security and constraints
Read-only (GET/HEAD), no GitHub or model call on page load, no CDN. CSP: `script-src 'self'` serves only `/static/app.js` and `/static/logic.mjs` (fixed whitelist); no inline script. The script sends nothing anywhere.
