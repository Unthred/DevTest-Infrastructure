# Dependency declaration format

State prerequisites only on one standalone line: `Depends on: #12, #15`.

If an issue has no prerequisites, omit the line entirely. Do not write `Depends on: none`, put the declaration in a sentence, quote it as a title, repeat it, place it in inline code, or name the issue itself.

Foreman holds malformed declarations rather than guessing.
