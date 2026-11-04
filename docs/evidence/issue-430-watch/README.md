# Issue #430 — Watching card screenshots

Captured on Tower with `tests/dashboard-visual.mjs` at head 3e65098 plus main (merge), against a synthetic state with three watched items. Light theme; Overview with the one-row app bar, at 1440 px and 390 px.

The harness reported exit 10 ("problems") for each capture run; the images were still written and show the Watching card (seven steps, one sentence with head and blocker, Pin/Stop watching) at the top of Overview.

Note: these two images are the retained evidence for the Watching card layout. They were captured before two later text fixes (a duplicated title, and the sentence saying "no review yet" when changes were requested); the card structure, seven steps and one-row app bar they show are unchanged.

Follow-up (issue #502): a watch-page exit 10 was investigated and reproduced on Tower with a running job. The original Overview runs were not shown to fail for this reason, and one Overview capture later hit an intermittent screenshot timeout waiting for fonts. The harness staged the saved watch page with its live panel on, so the page requested `/api/jobs/<id>/events` from a static directory that has no `/api` routes; the 404 is what the wrapper reports as "problems". `tests/dashboard-visual.mjs` now stages the snapshot with the live stream switched off (`freezeLivePanels`) and prints the wrapper's report summary on any failing capture. The watch pages now capture with exit 0. The images above are unchanged.
