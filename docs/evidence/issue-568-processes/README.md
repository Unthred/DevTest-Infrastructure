# Issue #568 visual evidence: processes card and drill-down

Captured on Tower with `tests/dashboard-visual.mjs` (pinned Chromium container, first screen of each page) against a copy of the live supervisor state, pages `processes` (summary card) and `processes-claude` (agent drill-down), light and dark, at desktop 1440, tablet 768 and phone 390.

Command: `DASH_STATE_COPY=<state copy> DASH_VIEWPORT=1 node tests/dashboard-visual.mjs <dir> processes,processes-claude` (exit 0, "VISUAL CAPTURE OK", all 12 container runs cleaned up).

Images (not committed) are in `/mnt/cache/appdata/devtest-infrastructure/evidence/issue-568-processes/`:
`{light,dark}-processes-{desktop-1440,tablet-768,phone-390}-chromium.png` (summary card) and
`{light,dark}-processes-claude-{desktop-1440,tablet-768,phone-390}-chromium.png` (drill-down).

Observed: the card lists the agent, Unattributed and Tower total rows with processes, memory, swap, jobs, leftovers and history; the age line reads "Read just now" with the 15 s refresh interval; the phone layout stacks each job as a labelled card (kind, PR/issue, processes, memory, swap, age) with no horizontal overflow in the viewed images.
