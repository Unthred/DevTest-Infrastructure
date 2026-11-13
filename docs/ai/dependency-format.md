# Dependency declaration format

State prerequisites only on one standalone line: `Depends on: #12, #15`.

If an issue has no prerequisites, omit the line entirely. Do not write `Depends on: none`, put the declaration in a sentence, quote it as a title, repeat it, place it in inline code, or name the issue itself.

Foreman holds malformed declarations rather than guessing.

An example of the syntax written in prose must go in backticks. Foreman ignores text in backticks; the same words outside backticks and inside a sentence are read as a declaration, so the issue is held and a Needs you item is raised. Bold around the words, as in `**Depends on**: #5`, is accepted on a standalone line and held inside a sentence.
