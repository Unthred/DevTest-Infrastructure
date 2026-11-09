# Coding Standards: Maintainability and Architecture

Applies to all development work, by people and AI agents, in every repository unless a repository states a stricter rule.

## Primary objective

Produce code that is easy for another developer or AI agent to understand, debug, modify and test.
Optimise for readability and maintainability before cleverness or brevity.

## Architecture

1. Follow SOLID principles pragmatically.
2. Apply Single Responsibility at method, class, module and component level.
3. Keep presentation, business logic and infrastructure separate.
4. Keep decisions separate from actions: logic that decides what should happen is a pure function of its inputs; code that talks to the outside world (network, disk, processes, clocks) carries it out.
5. Prefer feature-based organisation where appropriate.
6. Favour composition over inheritance.
7. Minimise coupling and keep related behaviour together.
8. Follow existing project conventions unless there is a compelling reason to improve them.
9. Avoid unnecessary abstractions, interfaces, factories and architectural layers.

## Code size

Warning thresholds for review:

| Item | Threshold |
|---|---|
| Method or function | 50 lines |
| Class | 400 lines |
| Source file or module | 500 lines |
| Blazor component | 250 lines |
| Constructor dependencies | 7 |
| Method parameters | 6 |
| Line length | 160 characters |

These are warning thresholds, not hard limits. When one is exceeded, assess whether responsibilities should be separated. Do not split code merely to satisfy a number.

**Ratchet rule.** A method, class or file already over a threshold must not grow. New behaviour goes into a new, focused unit. Shrinking existing oversized code happens through planned, authorised extraction work, not as a side effect of feature work.

## Implementation rules

1. Before modifying a feature, inspect its existing architecture and relevant dependencies.
2. Identify the appropriate location for new functionality.
3. Never append unrelated functionality to an existing large class or module because it is convenient.
4. Prefer small, focused methods with descriptive names.
5. One statement per line. Do not pack several conditions, assignments or calls onto one long line.
6. Keep business rules out of UI components.
7. Keep long text (prompts, templates, messages) in their own files or constants, not inline in logic.
8. Avoid duplicated business logic, but do not introduce abstractions for coincidental similarity.
9. Use dependency injection where it provides meaningful decoupling.
10. Keep dependencies explicit.
11. Avoid unnecessary state and hidden side effects.
12. Use comments to explain why something exists, not to narrate obvious code. Issue and decision references belong in commit messages and docs, not as a running log in comments.
13. Remove obsolete code and unused dependencies introduced by the change.
14. Avoid unrelated refactoring unless separately authorised.

## Refactoring

When modifying an oversized or highly coupled component:

1. Identify the responsibilities involved.
2. Determine whether the requested change can be implemented cleanly.
3. If it cannot without growing the component, put the new behaviour in a new unit and propose a focused extraction for the rest.
4. Preserve existing behaviour and public contracts.
5. Add or update tests before risky structural changes.
6. A structural extraction is its own change: move code without changing behaviour, so it is quick to review.
7. Do not perform wholesale rewrites without approval.

## AI-specific requirements

- Do not prioritise the smallest diff over long-term maintainability.
- Do not introduce speculative extensibility.
- Do not create one-off interfaces without a meaningful benefit.
- Do not hide complexity by moving it into generic helper classes.
- Do not silently expand the scope of a task.
- Prefer established language and framework conventions over custom implementations.

## Language notes

**C# and .NET.** Use the built-in dependency injection container, options pattern, logging and configuration. Blazor components hold presentation only; logic lives in services. Follow the .NET naming and project layout conventions.

**JavaScript and Node (ES modules).** One module per responsibility. Decisions as pure exported functions with plain data in and out. Pass dependencies explicitly (function or constructor arguments); a container only where it adds real decoupling. No module-level mutable state except where documented.

**Home Assistant YAML.** One script or automation per purpose; shared logic in scripts called by automations, not copied.

## Review requirements

Before considering work complete, verify:

- Each changed class and method has a clear responsibility.
- No unnecessary duplication was introduced.
- Dependencies remain understandable.
- Existing architecture has not deteriorated.
- Tests cover relevant behaviour.
- New files and abstractions have clear justification.
- Size thresholds were reviewed, and nothing already over a threshold grew.
- Build, tests and applicable static analysis pass.

The reviewer must challenge architectural deterioration even when the implementation is functionally correct. New deterioration in the changed code is a blocking finding. Pre-existing debt the change did not worsen is not blocking; it is recorded for planned refactoring.

## Enforcement

`node tools/ci/check-size.mjs` measures every `.mjs`, `.js`, `.cjs`, `.cs` and `.razor` file outside test fixtures (function and class length, parameters, file length and line length; for .razor only the @code and @functions blocks are C#) with a tokenising heuristic (tools/ci/size-csharp.mjs for C#) and no dependency; a file it cannot tokenise fails and is named. `tools/ci/size-baseline.json` lists every unit that was over a threshold, with its size. CI runs the check on every pull request and prints a table of unit, threshold, before and after.

- A baselined unit that grows fails. Each line over 160 characters is its own unit, keyed by the start of its text, so a lengthened line fails whatever happens to other lines. A new long line in a healthy file is normally a warning, but lines are paired with removed or edited long lines of the same file by start text and then by length, so a new long line written in the same change that removes or rewrites another long line of that file can be read as growth of the old one and fail.
- A unit that newly crosses a threshold fails when its file is already in the baseline as over the file threshold; in a healthy file it is a warning annotation, because thresholds are warnings and the reviewer judges.
- A unit that shrinks passes; the check prints the smaller baseline, and committing it (`--update-baseline`) is part of the change, so the gain cannot be lost again.
- The C# measure is a heuristic: expression-bodied members (`=>`) have no braces and are not measured, only the first branch of an `#if` is counted, and in a .razor file only the @code and @functions bodies are tokenised. A file whose strings or braces it cannot tokenise fails and is named rather than being skipped.
- Reviewers block on new architectural deterioration in the changed code (the ratchet is the mechanical part of that). Old debt the change did not worsen is a follow-up.

## Definition of done

A change is complete only when it is functionally correct, appropriately tested, understandable and maintainable.
Working code is necessary but not sufficient.
