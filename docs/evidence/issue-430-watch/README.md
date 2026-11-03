# Issue #430 — Watching card screenshots

Captured on Tower with `tests/dashboard-visual.mjs` at head 3e65098 plus main (merge), against a synthetic state with three watched items. Light theme; Overview with the one-row app bar, at 1440 px and 390 px.

The harness reported exit 10 ("problems") for each capture run; the images were still written and show the Watching card (seven steps, one sentence with head and blocker, Pin/Stop watching) at the top of Overview.

Note: these two images are the retained evidence for the Watching card layout. They were captured before two later text fixes (a duplicated title, and the sentence saying "no review yet" when changes were requested); the card structure, seven steps and one-row app bar they show are unchanged.
