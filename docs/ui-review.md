# UI/UX review capability (issue #455)

A reusable way to review a running web UI from captured screenshots. It runs as ordinary Foreman issues: no new agent, plugin, MCP server or permanent process.

## The skill
`.agents/skills/ui-ux-review/` (`SKILL.md` and `references/`) is the single source. Codex discovers repository skills there. Claude discovers `.claude/skills/ui-ux-review`, a **relative symlink** (`../../.agents/skills/ui-ux-review`) to the same directory, so there is one copy. `node tools/validate-project.mjs` (check `skills`) fails when the link is missing, a copy, absolute, or aimed elsewhere, or when a skill lacks front matter that matches its folder name. Modes: audit (report only), batch (approved finding IDs only), verify (a reviewer rebuilds the evidence).

## Tools it uses
- `dev-test web screenshot` / `dev-test web responsive` for evidence (network-less runner, [browser-runner.md](browser-runner.md)).
- `dev-test web a11y --url <file-url> --profiles <list>`: axe-core, WCAG 2.1 A and AA tags, from the pinned, integrity-checked cache. It reports violations and incomplete results and states that automated checks do not cover everything. One-time setup: `node browser/prepare-cache.mjs && node browser/restore-cache.mjs` (the restore must be re-run once after axe-core was added to the lock).
- `tests/dashboard-visual.mjs <screenshot-dir> [pages]` for this dashboard (Tower only; the page list comes from the dashboard routes).

## Evidence
Evidence stays out of Git (D-005): `<evidence root>/ui-review/<run>/` with `report.md`, `manifest.json`, PNG files and optional `before/` and `after/` folders. Browse it at `/evidence` on the dashboard ([dashboard.md](dashboard.md)).
