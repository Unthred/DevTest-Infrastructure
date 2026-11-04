---
name: ui-ux-review
description: Review or improve a running web UI using captured screenshots. Use for a UI audit, UX review, or an approved UI change batch that needs before/after evidence. Do not use for backend work or routine UI bug fixes.
---

# UI/UX review

Judge what the page does when rendered, not what the source suggests.
Keep the application's identity and working behaviour. Recommend changes;
never redesign unasked.

## Pick the mode from the issue
- **audit**: find and report. No application changes.
- **batch**: implement only the finding IDs the homeowner approved.
- **verify** (reviewer): check a batch's evidence and regressions.

## Evidence rules
1. Capture with the project's browser runner (`dev-test web screenshot`,
   `dev-test web responsive`, or the project's visual script). Do not
   install another browser tool or bypass the runner's network limits.
2. Never touch production to get a screenshot. If the app cannot be
   reached, render it from a copy of its state or a fixture, and say
   which in the report.
3. Keep evidence outside Git, in the project's evidence directory. Write
   `manifest.json`: commit, data source, page, state, profile, theme,
   file and SHA-256. Reuse captures whose commit and page files are
   unchanged.
4. Use these profiles: `desktop-1440` and `phone-390` for every page in
   the issue's scope, plus one `tablet-768` page. Use the second theme
   only on the two busiest pages, unless the finding is about theme.
5. Read `.layout.json`, the summary and the accessibility output first.
   Open an image only when you need to judge it. Prefer viewport captures
   to full-page captures, which downscale until text is unreadable.
6. Cover real states where they exist: populated, empty, loading, error
   and the longest realistic text.
7. Walk the issue's main tasks in the browser. Record the clicks and any
   page changes each one takes.

## Audit
Read [checklist.md](references/checklist.md) and
[house-standard.md](references/house-standard.md), then write the report
from [report-template.md](references/report-template.md).

Layout is only part of the review. Build these before judging the pages:
- **Information:** what each page shows, the decision or action it
  supports, and whether to keep, summarise, move or remove it.
- **Duplication:** the same fact shown twice, on one page or across
  pages, and which place should own it.
- **Standardisation:** every name, control, badge, table and date format
  that varies for the same purpose, and the one to adopt.
- **Drill-down:** each path from summary to detail and back, with
  missing, dead-end or repeated levels.

- Every finding names its evidence file. No evidence means no finding.
- Mark each finding **observed** or **inferred**.
- Class: `functional`, `usability`, `accessibility` or `aesthetic`. A
  functional fault also gets its own issue, separate from design work.
- Prefer one fix to a shared component over many page fixes.
- Stop at 15 findings, highest value first. Count the rest by theme.
- List what already works and must not change.
- Put the report in the audit PR. It contains no screenshots.

## Batch
- Change only the approved IDs, and at most one area or shared component.
- Capture before and after from the same data, at the same profiles.
- New visual direction needs homeowner approval first. Only then may the
  `frontend-design` skill be used, with the house standard overriding it.
- Run the project's checks, the responsive audit and the accessibility
  scan on every touched page. List new failures; fix them or stop.
- PR body: IDs done, evidence directory, before/after pairs, checks run,
  and anything left undone.

## Verify
Rebuild the evidence yourself from the PR head and compare it with the
claimed pairs. Each of these is a failed acceptance criterion:
- an approved ID not visibly met
- an unapproved visual change
- a new layout or accessibility failure

Automated checks do not prove good design, so never claim visual
acceptance on the homeowner's behalf.
