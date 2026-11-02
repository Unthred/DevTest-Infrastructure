# House style (issue #63)

Status: **integration blocked on homeowner selection.** Nothing in the dashboard changes yet.

## Where the kit lives
Decided by the homeowner on issue #63: a separate repository, `Unthred/house-style`, consumed by DevTest-Infrastructure, AI-Rules and the dashboard. Kit work (icon candidates, tokens, structure) is tracked in `Unthred/house-style#1`. At the time of writing that repository holds only a README and no candidates.

## Source tokens (from SquigOS `docs/design/branding/accepted-brand.json`)
- Gradient, independent, 0deg: `#EE3A4C` 0%, `#80CEFF` 26%, `#B624EB` 66%, `#71B7F4` 100%. It runs once across the mark and restarts once across the whole word (not per letter).
- Wordmark: `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`, weight 600, letter-spacing -0.02em.
- Primary horizontal lockup: Candidate A. Compact mark: Candidate C.

## Remaining work in this repository (after selection)
1. Take the selected DevTest lockup and compact mark from a tagged release of `Unthred/house-style`; do not copy unversioned files.
2. Dashboard header (`supervisor/dashrender.mjs` `statusBar`, currently an icon plus text "DevTest team") uses the lockup, with the compact mark at phone width, matching the SquigOS header treatment.
3. Page `<title>`, favicons, ICO and apple-touch-icon replace the current `data:,` icon link; extend the tests that pin the page head.
4. Forced-colours and monochrome variants come from the kit.

## Not done, and why
- Three DevTest mark candidates need the homeowner's choice (SquigOS #94 process); they belong in `Unthred/house-style`.
- The "all UIs use the house-style kit" rule belongs in the AI-Rules shared policy (another repository, outside this task's scope).
