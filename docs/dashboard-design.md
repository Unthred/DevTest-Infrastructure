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

## Polish (issue #58)
- **Resizing:** every movable card has handles on all four edges and corners (arrow keys on the corner grip). The real content reflows live. Width snaps to grid columns (12 desktop, 6 tablet), height to 40 px steps. Limits per card type are in `CARD_LIMITS` (`logic.mjs`): panels 3-12 columns, KPI tiles 2-4, charts 4-12, queues 3-12. A saved height is a `min-height`, so content is never clipped. KPI tiles and charts have no height handles: their height is their content (charts scale with width). Dragging the west or north edge outward grows the card; the grid keeps its order. Not offered on a phone.
- **Sizing:** no fixed card heights or inner scrolls at default size. Cards in a row stretch to equal height (Overview); list pages (`.cards.fit`) let each card fit its content. KPI tiles share one shape. Charts take the full card width.
- **Back:** every page except Overview has a breadcrumb (Overview › Work › PR #41) and a Back control. Back uses browser history when the previous page was this dashboard, else links to the parent. Filters, sort and page are in the URL; scroll position is kept per address in `sessionStorage` and restored on back/forward and after the periodic refresh.
- **Scrollbars:** standard `scrollbar-width:thin` and `scrollbar-color`, transparent until hover, focus or scrolling (`.is-scrolling`); touch devices keep a thin indicator. Bars are not removed. They take a few pixels of layout, so they are thin rather than true overlay.
- **Dockable navigation:** top, bottom, left or right, by dragging the grip at the nav's edge or the Nav buttons in the status bar; saved per breakpoint (`dash.dock.<bp>`). Left and right show a vertical rail with a collapse toggle (icons only when collapsed). A phone always keeps the bottom tab bar. `static/early.js` applies the saved dock before first paint.
- **Version badge:** installed is the commit the `current` link points at (so manual upgrades show at once); main comes from the upgrade records, and no drift is claimed if the link moved after the newest record. A server loaded from an older `versions/<sha>` than the link shows "restart needed". Restarting the server on upgrade is still #57.
