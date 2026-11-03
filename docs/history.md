# Foreman history retention (issue #362)

Foreman keeps its activity history and never deletes it automatically.

| Data | Where it lives | What changed |
|---|---|---|
| Tick snapshots | `dashboard/snapshots.jsonl` (last 35 days), then `dashboard/archive/snapshots-YYYY-MM.jsonl.gz` | Old snapshots rotate into the archive instead of being dropped; the 12,000-snapshot cap is gone. |
| Timeline | `dashboard/archive/timeline.jsonl` | Allowlisted, redacted, deduplicated entries (jobs, reviews, merges, rebases, unblocks, migrations), written by every tick. |
| Merge log, unblock log | newest 500 / 200 in `team/state.json`; overflow in `team/archive/*.jsonl` | The overflow is appended to the archive, not dropped. |
| Verdicts | `team/state.json` | A verdict is copied to the timeline before it is replaced or deleted. |
| Job records, events | `jobs/`, `events/` | Never pruned; counted in the storage report. |
| Raw tick log | `reconcile.log`, older lines in `reconcile.log.archive.gz` | The generated cron script appends the cut lines to the archive (reinstall the User Script to get this). |

`ai-supervisor history backfill [--github]` fills the timeline from existing job records, events, verdicts and the merge log; `--github` also reads merged pull requests (one read-only `gh pr list`). It is safe to repeat. `history status` prints the storage report.

The dashboard reads these files only: the Activity timeline (`/activity/timeline`) has pagination, sortable columns, filters and links to the issue or PR; the all-time chart range (`range=all`) reads the archive. Known gaps (no stored tick data) are listed plainly and never filled in. Storage use, growth per day and a warning (low free space, or free space lasting under 180 days) show on the timeline page and as a Needs you item.
