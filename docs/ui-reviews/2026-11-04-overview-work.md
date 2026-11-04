# UI/UX review: Foreman dashboard, Overview and Work pages, 2026-11-04

- **Commit:** f28d175 (main) with this branch's docs only
- **Data source:** copy of real supervisor state (read-only copy of `dashboard`, `jobs`, `team`, `events`, `leases`, `job-locks`; the write token and cooldown file were left out), served by the dashboard's own request handler on a host Unix socket to the network-less Playwright container. The only harness change is that the handler's Host header is pinned, because the container's loopback port is random. No application code was changed, nothing was written to production.
- **Evidence directory:** `/mnt/cache/appdata/devtest-infrastructure/evidence/ui-review/20261104-overview-work/` (browse at `/evidence/20261104-overview-work` on the dashboard). Sub-folders: `walk/` (click-through, desktop-1440 and phone-390, PNG + page text + `walk-*.json`), `walk2/` (task paths, tablet-768, dark theme), `audit/` (layout check and axe, WCAG 2.1 A/AA, desktop-1440 and phone-390, light and dark). `manifest.json` and `report.md` are in the run folder.
- **Scope:** Overview, Work, and every drill-down reachable from them to two or three levels: PR, issue, job, Agents, agent, Supervisor, Tick history, Activity, Timeline, System, UI review evidence, review run. Profiles `desktop-1440`, `phone-390`, `tablet-768` (Overview only), dark theme on Overview and Work.
- **Not covered:** empty, loading and error states (the state copy is fully populated; no error page was reached). Dark and tablet captures exist but were not opened, only the light desktop and phone ones were judged by eye; dark-theme contrast comes from axe only. Keyboard and reduced-motion checks were not done. Firefox and WebKit not run. Automated checks do not cover everything; nothing here is visual acceptance.

## Summary
- The page header is the biggest fault: at 1440 it squeezes the page title and breadcrumb into a 43 to 65 px column on every drill-down page, and on the phone it fills most of the first screen. The "Needs you" detail sits fifth on a 15,500 px Overview.
- Breadcrumbs are consistent between click-through and direct load; the faults are layout (squeezed, very tall) and one page (Supervisor) that lacks the current item.
- First batch: B1 (header), then B2 (Overview order and PR links).

| Class | High | Medium | Low |
|---|---|---|---|
| Functional | 1 | 2 | 1 |
| Usability | 3 | 3 | 1 |
| Accessibility | 1 | 0 | 0 |
| Aesthetic | 0 | 0 | 1 |

Twelve findings are numbered below (UX-12 is in the breadcrumb section). Breadcrumb findings are UX-01, UX-07, UX-08, UX-11 and UX-12.

## Findings, highest priority first

### UX-01: Header squeezes the page title and breadcrumb on every drill-down at 1440
- **Class / priority:** functional / high
- **Where:** `/work`, `/work/pr/468`, `/work/issue/243`, `/work/job/328bd173`, supervisor pages; desktop-1440 (not phone, not tablet)
- **Evidence:** `walk/c-path-03-pr-detail-desktop-1440.png`, `walk/c-path-02-work-desktop-1440.png`, `walk2/b-needs-03-from-needs-card-light-desktop-1440.png`, `audit/audit-desktop-1440+phone-390.json` (h1 `truncated`, clientWidth 43 while scrollWidth 479 to 678) (observed)
- **Why it matters:** the title reads "PR⋯" or "#2⋯", the Back button, two crumbs and the title stack into a column about 65 px wide, and the header is 287 px tall on a PR page (145 px on Work). On Work the "Overview ›" separator sits against the Needs-you pill. The task "which page am I on" is answered only by the nav tab.
- **Relation to #447:** the same root cause (the status bar has more items than 1440 px fits, so the page-head flex item shrinks to its minimum), a different symptom. The #447 symptom, breadcrumb links covered by the header logo, was **not reproduced** here: no crumb link was covered at its centre in any of 28 steps (`covered` is false throughout `walk/walk-desktop-1440.json`). Here the logo is left of the Back button and nothing covers a link; the crumb is squeezed and abuts the pill. One fix to the status bar layout should clear both; verify #447's symptom again after it.
- **Suggested change:** let the page head wrap onto its own row below the status pills from tablet width up (as the phone layout already does), or move the status pills to a second row.
- **Effort / risk:** M; every page uses the header, so run the responsive audit on all pages.
- **Shared fix:** `.statusbar` and `.pagehead` in `supervisor/dashui/style.css`; clears UX-02, UX-09 and most of UX-10's header targets.

### UX-02: Overview overflows horizontally at 1440, and header links are too small
- **Class / priority:** functional / medium
- **Where:** Overview, desktop-1440, both themes
- **Evidence:** `audit/audit-desktop-1440+phone-390.json` (document-overflow 1450 vs 1440; theme button 1406 to 1450 off-screen; header links 149x23 and 78x23 `target-too-small`, also on Work and detail pages) (observed)
- **Why it matters:** a sideways scrollbar and a theme button partly off-screen on the main page.
- **Suggested change:** same fix as UX-01; give the nav links a 24 px minimum height.
- **Effort / risk:** S with UX-01.
- **Shared fix:** status bar.

### UX-03: "Needs you" is buried; the Overview is 15,500 px tall
- **Class / priority:** usability / high
- **Where:** Overview, both profiles
- **Evidence:** `walk/a-needs-01-overview-desktop-1440.png`, `walk/a-needs-01-overview-desktop-1440.txt` (card order: Watching, Since you were last here, Now, Next, Needs you, Later (67), Warnings, charts; scroll height 15,521) (observed)
- **Why it matters:** the first screen shows an empty "Watching" card and a 13,659-character, 140-link "Since you were last here" list. "What needs me" and "what is it doing now / next" are the 4th to 5th cards, below the fold. The header pill "Needs you (4)" is the only early signal and it goes to System (`/system#att-homeowner-243`), not to the Overview card.
- **Suggested change:** order Needs you, Now, Next first; collapse "Since you were last here" to counts with a link; hide "Watching" when empty.
- **Effort / risk:** S to M; the saved card layout is per viewer, so a stored order may keep the old order (check).
- **Shared fix:** card order and default-collapsed state in the Overview render.

### UX-04: PRs on the Overview open GitHub, not the dashboard's own detail
- **Class / priority:** usability / high
- **Where:** Overview, "Since you were last here" lists (191 GitHub links, two internal `/work/pr/` links, both in Needs you)
- **Evidence:** `walk2/walk2-light-desktop-1440-paths.json` (`sincePrLink` is the GitHub URL with no target or rel; `innerPrLinksOnOverview` is only `att-fixlimit-475` and `att-fixlimit-468`) (observed)
- **Why it matters:** task "find one PR from the Overview, open its detail, return" ends on github.com, outside the dashboard (the review runner blocks it), and the dashboard's PR page (verdict history, rounds, tokens, jobs) is reached only through Work, two clicks away. Return is the browser's Back only.
- **Suggested change:** link PR and issue rows to `/work/pr/N` and `/work/issue/N`, with a small "GitHub" link beside it.
- **Effort / risk:** S; the detail pages already exist.
- **Shared fix:** the shared item-reference renderer.

### UX-05: A blocked issue's page does not say why or what to do
- **Class / priority:** usability / high
- **Where:** `/work/issue/243` (needs the homeowner)
- **Evidence:** `walk2/b-needs-03-from-needs-card-light-desktop-1440.png` and its `.txt`; compare the Needs-you card text in `walk/walk-desktop-1440.json` ("Tried: Foreman applied the needs-homeowner label ... fix the cause or close the issue?") (observed)
- **Why it matters:** the task "why is this issue not being worked on" works for dependency blocks (Work page lists blockers) but for a homeowner hold the issue page shows only "Status: needs the homeowner / Needs homeowner: Yes" and "Assigned to –". The reason lives in the Overview card and the "Later" card.
- **Suggested change:** show the same Waits / Tried / Ends lines on the issue page; say "not assigned" plainly.
- **Effort / risk:** S to M.
- **Shared fix:** reuse the attention-item and Later-item renderer.

### UX-06: The same issues are listed three times on Work
- **Class / priority:** usability / medium
- **Where:** Work: Queue cards, Issues table, "Excluded issues (80)"
- **Evidence:** `walk/walk-desktop-1440.json` Work text; `walk/c-path-02-work-desktop-1440.png` (#9, #13, #14 appear in a queue and, with their blockers, in the Issues and Excluded lists) (observed)
- **Why it matters:** the page is 10,600 px tall; the blocked reason is repeated in full each time ("blocked by #7 07 - OpenBao ..., #8 08 ...").
- **Suggested change:** one issue table with a reason column and filters (the table already has sort and filter); keep Queue cards as the "will do next" view.
- **Effort / risk:** M.
- **Shared fix:** the Work issue table.

### UX-07: Detail pages repeat the title four times, and the breadcrumb carries it all
- **Class / priority:** usability / medium
- **Where:** PR, issue, job pages
- **Evidence:** `walk/c-path-03-pr-detail-desktop-1440.png`, `walk/c-path-03-pr-detail-phone-390.png`, `walk/walk-desktop-1440.json` (crumb bar 188 px tall on a PR, 226 px on a job; the Back button is the same target as the last link crumb) (observed)
- **Why it matters:** the full title is in the breadcrumb, the page heading, the first card title and the "On GitHub" link; the Back button repeats the parent crumb. On the phone the PR title takes 12 lines of the first two screens.
- **Suggested change:** crumb ends in "PR #468" only; keep the title in the card; keep one of Back or the crumb trail on phone.
- **Effort / risk:** S.
- **Shared fix:** `trail()` and the page-head markup.

### UX-08: The Supervisor page's breadcrumb has no current-page item
- **Class / priority:** functional / low
- **Where:** `/supervisor` (both profiles, click and direct load)
- **Evidence:** `walk/walk-desktop-1440.json` (`g-supervisor-16`: crumbs `Overview` only); `supervisor/dashrender.mjs` `trail()` (observed; cause inferred)
- **Why it matters:** every other top-level page shows "Overview › <Page>". Same result clicked or direct, so it is a content fault, not a navigation one.
- **Suggested change:** emit the current item for this page.
- **Effort / risk:** S.
- **Shared fix:** `trail()`.

### UX-09: The header says Data "Stale" while Warnings says there is nothing stale
- **Class / priority:** functional / medium
- **Where:** Overview
- **Evidence:** `walk/a-needs-01-overview-desktop-1440.txt` (header "Data Stale"; Warnings card: "No warnings. No stalls, stale data or version drift"; data age 15 m) (observed; the two rules differ is inferred)
- **Why it matters:** two indicators on one page disagree, so neither can be trusted.
- **Suggested change:** one freshness rule feeding both.
- **Effort / risk:** S to M.
- **Shared fix:** the freshness helper used by the status bar and Warnings.

### UX-10: axe finds serious violations on every audited page
- **Class / priority:** accessibility / high
- **Where:** Overview, Work, PR, job, issue, Supervisor; both themes, both profiles
- **Evidence:** `audit/audit-desktop-1440+phone-390.json` (`label-content-name-mismatch` serious on all pages, 2 to 8 nodes; `color-contrast` serious on Work, PR and Supervisor, 2 nodes; `scrollable-region-focusable` on Overview; 19 to 49 contrast checks incomplete) (observed)
- **Why it matters:** controls whose accessible name does not contain their visible text (likely the agent badges, whose `aria-label` is "claude · 2 jobs · Running" against a different visible string) fail voice control; an unreachable scroll region fails keyboard users.
- **Suggested change:** start each `aria-label` with the visible text; make the scroll region focusable; fix the two contrast pairs.
- **Effort / risk:** S to M.
- **Shared fix:** the badge component.

### UX-11: Breadcrumb and header targets are small on the phone; crumb height varies
- **Class / priority:** usability / medium
- **Where:** phone-390 all pages (198 to 240 `target-below-44` notes on Overview and Work), crumb links 24 px high and 28 to 50 px wide
- **Evidence:** `audit/audit-desktop-1440+phone-390.json`, `walk/c-path-03-pr-detail-phone-390.png` (observed)
- **Why it matters:** hard to tap with one hand.
- **Suggested change:** 44 px minimum on the Back button, crumbs and header pills.
- **Effort / risk:** S; check wrapping.
- **Shared fix:** `.crumbs a`, `.btn`, `.pill`.

## Further findings by theme (not itemised, limit not reached)
- Aesthetic, low: phone bottom navigation crowds "Usage & cost" against "Reviews" (`walk/a-needs-01-overview-phone-390.png`); the phone header puts one status pill per row and takes about 590 of 844 px of the first Overview screen, 470 on a PR page (observed). Both belong in batch B1.

## Breadcrumbs and navigation
Walked by clicking from the Overview, 28 steps on each profile, then a direct load of each URL visited (`walk/walk-*.json`, `direct` array).

| Path (clicked) | Levels | Breadcrumb used | Browser back |
|---|---|---|---|
| Overview > Work > PR 468 | 2 | Work, then Overview | back, back: Work, then PR (correct) |
| Overview > job 328bd173 | 1 | Work | back returns to the job |
| Overview > Agents > claude > job ffc2996b | 3 | Work | back returns to the job |
| Overview > Supervisor > Tick history | 2 | Overview | back returns to ticks |
| Overview > Activity > Timeline | 2 | Overview | same |
| Overview > System > UI review evidence > run | 3 | Overview | same |

- **Click-through vs direct load:** title, heading, Back target, crumb text, order and link targets were identical on all 28 steps at both profiles. The only difference found is the Overview address: the crumb link is `/` but the page rewrites it to `/?range=7d` on load, so the address differs from the link (UX-12 below, low).
- **Cross-area path:** Overview > Agents > claude > a Work job: the crumb for the job is "Overview > Work > job", not "Agents", so the trail does not return to the area you came from; the crumb "Work" leads to the Work page, and browser back returns to the agent page. Correct but not symmetrical.
- **Wrapping and overlap:** at 1440 the crumb bar is 47 px on Work, 75 to 94 px on level-2 pages, 154 to 226 px on PR, job and run pages (UX-01, UX-07). No link was covered by the header logo (see UX-01 for #447). At 390 the bar wraps to 66 px on PR and job pages.
- **UX-12 (low, usability):** crumb "Overview" lands on `/?range=7d` rather than `/` (`walk/walk-desktop-1440.json`). Harmless, but a bookmark of the crumb differs from the address bar.

## Keep as it is
- The Now / Next cards ("Nothing is planned because: claude is busy with a running job") answer "what next" in words.
- Blocker lists with links on Work and issue pages; "Done / Blocking" dependency chips.
- The sortable, filterable, paginated tables (house standard).
- Header pill links that go to the page that explains them.
- The breadcrumb behaviour in the click-through: same trail, same targets, back works.
- Evidence: no console errors, no blocked requests in 56 click steps.

## Information
| Page | Item | Supports which decision or action | Keep, summarise, move or remove |
|---|---|---|---|
| Overview | Needs you (4) card | what to do now | move to the top |
| Overview | Now / Next | what is happening and what will happen | keep, move up |
| Overview | Since you were last here (140 links) | catch up | summarise (counts + link) |
| Overview | Watching (empty) | follow a change | remove when empty |
| Overview | Later (67) | why an issue waits | keep, link each to its issue page |
| Overview | Warnings | stalls and drift | keep, fix contradiction (UX-09) |
| Overview | Allowance, Jobs per day charts | capacity | move to Usage |
| Work | Queue cards | what runs next | keep |
| Work | Issues table, Excluded (80) | find an issue and its reason | merge into one table |
| Work | Pull requests table | find a PR and its verdict | keep |
| PR page | Facts, Timeline, Verdict history, Jobs | judge a PR | keep; shorten title use |
| Issue page | Facts, Dependencies | why not worked on | add reason (UX-05) |
| Job page | Title, facts | what a job did | keep |

## Duplication
| Fact | Where it appears | Which place should own it |
|---|---|---|
| Needs-you items | Overview card, System "All attention items", header pill | Overview card; pill and System link to it |
| Blocker list of an issue | Queue card, Issues table, Excluded list, issue page | issue table row + issue page |
| Item title | breadcrumb, heading, card title, GitHub link (PR/issue/job pages) | card title only |
| Back target | Back button and last link crumb | one of them |
| "Next: none" | header and Next card | Next card |
| Number in name ("#13 13 —") | every issue title | strip in the title renderer |

## Standardisation
| Element | Variants and where | Adopt |
|---|---|---|
| PR/issue link | GitHub on Overview lists, dashboard page on Work | dashboard page, GitHub secondary |
| Item name | "PR #468 Dashboard...", "#13 13 — ...", "Implementer · implement · #456 ..." for jobs | one `kind #n title` form |
| Status | badge in header, plain text on issue page ("needs the homeowner", "open") | badge |
| Breadcrumb | current item present except Supervisor | always present |
| Time | "10m ago" and "2026-11-03 21:40 UTC" mixed on PR page | relative with absolute on hover |
| Truncation | "…" cuts the number-bearing end of long titles | cut mid-title, keep the number |

## Drill-down
| Summary | Detail | Back works | Problem |
|---|---|---|---|
| Overview PR row | GitHub | n/a (leaves) | UX-04 |
| Overview Needs you card | issue / PR / job page | yes | issue page lacks reason (UX-05) |
| Overview header pill | System anchor | yes | lands on a list the Overview also has |
| Work PR row | PR page | yes | none |
| Work issue row | issue page | yes | duplicate listings (UX-06) |
| Agents > agent | job page | crumb goes to Work, not Agents | trail changes area |
| System > evidence > run | run page | yes | none |

## Task walkthrough
| Task | Clicks | Page changes | Friction |
|---|---|---|---|
| See what needs me and what to do | 0 to scroll 4 cards, or 1 (pill) or 1 (card link) | Overview, then issue or System | card is below the fold; pill goes to System; issue page lacks the reason |
| See what the system is doing and will do next | 0 | Overview | Now/Next are cards 3 and 4; scroll past Since-last-here |
| Find a PR from the Overview, open detail, return | 2 (Work, PR) | Overview > Work > PR; return crumb or back | Overview rows go to GitHub (UX-04) |
| Find why an issue is not worked on | 2 (Work, issue) or 1 (Needs-you / Later card) | Work > issue | homeowner holds lack the reason on the issue page (UX-05) |

## Proposed batches (none implemented)
| Batch | Finding IDs | Area | Regression checks |
|---|---|---|---|
| B1 | UX-01, UX-02, UX-11, aesthetic theme | status bar and page head | responsive audit at 8 widths on all pages, axe, re-check #447 |
| B2 | UX-03, UX-04 | Overview card order, PR/issue links | saved card layout, Since-last-here copy button, link tests |
| B3 | UX-05, UX-07, UX-08, UX-06 | detail pages, Work list | breadcrumb tests, issue page for each status |
| B4 | UX-09, UX-10 | freshness rule, badge names, contrast | axe on Overview, Work, PR, Supervisor |

## Functional faults for separate issues
UX-01 (squeezed page head, may be fixed under #447), UX-02 (Overview overflow), UX-08 (Supervisor crumb), UX-09 (Stale vs No warnings).

## Cost of this trial
- Images opened: 7, each once (desktop-1440: Overview, Work, PR page, issue 243; phone-390: Overview, PR page; tablet-768: Overview). Images reused from an earlier run: 0 (no earlier manifest existed). Images captured: about 140 in the evidence folder; most were judged from the page text and JSON files instead.
- Tokens used: not measurable from inside the session; the dispatcher's job record for this issue holds the figure.
- Browser runs: 8 container runs, one at a time, niced; one needed `node browser/prepare-cache.mjs` (the vendored packages were absent from this worktree; integrity-checked against the lock).

## Approval
Approve by finding ID. Nothing is implemented until approved.
