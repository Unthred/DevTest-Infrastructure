# Files line format

An item (issue or inbox issue draft) names the files it will edit on one standalone line: `Files: supervisor/a.mjs, tests/a.test.mjs`.

- Name only files the item edits, tests and docs included. Do not name a file to say it must be left alone, or one that is only read or mentioned.
- Paths only: repository-relative, comma separated, no globs, no `..`, at most 8 paths, and one Files line per item.
- When the line is present it alone defines the item's expected files; prose is not scanned.
- When it is absent Foreman reads the paths named in the title and body, but ignores a path that appears only in a sentence containing avoid, not, never or except.
- Draft validation refuses a malformed Files line (more than 8 paths, a glob, an empty entry, a second line) with the reason.

What Foreman does with it:

- A new implement job is held while a running or planned job, or any open pull request (draft included, merged or closed excluded) of another item, edits one of the expected files. The hold names the item and the pull request by number. The planner skips a held item and takes the next eligible one; the reason is recorded with the other holds.
- A pull request that changes more than 2 files that the item's Files line does not list raises a Needs you item at action severity naming the extra files. Correct the line so the next item is planned from the real list.
