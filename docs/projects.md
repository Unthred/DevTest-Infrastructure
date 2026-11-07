# Projects: running Foreman against any repository (issue #944)

Status: **design only, agent proposal.** No code, configuration or workflow changes under issue #944. Nothing here binds until the homeowner agrees it in a comment on the issue (including the SquigOS boundary, section 8). The follow-up issues in section 10 are drafts; none is created or started until the homeowner approves it. Foreman keeps running this repository unchanged throughout.

Evidence for the "today" statements was read from the source on this branch (main at `937e9d8`), not from memory; re-check a line number before relying on it.

## 0. Goals and non-goals
Goals: Foreman works any project that has an issue list; GitHub first, other work sources (Azure DevOps first among them) later; Foreman itself becomes the first project, not a special case; the migration loses nothing and Foreman keeps running this repository throughout.

Non-goals: building an Azure DevOps source; moving anything into SquigOS; changing any binding decision. (The register also holds agent-proposal entries, D-027 onward at the time of writing, which bind only once the homeowner approves them.) A project is not given weaker rules: D-007, D-008, D-009, D-010, D-015, D-020, D-024 to D-026 apply to every project unchanged.

## 1. Project model

A **project** is one place work comes from, one place code lives, and one set of rules for both.

```
project:
  id: foreman                       # stable slug, never reused; keys all state (section 4)
  name: DevTest Infrastructure
  enabled: true
  source:                           # section 2
    kind: github                    # github | azure-devops (later)
    repository: Unthred/DevTest-Infrastructure
    credential_ref: github/foreman  # a reference, never a value (section 5)
  checkout:
    repo_path: /mnt/user/projects/DevTest-Infrastructure
    worktree_base: /mnt/user/projects
    default_branch: main
  ci:
    required: all-that-ran          # today's D-025 rule; per project because other repos have branch protection
  labels: { needs_homeowner: needs-homeowner, ... }   # names only; the source maps them
  limits: { max_open_prs, max_review_attempts, max_fix_attempts, unblock, roles }   # per project caps
  weight: 1                         # section 3
  agents: { claude: { issues: [...] }, codex: { issues: [...] } }   # the project's own agent issue list
  review: { second_opinion, review_exception }       # per project
  decisions: { register: docs/DECISIONS.md }         # the project's own binding decisions
  board: { ... }                    # optional project-board mapping (today's `board` block)
```

### Global versus per project

| Stays global (one value for the machine) | Becomes per project |
|---|---|
| Agent providers, adapters, model routing (`models`) and what each role may use (D-012, D-026) | `repository`, `repo_path`, `worktree_base`, default branch, `depends_on_overrides` |
| Allowance, windows, thresholds, `budget`, `out_of_allowance`, the forecast (D-032) | `agents.*.issues` (the agent issue list), `branch_prefix` collision rules |
| Role slots (`limits.roles`: implementer, reviewer), test slots, resource limits | `limits.max_open_prs`, `max_review_attempts`, `max_fix_attempts`, `unblock` |
| Wasted-usage breaker thresholds (D-034): the cost limit and the global halt | Breaker halts by subject: already keyed by pull request or issue, so they gain a project prefix |
| Access mode (D-020), dashboard, MCP server and inbox transport (D-029 to D-033) | `review_exception`, `second_opinion`, `board`, required checks, `owner_comment_review` |
| Self-upgrade of the supervisor payload (it is Foreman's own code) | The decision register path and which decisions gate which behaviour |

Rule of thumb: whatever spends a shared, scarce thing (allowance, slots, Tower resources) is global; whatever describes a repository or its rules is per project. A per-project value may only **tighten** a global one (for example a lower open-PR cap); it may not raise a global safety limit.

### Config shape and compatibility
`supervisor/team.json` (plus the local override) gains a `projects` array. A config with no `projects` key is read as one implicit project `foreman` built from today's top-level `repository`, `repo_path`, `worktree_base`, `agents.*.issues`, `limits`, `board`, `review_exception`. So the existing file keeps working with no edit, and the migration (section 4) is the only moment a file is rewritten. `validateConfig` (team.mjs:44) is the one place that enforces the shape; it already rejects a bad `repository`, and gains per-project checks (unique id, absolute paths, source kind known).

## 2. Work-source interface

### Problem today
The planner calls GitHub through `githubClient(config)` (github.mjs, a closure over `config.repository`) and the `gh` CLI, but `gh` and GitHub URLs are also reached from other places. The interface exists in practice (the object `githubClient` returns, injected into `Team` as `gh`), but it is neither named nor complete, and its members are GitHub-shaped (`statusCheckRollup`, `closingIssuesReferences`, `mergeStateStatus`, check-run ids, projects v2 `board`).

### Every current call site, and where it moves

Inside `githubClient` (supervisor/github.mjs); these become the `GitHubSource` implementation, with the same behaviour:

| Today's member | `gh` command / API | New interface method |
|---|---|---|
| `listPulls` | `pr list --state open` | `listChangeRequests()` |
| `listMergedPulls`, `listClosedPulls` | `pr list --state merged/closed` | `listChangeRequests({state})` |
| `getMergedPull` (github.mjs:38, `pr view --json number,state,headRefName,headRefOid,statusCheckRollup`; used at team.mjs:840 and 1059 and upgrade.mjs:722; wrapped in ghchange.mjs:199) | `pr view` of a merged pull | `getChangeRequest(id)` returning the normalised `state: 'open'|'merged'|'closed'`, `head`, `branch`, `checks`; the merged-state read is just this call |
| `issueAuthorAssociation` (github.mjs:55; used at team.mjs:2955 to admit only OWNER issue text into review requirements) | `api repos/<repo>/issues/<n>` -> `author_association` | Dropped as a separate member: `getWorkItem(id)` and `listComments(id)` carry `author: {login, isOwner}` (below); the planner tests `author.isOwner` |
| `getPull`, `listPullFiles`, `prComments`, `listCheckRuns` | `pr view`, files, comments, check runs | `getChangeRequest(id)`, `listChangedFiles(id)`, `listComments(id)`, `listChecks(id)` |
| `listIssues`, `getIssue`, `issueComments`, `getComment`, `hasComment` | `issue list/view`, `api .../comments` | `listWorkItems()`, `getWorkItem(id)`, `listComments(id)`, `getComment(id)`; `hasComment` becomes a helper over `listComments` |
| `findIssueByMarker`, `findOpenIssueByMarker` | `issue list` + body search | `findWorkItemByMarker(marker, {open})` |
| `createIssue`, `updateIssueBody`, `pinIssue` | `issue create/edit/pin` | `createWorkItem`, `updateWorkItem`, `pinWorkItem` (optional capability) |
| `comment` | `issue comment` | `addComment(id, body)` |
| `listLabels`, `addLabel`, `removeLabel` | `label list/create`, `issue edit` | `listLabels`, `addLabel`, `removeLabel` (the source creates the label if the system supports it) |
| `rerunRun` | `run rerun` | `rerunChecks(checkRef)` |
| `merge` | `pr merge --merge --match-head-commit` | `merge(id, expectedHead)` |
| `board` | `project item-edit` (projects v2) | `setBoardStatus(workItem, status)` (optional capability) |

Outside `githubClient`; these are the call sites the issue asks to list, each moved behind the interface:

| File | What it does today | Where it moves |
|---|---|---|
| `supervisor/core.mjs:294` | `spawnSync('gh', ['issue','view',...,'--json','state'])` run in a job worktree to check the issue is still open | `source.getWorkItem(id).state`, called from the dispatcher, not the job runner |
| `supervisor/ghchange.mjs` (`ghProbeRunner`, `endpoints`, `checkForChanges`, `cachedGithub`, `loadCache/saveCache`) | The cheap ETag change probe and the cache wrapper over `githubClient`; spawns `gh api` and hard-codes `repos/<repo>/...` endpoints; cache file `team/gh-cache.json` records `repository` | Becomes `source.changeProbe()` (optional capability: `{changed, baseline}`) and a generic caching decorator around any source. The cache is keyed by project id |
| `supervisor/history.mjs:193-196` | `entryLink` hard-codes GitHub pull and issue links from `repository` | `source.url(kind, id)` |
| `supervisor/history.mjs:140` | `githubBackfill`: `gh pr list` to backfill the merge history | `source.listChangeRequests({state:'merged'})` |
| `supervisor/naming.mjs:124-135` | Builds `https://github.com/<repo>/issues/<n>`, `/pull/<n>`, `/commit/<sha>` links | `source.url(kind, id)`; the namer takes a url builder, not a repo string |
| `supervisor/cli.mjs:20-30, 187, 191, 219, 281-296, 323, 514, 527` | Builds the client, the probe, the cache, the connectivity check (`listPulls`), `githubBackfill`, status | `makeSource(project)` factory; the CLI asks it, never `githubClient` |
| `supervisor/team.mjs:44, 584, 2351, 2474, 2507-2509, 2770, 2807, 3189` | `this.c.repository` used for validation, the review prompt text, the namer, the owner login, the decision-link check and Needs you links | `this.project.source` (identity and `url()`); the owner login comes from the source (`source.owner`); the prompt text names the project and its change-request noun |
| `supervisor/team.mjs` (many `this.gh.*` calls: `listPulls` 15, `getPull` 9, `comment` 6, `addLabel` 6, `listIssues` 5, `getIssue` 5, `createIssue` 5, `findIssueByMarker` 4 and the rest) | The planner's direct use of the injected client | Same calls, renamed to the neutral methods above; mechanical |
| `supervisor/teamstatus.mjs:58,137,149`, `supervisor/dashdata.mjs:194`, `supervisor/dashboard.mjs` (lines 199, 210, 309, 571, 618, 652, 739, 840, 856, 887, 897), `supervisor/dashrender.mjs:632,732` | Hard-coded `https://github.com/${config.repository}/...` links, the `Repository` fact, the `repository` view field | `view.projects[]`, each with `url()` output precomputed at build time so render code stays source-free |
| `supervisor/upgrade.mjs:723` | Namer built from `config.repository` | Self-upgrade stays on the Foreman project (it upgrades Foreman's own payload) |
| Review and job prompts (`team.mjs:584`) | Tell the agent to run `gh pr view` and `git clone` | Prompt is generated from `source.agentHints()` (the commands an agent may use), so an Azure DevOps project can say `az repos pr show` |
| `tools/` and `docs/` | CI helpers (`tools/ci/*`) are repository-side and stay GitHub Actions for Foreman | Out of scope; they belong to the project, not to the dispatcher |

Count check: 34 `repository` references in 4 supervisor files was the issue's figure; a recount on this branch finds `config.repository` or the view's `repository` used in 10 files (core, dashboard, cli, dashdata, dashrender, github, ghchange, teamstatus, team, upgrade); `history.mjs` also takes `repository` as a parameter and builds GitHub links, and the bare word appears in about 19 supervisor files, so the lint must scan by pattern, not by this list. Link builders at `dashboard.mjs:887` and `:897` are now named in the dashboard row above. The follow-up issue 1 starts with a fresh `grep` and a test that fails if a new `gh` call or `config.repository` appears outside the source module (a lint in `tools/validate-project.mjs`).

### The interface

Neutral nouns, so GitHub and Azure DevOps both fit: **work item** (GitHub issue; ADO work item), **change request** (pull request; ADO pull request), **check** (check run / status; ADO pipeline run), **comment**, **label** (GitHub label; ADO tag), **board status**.

Contract (a versioned JSON-described module, like `contracts/provider-manifest.v1.schema.json`, so a new source is a registry entry, per D-012's pattern):

```
WorkSource {
  identity: { kind, id, owner, displayName }
  capabilities: { pin, board, changeProbe, labels, requiredChecks, matchHeadMerge }   // flags, like provider capability flags
  // work items
  listWorkItems(), getWorkItem(id), createWorkItem({title, body}), updateWorkItem(id, {body}), findWorkItemByMarker(marker, {open})
  // change requests
  listChangeRequests({state}), getChangeRequest(id), listChangedFiles(id), merge(id, expectedHead)
  // discussion and labelling
  listComments(id), getComment(id), addComment(id, body), listLabels(), addLabel(id, name), removeLabel(id, name)
  // checks and links
  listChecks(id), rerunChecks(ref), url(kind, id), agentHints()
  // optional
  pinWorkItem(id), setBoardStatus(id, status), changeProbe(prev)
}
```

**Trust boundary.** Every work item, change request and comment carries `author: {login, isOwner}`. `isOwner` is computed by the source, never by the planner: GitHub maps `author_association == OWNER` (what `issueAuthorAssociation` does today) and the owner login (`ownerLogin`, team.mjs:2474-2478); Azure DevOps maps the identity to the project administrators group or an explicit `owners` list in the project config. The planner uses `isOwner` for owner-only review requirements (team.mjs:2955), `owner_comment_review` and the `homeowner-approval` comment check. A source that cannot establish `isOwner` reports `false`, so the safe default is untrusted. Work items and comments also carry `body` and `createdAt`.

Normalised records carry only fields the planner uses: for a change request `{id, title, branch, head, base, draft, mergeable: 'yes'|'no'|'unknown', checks: [{name, state: 'pass'|'fail'|'pending'|'skipped'|'neutral'}], labels, closes: [workItemId], url}`. The GitHub adapter does the translation that is spread through the planner today (`statusCheckRollup` to a normalised state, `closingIssuesReferences` to `closes`, label objects to names). Everything the planner does with the rollup keeps its D-025 meaning (skipped and neutral do not block).

Rules the interface keeps from today, as contract tests every source must pass:
- `merge` is a compare-and-set on the head (`--match-head-commit` today) or it is refused: a source without that capability cannot be merged by Foreman (capability `matchHeadMerge` false means review-only).
- Non-retried writes (`comment`, `createWorkItem`) never retry; idempotency uses `hasComment`/marker lookups, as now.
- Every written text passes `redactTopology` and the attribution check; a source never receives a secret (D-008).
- Reads stay cheap: the ETag probe becomes the optional `changeProbe`; sources without it are polled on the full interval.

### Azure DevOps (designed for, not built)
Mapping: work item = work item (type configurable, default Issue/Task/Bug via a WIQL query for "agent-ready"); change request = Azure Repos pull request; check = pipeline run / PR policy status; label = tag; comments = work-item discussion and PR threads; merge = PR completion with `lastMergeSourceCommit` as the expected head (a compare-and-set exists); board status = work-item State. Open questions for the first ADO issue: how "closes" links are expressed (work item relations versus `#id` in the PR description), required-check semantics (branch policies are stricter than GitHub's), rate limits and the lack of an ETag probe. Authentication is a PAT or service principal fetched through OpenBao (section 5), never from the environment of a job.

## 3. Scheduling across projects

Today one `tick` plans one repository: `plan()` orders issues and pull requests, applies role slots, allowance, `max_open_prs`, file-overlap waits, the breaker and Needs you. Two designs were considered.

**Chosen: one tick, one global plan, per-project candidate pools.**
1. For each enabled project the tick builds that project's pool (the same data the planner uses today), with its own cap, overlap map, breaker halts and Needs you list.
2. A single global step then allocates the shared resources (role slots, test slots, allowance) over the union, using these keys in order:
   1. **Safety first**, unchanged: breaker halts, allowance stops, D-032's actual-use holds. Not project-aware.
   2. **Work kind priority**, unchanged (reviews and fixes of open pull requests before new implementation), so no project can starve another's review.
   3. **Homeowner project order**: `projects[].order` (a plain list the homeowner edits; the dashboard shows and edits it later through a D-029-style write). Earlier project wins ties at this level.
   4. **Weight**: a per-project integer `weight` (default 1) applied as a deficit round-robin among the same priority class, so a weight-3 project gets about 3 starts for each 1 of a weight-1 project when both have ready work. Order breaks exact ties; weight prevents permanent starvation of the later project.
   5. Within one project, today's issue ordering.
3. D-032 holds across projects: nothing is held back to "spread" work; if one project has nothing ready, the other uses the slot. Idle slots with ready work in any project is a defect.

**Per project, unchanged semantics:**
- **Open-PR cap** (`max_open_prs`): counted per project, with an optional global ceiling so many projects cannot flood Tower with open work. Effective cap = the smaller of the two.
- **File-overlap waits**: overlap is computed only between change requests of the same project (different repositories cannot conflict).
- **Breaker** (D-034): halts already name a subject (pull request or issue); subjects gain the project id (`foreman#PR 12`). Same-cause counting is per subject, so repeats in one project cannot trip another. The cost limits ($5 per cause, $15 global) stay global because cost is shared. A job-type halt with no subject list still holds the type everywhere (legacy behaviour is kept deliberately conservative).
- **Needs you**: each item carries `project`; the count is per project and in total; a blocked project does not suppress another's items.
- **Second opinion / review exception / interim review (D-021, D-024, D-027)**: configured per project, evaluated against the project's pull requests; independence still compares the writer model with the reviewer model from the job records (same rule everywhere).
- **Allowance**: one pool. Per-project budgets (a monthly allowance share) are explicitly out of scope; weights are the only share control, and it is a start-rate, not a spend guarantee.

**Considered, rejected:** one tick per project (each with private slots) because slots and allowance are global and per-project ticks would either oversubscribe them or need a second coordinator; a hard per-project allowance quota because it contradicts D-032's goal of maximising processing.

## 4. State and history

### Today
All state lives under a state root (`/mnt/cache/ai-supervisor` in production): `team/state.json` (jobs registry, merge log, titles, counters), `team/` files (inbox, archive, incidents, wake, test slots and results, upgrades, `gh-cache.json`, `status-issue.json`, `migrations.json`), plus root-level `jobs/`, `leases/`, `events/`, `current/`, `workers/`, `transcripts/`, `job-locks/`, `homeowner-requests/`, and `dashboard/` (snapshots, archive, watchlist, breaker-resume). A job record already carries `repository` (core.mjs:207 hashes `<kind>:<repository>#<issue>` for its lock), and verdicts are keyed by pull-request number and head.

### Keying rule
Every record that names an issue number, pull-request number, head, branch, worktree, lease or lock gains a `project` id; the identity is always `(project, number)`, never the bare number. Items that are global stay global and are marked so.

| Data | Global or per project | Keyed by |
|---|---|---|
| Jobs registry and job records (`jobs/`, `workers/`, `transcripts/`) | Per project field on the record; stored once, filterable | `jobId` unchanged (jobs are already unique); add `project` |
| Verdicts, review attempts, fix counts, carry records (D-025) | Per project | `project/pr/head` |
| Merge log, titles, splitting/hold state | Per project | `project/number` |
| Leases and job locks | Per project | `sha256(kind:project:repository#issue)` (adds the project; same scheme as core.mjs:207) |
| Inbox items (D-031, D-033) | Per project field | Item gains `project`; `action` targets are `(project, number)` |
| Breaker halts and waste records | Per project subject, global cost totals | `project/subject` |
| Cache (`gh-cache.json`, `dashboard/cache.json`) | Per project | `team/projects/<id>/gh-cache.json`; the loader already compares `repository`, and gains the project id |
| Archives and snapshots (`dashboard/archive`, `snapshots.jsonl`) | One stream, each row has `project` | Row field; old rows without it read as `foreman` |
| Allowance, probes, test slots, resources, self-upgrade, wake | Global | unchanged |
| Worktrees | Per project | `<worktree_base>/<repo-name>-<agent>-<n>` (section 5) |

Layout choice: keep the existing flat files for global state and add `team/projects/<id>/` for the per-project state that is a file of its own (cache, status issue, overlap maps). Records inside shared files (jobs, archives) carry a `project` field. This avoids one-file-per-project everywhere (many small files, more locks) while keeping per-project reads cheap.

### Migration (no loss, reversible, Foreman unchanged)
The existing framework (`supervisor/migrations.mjs`, `migrations/001-drop-per-agent.mjs`) migrates the local configuration file: it takes a mode-600 backup `<file>.bak-<time>-<number>`, applies, validates, writes atomically, records the number and appends to `team/incidents.jsonl`. It does not yet rewrite state data, so the config step reuses it and the history steps (3 to 5) need a small extension to the framework (a data migration with the same backup, validate and record discipline):
1. **Backup first**: copy the state root's `team/` and `dashboard/` JSON into `backup/projects-<date>/` (mode 600, as the framework does for config); abort if the copy is incomplete.
2. **Config**: write the `projects` array containing the single project `foreman` built from the current top-level values; keep the top-level keys readable for one release (the loader prefers `projects`), so a rollback by restoring the old payload still works.
3. **History**: add `project: 'foreman'` to every record that lacks it (jobs, verdicts, merge log, inbox log, archive and snapshot rows, incidents, breaker records). Idempotent: a record with `project` is untouched; the migration records its own number and counts (rows seen, rows changed) in `team/incidents.jsonl`.
4. **Move cache**: `team/gh-cache.json` moves to `team/projects/foreman/gh-cache.json`; a missing cache is already a safe full pass (the loader returns null on mismatch).
5. **Verify**: row counts before and after match; a read of the dashboard view, `team status` and one dry `plan()` give the same output as before the migration (a golden comparison); only then is the migration number recorded as applied.
6. **Dual read**: for one release the readers treat a missing `project` as `foreman`, so a payload that was upgraded but whose migration has not yet run (the self-upgrade drains first, then migrates) never mis-keys data.
7. Rollback is restoring the backup and the previous payload; nothing deletes the old keys.

The migration runs inside the existing self-upgrade drain (no job running), as `001-drop-per-agent` does.

## 5. Workspaces and identity

**Checkout and worktrees.** Each project names its `repo_path` (a clone on Tower under `/mnt/user/projects/`, like every server-side product source) and `worktree_base`. Worktree naming extends D-018 without breaking it: `<repo-name>-<agent>-<n>` where `<repo-name>` is the project's repository directory name; for Foreman the existing `DevTest-Infrastructure-<agent>-<n>` is exactly this, so nothing moves. One writer per worktree (D-011) and "Git fixtures use independent clones, never a linked worktree" apply per project. Adding a project is: clone it, add a `projects` entry, run `team validate`; Foreman never clones on its own initiative. A project whose `repo_path` is missing or dirty is disabled with a Needs you item, not guessed around.

**Containers and tests.** Test slots are global; a project declares how its build is run through the `dev-test` CLI (D-001). A project that does not use .NET or Playwright simply calls other tracks; D-007 and D-015 are not relaxed per project. An agent job runs with access D-020 grants; D-020 is unchanged and is not per-project.

**Credentials per source.** `credential_ref` names an OpenBao path or the local `gh` login; the value is never in config, Git, logs or arguments (D-008, D-022 style delivery: broker, tmpfs file). Rules:
- One scoped, read-where-possible identity per project; a PAT or token that can reach several repositories is refused for a second project, so a leak or a mistake in one project cannot touch another.
- Foreman today uses the machine's `gh` login (the homeowner's). That remains the credential of the `foreman` project until the App identity (below) lands; a second GitHub project may use the same login only by explicit homeowner choice recorded in config, because it widens what a job in project B can do.
- Azure DevOps: PAT or service-principal secret held in OpenBao, fetched by the dispatcher's broker, passed to a job as a read-only file mount, never an environment variable.
- The credential registry (`credentials/registry.json` in the Infrastructure repository) gains one consumer row per project; a credential route change is checked against all of them.

**GitHub App identity (#373 to #377).** Those issues move writes (comments, labels, merges, pull-request creation) from the homeowner's login to a GitHub App identity so Foreman's actions are attributable and scoped. With projects: one App, installed per repository (an installation is already per account or repository), with the installation id stored in the project's `source` block; the private key stays in OpenBao and is shared only by the broker. Per-project installation gives the least-privilege boundary the project model wants (an installation can only touch the repositories it is installed on). Ordering: the projects work does not depend on the App landing; the App issues must be made project-aware (take the installation from the project) before a second project is added, or the second project would inherit the homeowner's login. This is recorded as a prerequisite in follow-up 6.

## 6. Dashboard

- **Project switcher** in the app bar: `All projects` plus one entry per enabled project, URL-owned (`?project=<id>`, per tab, the same direction SquigOS recorded for its own shell; section 8). `All projects` is the default when more than one project exists; with one project the switcher is hidden and the page looks as today.
- **All-projects view**: one row per project with its health (tick ok, Needs you count, open PRs against cap, running/queued jobs, breaker state, last merge) and a combined agents/slots strip, because slots and allowance are global.
- **Every page and list filters by project** (issue #939): Agents, Queue, Pulls, Jobs, History, Graphs and Needs you take the selected project; the filter is applied in the view builder (`dashboard.mjs`, `dashdata.mjs`), not in the browser, so the page and the JSON agree. A global card (Allowance, Slots, Resources, Dispatcher) shows the same on every project and is labelled global.
- **Needs you and the inbox show the project** as a leading chip on every card and in the unread count; the inbox approve/reject write routes (D-029 to D-033) verify the `(project, number)` target, so one project's click cannot act on another project's pull request.
- **Links** use `source.url()`; no render code contains `github.com`.
- Cached dashboard JSON (`view.json`) gains `projects[]` and per-item `project`; consumers that ignore the field keep working (the MCP server in section 7 reads the same document).
- Costs: page and tick cost grow with the number of projects, not pages; the view worker already builds the view off the request path (`viewworker.mjs`), so the switcher is a filter over one built view.

## 7. MCP and inbox

- **Read tools** (`foreman_status`, queue, job, needs-you and the rest in `docs/foreman-mcp.md`): an optional `project` argument filters; omitted means all projects. Output rows always include `project`. No new tool is needed for reading.
- **Write tool `foreman_propose`** (D-031): `project` is **required** once more than one project exists (with exactly one it defaults to that one, so existing proposals keep working). Item kinds stay `prompt`, `issue_draft`, `action` (D-033); `issue_draft` posts to the named project's source, `prompt` runs a job in the named project's worktree, `action` targets `(project, number)`. The content hash covers the project, so an approved item cannot be re-pointed at another project. An unknown or disabled project is refused at write time and again at approval.
- **Safety**: the restricted `foreman-mcp` account and the rule that approval exists only on the dashboard are unchanged. Nothing about projects lets MCP name a path, a credential or a source; it names a project id from a closed list that Foreman supplies.
- **Proposal status** files and the audit log gain the project id.
- Since D-030 and D-031 are `agent-proposal` entries, a project-aware revision needs its own dated proposal if the tool contract changes; this document does not edit them.

## 8. SquigOS boundary

Facts, from SquigOS's own repository (`/mnt/user/projects/squiggleos`, files `docs/CURRENT.md`, `docs/ai/PROJECT_CONTEXT.md`, `docs/design/project-context-architecture-decision.md`, `docs/design/external-development-worker-bridge.md`): SquigOS describes itself as a transparent AI operations system. Its Stage 1 domain model is **Project, WorkItem, versioned Plan, Run, Conversation, Contribution, Compaction** on an append-only EventStore with deterministic projections. A **Project** is the durable domain working context; a **Workspace** is only a shell navigation area; WorkItems belong to exactly one Project; Plans, Runs, Evidence and Claims inherit Project through the WorkItem; integrations and credentials are system-owned with OpenBao-compatible references and projects hold bindings, never secrets; project context is URL-owned per tab with `All projects` as the default; GitHub and Azure "projects/boards" are explicitly external. SquigOS has an early *external development worker bridge* slice (a remote overseer to Claude/Cursor workers on Unraid, with a non-GitHub-specific worker contract). SquigOS API/UI work is not yet complete (health-only until Stage 1I).

### Recommendation (for the homeowner to accept, change or reject)

**Adopt now (vocabulary and shape, no dependency):**
- *Project* and *WorkItem* as the names and as the ownership rule (a work item belongs to exactly one project; everything else inherits the project). Section 1's `project` and section 2's `work item` are deliberately the same words, so a later mapping is a rename of nothing.
- *Credentials are system-owned; a project holds a reference* (section 5). Same rule, same OpenBao stance.
- *Project context is shell-owned and URL-owned per tab, default All projects* (section 6).
- *External boards/projects stay called external*: Foreman's `board` block stays a source capability, not a Foreman project.

**Do not adopt now:** SquigOS's append-only EventStore, versioned Plan, Conversation and Compaction. Foreman's state is a small set of JSON files with a working migration framework; re-platforming it onto an event store is a large rewrite with no benefit to this issue and SquigOS's API/UI is not ready to host it.

**Share or move later (boundary candidates, each its own decision):**
| Capability | Recommendation | Why |
|---|---|---|
| Work-source interface (section 2) | Keep in Foreman now; publish as a versioned contract (`contracts/work-source.v1.schema.json`) so SquigOS can implement or consume the same adapters | Avoids two GitHub/ADO integrations; SquigOS's worker bridge already says it must not be GitHub-specific |
| Agent provider adapters, allowance, model routing (D-012, D-026, D-032) | Stay in Foreman (the unattended executor); SquigOS calls Foreman as a worker rather than reimplementing | They are Tower-specific and already P0-hardened |
| Governed work items, plans, evidence, human approvals | SquigOS owns the system of record; Foreman reports into it (a work source of kind `squigos` is a natural later adapter) | This is SquigOS's stated purpose |
| Dashboard / Projects Workspace | Keep Foreman's dashboard as the operator console for the dispatcher; SquigOS's Projects Workspace becomes the cross-system view and may embed or link to it. Foreman's switcher mirrors SquigOS's URL-owned `?project=` so the two align | One cockpit per concern; no duplicated overview |
| Inbox / overseer proposals (D-031, D-033) | Foreman's inbox is the narrow approved-write path for Foreman; SquigOS's external worker bridge is the future transport. Do not merge them until SquigOS has authentication and an authorization boundary per project | SquigOS records Project as a future authorization boundary, not yet implemented |
| Decision register | Per project, each repository keeps its own; SquigOS may aggregate read-only | Binding decisions must live with the code they bind |

**Decision requested from the homeowner:** (a) accept the *adopt now* list; (b) confirm Foreman stays the executor and SquigOS the governed system of record, with the work-source contract as the join point; (c) confirm no data model migration into SquigOS is planned before SquigOS Stage 1I. This is a boundary decision, not built here.

## 9. Risks and open questions
- **Blast radius of one dispatcher**: a bug in project selection could write to the wrong repository. Mitigation: the source object is bound to its project at construction (no global "current repository"), every write path takes the project object, and a test asserts a write routed to project B cannot reach project A's source (negative test in follow-up 1/3).
- **Credential reach**: section 5's one-identity-per-project rule; the open point is whether the first extra project can use the homeowner's `gh` login (recommended: no, wait for the App).
- **Cost of polling many repositories**: the ETag change probe is per project; `changeProbe` absence on ADO means a longer interval there.
- **Branch-prefix collisions**: `claude/` and `codex/` branch prefixes are per project because branches are per repository; no cross-project collision, but issue lists (`agents.*.issues`) are per project.
- **Self-upgrade stays Foreman-only** and is not a project concern.
- **Open for the homeowner**: weights versus a strict order only; whether a project may have a smaller allowance share later; whether SquigOS becomes a source kind.

## 10. Follow-up issues (drafts for homeowner approval; none created)

Each is sized for one PR. Order matters; 1 and 2 are first and change no behaviour. Every one keeps Foreman running this repository unchanged, adds tests for positive and negative cases, and does not touch `docs/ai/CURRENT_HANDOVER.md` on its branch.

1. **Work-source interface over the existing GitHub behaviour (no behaviour change).** Define `WorkSource` and the normalised records; move `githubClient` behind a `GitHubSource` with the neutral method names; adapt `team.mjs` call sites mechanically; add a contract test suite every source must pass and a lint in `tools/validate-project.mjs` that fails on `gh` or `github.com` outside the source module. Acceptance: all existing tests pass unchanged; a golden recording of one `plan()` before and after is byte-identical.
2. **Project-keyed state migration (no behaviour change).** Add the `project` field and keying of section 4, `migrations/002-projects.mjs` with backup, idempotence, row counts and dual-read; implicit `foreman` project from today's config. Acceptance: migrating a copy of a real state root changes no output of `team status` or the dashboard view; running it twice changes nothing; a record without `project` reads as `foreman`.
3. **Project object in config and in `Team` (single project still).** `projects` array and validation; replace `config.repository`/`repo_path`/`worktree_base`/`agents.*.issues`/`limits` reads with `this.project`; the namer takes `source.url`. Acceptance: no `config.repository` reference remains; a negative test proves a write cannot cross projects.
4. **Move the remaining gh call sites behind the source.** `core.mjs` issue-state check, `ghchange.mjs` probe and cache decorator keyed by project, `history.mjs` backfill, `naming.mjs` links, prompt `agentHints`. Acceptance: the lint of issue 1 now passes with no allow-list.
5. **Multi-project scheduling.** Per-project pools, global allocation by priority class, order and weight, per-project cap and overlap, project-prefixed breaker subjects, per-project Needs you. Acceptance: with two fake sources, a slot goes to the other project when one is empty, weights give the stated ratio, and a breaker halt in one project does not hold the other.
6. **Per-project credentials and the App identity.** `credential_ref` resolved via the broker; refuse a shared multi-repository credential for a second project; make #373 to #377 take the installation from the project. Acceptance: no secret appears in config, logs or arguments (existing scanners); a second project cannot read the first's credential.
7. **Dashboard: project switcher, All-projects view, filtering (#939).** View builder gains `projects[]`; every list filters server-side; chips on Needs you and inbox. Acceptance: screenshots for one and two projects (ui-ux-review), a filtered list contains no other project's rows.
8. **MCP and inbox take a project.** `project` argument on reads; required on `foreman_propose` with two or more projects; hash covers the project; dashboard approval re-checks it. Needs its own decision entry if the contract of D-030/D-031 changes. Acceptance: a proposal for an unknown or disabled project is refused at write and at approval.
9. **Add a second project (GitHub), read-only first.** Enable with `enabled` + dry-run planning only; the homeowner reviews what Foreman would do before writes are allowed. Acceptance: dry-run output matches an expected plan; writes are off until the homeowner flips one flag.
10. **Azure DevOps source (design spike first).** A spike document resolving the open questions in section 2, then an `AzureDevOpsSource` against a throw-away organisation, read-only before any write. Not started until 1 to 5 are merged and the homeowner approves.
11. **SquigOS join (after the homeowner decision in section 8).** Publish `contracts/work-source.v1.schema.json`; decide whether a `squigos` source kind is wanted. Depends on SquigOS Stage 1I.

Decision register: the project model (section 1), the state keying rule (section 4) and the SquigOS boundary (section 8) are architecture decisions. Under issue #303 an agent may only propose; a `Status: agent-proposal` entry (working title "Projects: Foreman works any repository through a work-source interface") should be added in follow-up 1's pull request, and becomes binding only when the homeowner records approval.
