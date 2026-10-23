# Hub spec: gap analysis and build plan

2026-10-23, Claude Code 2.1.309, Node 24.11.1. Plan only; nothing is built yet.
Source: the "personal workspace hub" spec you pasted (Code Studio first, Next.js + tRPC +
SQLite + Agent SDK, staged). Two parts, in the order you asked: **A** brings the existing
workspace app (`tools/workspace-app`) in line with the spec's model; **B** builds the spec as a
new project, `projects/nextjs-workspace`.

## Summary

- **The current app already meets the spec where it is hardest:** persisted runs with a
  timeline, cancellation, turn/time/cost caps, restart recovery, checks the app runs itself with
  a per-test baseline (so pre-existing failures are shown as such), proofs bound to the base
  commit, a review gate before every commit, secrets kept out of the browser, one start command.
- **It falls short on the model and the layout:** assets have no versions and only images are
  supported; a flow is tied to one project; runs don't record which flow, prompt, settings or
  asset versions they used; there is no place in the app to set rules or attach assets per
  project; only profiled projects get a project screen, and that screen is one long page
  instead of Tasks / Findings / Changes / Checks / Architecture; there is no assistant next to
  the active task.
- **Part A** (hub app): 8 slices, same zero-dependency stack. It adds versioned per-project
  rules and settings, a versioned asset library (shared and per project), flows shared across
  projects, an input manifest on every run, the spec's navigation with a tabbed project page
  for every project type, and an Ask panel.
- **Part B** (new app): a two-process app (Next.js web + a persistent runner on the Agent SDK)
  with SQLite metadata, a content-addressed file store, one branch and worktree per code task,
  and the audit → finding → fix → verify flow working end to end before Stage 2 starts.
- **Baseline today:** 1,176 tests, 1,173 pass, **2 fail**, 1 skipped. Both failures come from
  line endings: this PC checks out the recorded run fixtures with CRLF (`core.autocrlf=true`
  plus `* text=auto`), so 147 fixture files differ from the bytes the app wrote. Slice A0 fixes
  it.
- **Decisions needed from you:** listed at the end (Agent SDK sign-in, Node 24 for the new
  project, installing its npm dependencies, commits per slice).

A note on overlap: Part B does the same job as the hub app's run engine (runs, findings,
checks), in a different stack. Part A therefore stays with what serves the hub as a whole
(projects, rules, assets, flows, provenance, layout) and doesn't port Code Studio features
twice. If Part B proves itself on Tattoogenda, it can take over the hub app's runs later; that
would be a separate decision.

## Part A: the workspace app against the spec

### Where it stands

| Spec | Workspace app today | Change |
|---|---|---|
| Global nav: Projects, Assets, Flows, Runs | Today, a cockpit and Health entry per profiled project, Runs, review gates, Projects, Flows, Library, Images, Assets | Today, Projects (each project under it), Assets (Images merged in), Flows, Runs; Library and settings at the foot |
| Project views: Tasks, Findings, Changes, Checks, Architecture | One cockpit page of cards; Health is a separate screen; projects without a profile get no screen | A tabbed project page for every project; the tabs come from its type |
| Project types, extensible | A detected label (Next.js, game, Other) | A type registry: `code` (has a profile), `assets` (has an asset pipeline, e.g. game-dev), `generic`; each type lists its tabs |
| A project has its own instructions, tools, assets, settings | CLAUDE.md and AGENTS.md at the base commit go into every stage (good); checks and fences live in a hand-edited private profile; no rules or assets per project in the app | A Settings tab: project rules (Markdown), default model, effort and permission mode, allowed tools, attached assets. Saved as numbered, immutable versions in the private data folder |
| Assets shared across projects; AssetVersion | Images only, per inbox, agent or flow folder; no versions; game assets in their own view | An asset library, shared and per project: images, Markdown/text and PDF, each new upload a new immutable version with its hash; attach to projects and flows |
| Flows shared across projects; FlowVersion | A flow names one fixed project or agent; no version recorded | A flow can target any project (chosen when you run it); each launch records the flow's hash, the hub commit and the asset versions |
| Runs record exact inputs, revision, outputs, checks | `run.json` has the base commit, Node and Claude Code versions, hashed `inputs/`, the plan hash, the proof | A manifest per run: stage prompt hashes, profile hash, project settings version, asset versions, model per stage; shown on the run page |
| Task | A run with an optional parent | The Tasks tab groups runs by their root run; no new store |
| One branch/worktree per code task | One run worktree per project (or branch mode), one editing run at a time | Kept on purpose: a Tattoogenda install per task is too slow and too big. Part B does per-task worktrees |
| Passed / failed / skipped / pre-existing; bound to the revision | Baseline by test identity; proof bound to the base commit and tree | Met. The Checks tab shows the four counts separately |
| Review before merge or deploy | Commit gate; the app never pushes or merges | Met |
| Cancellation, limits, recovery, persisted logs | Yes | Met |
| Credentials out of the browser | Yes: sign-in cookie, redaction, data folder | Met |
| Contextual assistant beside the active task | None | An Ask panel on run, review-gate and finding screens |
| Git hosting integration (optional) | None | Not in the hub app (it never pushes). Part B Stage 2 |
| One start command | `Workspace App.cmd` | Met |

### Slices

Each slice ends with the full tool suite green (`node tools/run-tests.mjs`), the app started and
the changed screens checked in Edge, and the README updated. Work happens on a branch.

| # | Slice | Size | Done when |
|---|---|---|---|
| A0 | **Line endings.** `.gitattributes`: `tools/workspace-app/test/fixtures/** -text`, then refresh those files from the index | S | The 2 failures pass; no fixture file has CR bytes |
| A1 | **Project types and the project page.** `projectTypes.mjs` registry; `#project/<name>/<tab>` for every project; the cockpit's cards move into Overview, Tasks, Findings, Changes, Checks; Health becomes Architecture; old `#cockpit/` and `#health/` links redirect | L | Every project opens; Tattoogenda-style projects show the five code tabs; game-dev shows its asset tabs; keyboard and screen-reader checks as before |
| A2 | **Navigation.** Today, Projects (with projects nested), Assets, Flows, Runs; Library and settings at the foot; Images folded into Assets | M | Nav matches the table above; counts and review-gate entries still work |
| A3 | **Project settings (rules).** `<dataDir>/projects/<name>/settings/v<N>.json`, immutable, with hash; Settings tab with an editor, version list and a diff between versions; stale saves refused (409). Rules go into every Claude stage as a `<project_instructions source="workspace-rules@v<N>">` block and into app-started sessions with `--append-system-prompt` (passed by `claude-prompt.mjs` as an argument, never through PowerShell; capped at 20 KB) | M | A rule saved in the app shows up in the next run's prompt and in a flow session; the run records the version |
| A4 | **Asset library.** `inbox/attachments/_assets/<id>/` (shared) and `inbox/attachments/<project>/_assets/<id>/` (project): `asset.json` plus `v<N>.<ext>` files that are never overwritten; content checks per kind; attach to a project (pinned version or latest) or a flow. Existing image folders keep working and are listed as "Inbox images" | L | Upload, new version, attach, archive; a run's `inputs/` gets the attached versions, hashed |
| A5 | **Shared flows and flow versions.** `project: "*"` (any project) in a flow's front matter; the run dialog asks which project; every launch writes the flow hash, hub commit and asset versions to `sessions.jsonl` | S | One flow runs in two projects; both launches are recorded with the same flow hash |
| A6 | **Run manifest.** `run.json` gains `manifest` (prompt, profile, settings, asset and model versions); an Inputs card on the run page | S | Manifest written at start, frozen afterwards, covered by tests |
| A7 | **Ask panel.** A side panel on run, review-gate and finding screens that starts a read-only Explain run with that context (`parent` = the run) and shows the answer as it arrives; follow-ups chain runs | M | Ask works with the fake Claude in tests and once for real |

Then the docs: README, `flows/README.md`, a decision note
(`knowledge/decisions/2026-10-23-project-model.md`), and a revision of this report.

## Part B: Nextjs-Workspace

Folder `projects/nextjs-workspace` (project folders are kebab-case; the product name is
"Nextjs Workspace"). Its own git repo, created from scratch rather than the `nextjs` template,
because the template describes a single Next.js app and this is a two-process monorepo; its
`CLAUDE.md` follows the template's sections.

### Shape

```
nextjs-workspace/
  apps/web          Next.js 16 App Router, Tailwind 4, shadcn/ui, tRPC 11 (route handler + SSE subscriptions)
  apps/runner       persistent Node process: job loop, Agent SDK sessions, git, checks, recovery
  packages/core     pure TypeScript: entities, Zod schemas, state machines, check classification,
                    finding fingerprints, tool policies, project-type registry (no I/O)
  packages/db       Drizzle schema, committed SQL migrations, typed repositories (better-sqlite3)
  plugin/skills     nextjs-audit, regression-fix, feature-implementation, architecture-review
  scripts/start.mjs one command: starts web and runner, prints the sign-in link, stops both
  fixtures/         a small Next.js + tRPC repo with seeded bugs, for tests and the real-SDK check
```

**Two processes, one source of truth.** SQLite (WAL mode) holds every entity and an
append-only `run_event` log. The web app writes commands (a queued run, a cancel request) and
pings the runner; the runner claims queued runs, executes them and appends events. The browser
gets progress through a tRPC SSE subscription that tails `run_event` from the last event id it
saw, so a reload, a dropped connection or a runner restart loses nothing. Large files (asset
versions, logs, diffs, check output) live in a content-addressed store (`blobs/sha256/…`) and
are referenced by hash.

Data folder: `%LOCALAPPDATA%\NextjsWorkspace` (override with `NWS_DATA_DIR`): `nws.db`,
`blobs/`, `worktrees/`, `logs/`, and the runner and sign-in tokens.

### Data model

| Entity | Key fields | Notes |
|---|---|---|
| Workspace | name, settings | One row now; every table carries `workspace_id` for later |
| Project | type, name, repo path, default branch, current config version | `type` = `code-studio` now; the type registry decides views, flows and settings schema |
| ProjectConfigVersion | instructions, tools, check commands, limits, inspected repo profile, sha256 | Immutable; every settings save is a new version |
| Asset / AssetVersion | scope (shared or project), kind, title, tags / version n, sha256, size, mime, blob | Versions are immutable; attachments pin a version or follow the latest |
| ProjectAsset, FlowAsset | links with an optional pinned version | Shared assets attach to many projects |
| Flow / FlowVersion | kind (audit, fix, feature, regression, architecture, assistant), scope / prompt template, tool policy, model, effort, caps, check policy, output kind, skills, sha256 | Built-in flows are seeded; editing makes a new version |
| Task | project, kind, title, source finding, branch, worktree, base revision, status | One branch and worktree per code task |
| Run | task, flow version, status, phase, base and head revision, input manifest + hash, caps, usage (cost, tokens, turns, time), SDK session id, heartbeat | The manifest freezes the exact flow, config, asset, skill, prompt, model, SDK, Claude Code and Node versions |
| RunEvent | run, seq, type, payload | Append-only; the progress stream and the log |
| Finding | project, origin run, kind (defect or architecture), category, severity, title, file, lines, evidence, impact, recommendation, confidence, verification, fingerprint, revision, status | Architecture advice is its own kind, shown in its own tab |
| CheckResult | run, check, command, revision, phase (baseline, agent, verify), status, classification, counts, failing test ids, log artifact | Bound to the commit it ran on |
| RunArtifact | run, kind, name, sha256, blob | Logs, diffs, patches, summaries, check output, transcripts |
| Review | task, revision, decision, note | Merge needs an approval of the exact head commit |

### Flows in Stage 1

**Import.** You give a local path. The server checks it is a git repo, then a deterministic
inspector (no Claude) reads `package.json`, the lockfile (package manager), workspaces and
Turbo, the router (`app/` or `pages/`), `tsconfig`, the lint, format and test tooling, the Node
pin (`.nvmrc`, `engines`, Volta), tRPC router files, `.env.example` names (never values), and
CLAUDE.md/AGENTS.md. Versions come from what is installed (`node_modules/<pkg>/package.json`),
falling back to the lockfile. The result is the first config version and the proposed check
commands, which you confirm.

**Audit (read-only).** A detached worktree at the current commit, so the audit is bound to
that revision and your working copy is never touched. Agent tools: Read, Glob, Grep and one
custom tool, `report_finding` (Zod schema). No shell, no edits, no web. A PreToolUse hook
keeps every path inside the worktree and refuses `.env*`. The runner checks each reported
finding: the file exists, the lines exist, and the quoted evidence is really there. If it isn't,
the tool tells the agent to re-read and report the exact lines. Findings appear in the UI as
they are reported. Re-audits match findings by fingerprint instead of duplicating them.

**Fix → verify → review.** From a finding: a task with its own branch (`nws/fix/<id>-<slug>`)
and worktree at the current base commit, dependencies installed from the lockfile with the
repo's own package manager, and baseline checks at the base commit (cached per commit). The
agent first confirms the finding still holds, then makes a scoped change with Read, Glob, Grep,
Edit and Write, plus `run_check` (typecheck, lint or tests by name, run by the runner, recorded).
Still no shell. The runner commits the change on the task branch, runs the verify checks on that
commit, and compares them with the baseline: new failures, pre-existing failures, fixed, skipped.
A fresh read-only verifier session judges whether the diff resolves the finding and names risks.
Files changed outside the finding's area are flagged. You review the actual diff with the checks
and the verdict next to it, then approve, ask for changes (a new run on the same worktree with
your notes), or discard. Merge is a separate step, offered only after an approval of the exact
head commit with no new failures, and only into a clean main checkout on the base branch;
otherwise it shows the command.

**Assistant.** A side panel on task, finding and run pages: a read-only session in that task's
worktree with the finding, diff and checks as context, resumed for follow-ups, streamed.

### Checks

- Commands are the repo's own scripts (`typecheck`, `lint`, `test`, `build`), or `tsc --noEmit`
  from the repo's installed TypeScript when there is no script. Never a shell string: npm runs
  as `node npm-cli.js run <script>`; other package managers through validated arguments.
- Node for checks: the repo's pinned version when it is installed (nvm-windows, nvm, fnm,
  Volta), otherwise the active one with a warning on the result. Both are recorded.
- A scrubbed environment: no API keys or tokens, `CI=1`; worktrees contain no `.env` files.
- Per-test results where the runner can read them (Vitest and Jest JSON, Node test TAP, `tsc`
  diagnostics); otherwise the check as a whole. Statuses: passed, failed, skipped, error, timed
  out, cancelled; classified against the baseline as new failure, pre-existing, fixed, or pass.
- A check that changes tracked files fails the result. Timeouts and cancel kill the process tree.

### Limits, cancellation, recovery

- Per run: max turns, max cost (USD), max wall time, set by the flow and the project; the
  runner aborts the session (AbortController) and records the reason.
- Global: at most 2 agent sessions and 1 check job at a time; one editing task per worktree.
- Cancel is a database flag plus a ping, so it holds even if the runner is restarting.
- At start the runner marks runs it didn't finish as interrupted (heartbeat older than 15 s);
  you can resume them (Agent SDK session resume) or retry them. Partial results, events and
  artifacts already written stay.

### Security

- Web and runner listen on 127.0.0.1 only. The web app checks the `Host` header (DNS
  rebinding) and the `Origin` of every mutation, and needs a session cookie (HttpOnly,
  SameSite=Strict) from the one-time sign-in link the start command prints.
- The runner token, the Anthropic credential and any GitHub token stay in the runner's
  environment and the data folder. No route returns them; every persisted text is redacted.
- Paths from the browser are accepted only on import; everything after that is by id.
- A nonce-based CSP through Next.js 16's `proxy.ts`.

### Interface

Global rail: Projects, Assets, Flows, Runs. Project pages: Tasks, Findings, Changes, Checks,
Architecture, plus Settings. The assistant opens as a side panel beside the active task.
shadcn/ui on Tailwind 4, Radix primitives (keyboard and screen-reader support), light and dark,
loading, empty and error states on every view, a findings table with filters, a real diff
viewer (unified and split), and a live run view.

### Engineering standards

- TypeScript strict, no `any`; Zod at every boundary (tRPC inputs, runner API, agent tool
  inputs, JSON columns, environment).
- Domain rules live in `packages/core` with unit tests: run and task state machines, check
  classification, fingerprints, path guards, redaction.
- The Agent SDK sits behind an `AgentClient` interface; tests use a scripted fake, the app the
  real SDK.
- Integration tests run the runner against real temporary git repos: audit, fix, verify,
  cancel, caps, recovery. tRPC routers are tested through `createCaller` on a temporary database.
- One end-to-end smoke test with Playwright driving the installed Edge (`channel: 'msedge'`, no
  browser download): import → audit (fake agent) → finding → fix → checks → diff → approve.
- ESLint, Prettier, a typecheck of every package, and a GitHub Actions workflow for the same.
- Structured logs (pino) per process.

### Stack (checked on npm, 2026-10-23)

| Package | Version | Note |
|---|---|---|
| next, eslint-config-next | 16.4.2 | Node ≥ 20.9 |
| react, react-dom | 19.3.1 | |
| typescript | 6.0.3 | Not 7.0.2: typescript-eslint 8.72 supports TypeScript below 6.1 |
| tailwindcss, shadcn (CLI) | 4.3.3, 4.22.1 | |
| @trpc/server, client, tanstack-react-query | 11.19.0 | |
| @tanstack/react-query | 5.104.5 | |
| zod | 4.6.7 | The Agent SDK's peer dependency is zod ^4 |
| drizzle-orm, drizzle-kit | 0.45.4, 0.31.11 | |
| better-sqlite3 | 13.0.3 | Node ≥ 22 (12.11.1 if Node 20 must work) |
| @anthropic-ai/claude-agent-sdk | 0.3.309 | Ships a Windows x64 Claude Code binary as an optional dependency |
| vitest | 5.0.5 | Node ≥ 22.12 (4.1.12 if Node 20 must work) |
| eslint, pino, tsx | 10.13.0, 10.4.0, 4.23.15 | |
| @playwright/test | latest | Drives the installed Edge |

### Agent SDK

Checked in the official docs (https://code.claude.com/docs/en/agent-sdk/overview and the
TypeScript, permissions, hooks, custom-tools, sessions and authentication pages) on 2026-10-23;
the version is from npm.

- `@anthropic-ai/claude-agent-sdk` 0.3.309, Node 18+. It bundles a native Claude Code binary
  per platform as an optional dependency (`npm ci --omit=optional` would break it), so the SDK
  version fixes the Claude Code version. Every run manifest records `claude_code_version` from
  the session's init message.
- Everything the runner needs exists: `query()` with `cwd`, `tools` (which built-ins exist at
  all), `disallowedTools`, `permissionMode: 'dontAsk'`, PreToolUse hooks as callbacks,
  `maxTurns`, `maxBudgetUsd` (ends with `error_max_budget_usd`), `abortController`, `resume`
  and `sessionId`, structured output (`outputFormat` with a draft-07 JSON Schema), and
  in-process tools (`createSdkMcpServer` + `tool()` with a Zod shape) for `report_finding` and
  `run_check`.
- What this means for the design:
  - `allowedTools` only pre-approves; it doesn't restrict. The runner sets `tools` to the exact
    built-ins, denies `Bash` and `PowerShell` by name, uses `dontAsk`, and enforces paths in a
    PreToolUse hook, the only check that runs on every call.
  - `settingSources` defaults to user, project and local: your `~/.claude` hooks and
    permissions would apply, and so would hooks in the target repo's `.claude/settings.json`,
    which run commands. The runner passes `settingSources: []` and puts the repo's CLAUDE.md
    and AGENTS.md into the prompt itself, read at the base commit, as the hub app does.
  - `env` replaces the whole environment, so the runner builds a scrubbed one (PATH, system
    folders, the Claude credential, nothing else).
  - A session can be resumed only on the PC that ran it.
- **Sign-in.** The documented path is `ANTHROPIC_API_KEY`, billed per token through the
  Console. The docs also say: "Unless previously approved, Anthropic does not allow third party
  developers to offer claude.ai login or rate limits for their products, including agents built
  on the Claude Agent SDK." They don't address a personal tool on your own machine.
  `claude setup-token` makes a one-year subscription token (`CLAUDE_CODE_OAUTH_TOKEN`),
  documented "for CI pipelines, scripts, or other environments where interactive browser login
  isn't available"; the docs don't name the SDK for it. With neither set, the bundled binary
  would probably use your existing login (not verified). For comparison, the hub app's run
  engine already runs `claude -p` on your claude.ai login. The runner accepts either variable
  from its own `.env`, and every run records which one it used (`apiKeySource`).

### Slices

| # | Slice | Size | Done when |
|---|---|---|---|
| **Stage 1** | | | |
| B1 | Scaffold: workspaces, strict TS, ESLint, Prettier, Vitest, CI, `scripts/start.mjs`, CLAUDE.md, `.env.example`, data folder, sign-in | M | `npm run dev` starts both processes on 127.0.0.1; sign-in works; lint, typecheck and tests green |
| B2 | Data layer: schema for every entity, migrations, repositories, seed of built-in flows | M | Migrations apply to an empty database; repository tests green |
| B3 | Runner core: job loop, event log, heartbeat, cancel, caps, recovery, runner API, `AgentClient` + fake | L | Integration tests for claim, cancel, cap and restart recovery |
| B4 | Repositories: import, inspector, git service (worktrees, commit, diff), check runner and classification | L | Inspector tests on fixture repos; checks classify a seeded pre-existing failure correctly |
| B5 | Audit flow with the real SDK, `report_finding`, evidence verification, fingerprints | M | A real audit of `fixtures/` finds the seeded bugs with correct file and lines |
| B6 | Fix → verify → review → merge, verifier session, scope warning | L | A real fix of one seeded bug: branch, worktree, checks bound to the commit, diff, approval, merge |
| B7 | Web UI: shell, Projects (import), project tabs, Assets (upload, versions, attach), Flows (read), Runs (list, live view), assistant panel | L | Every view has loading, empty and error states; keyboard checks; light and dark |
| B8 | Acceptance: Playwright smoke, a real run end to end, README and CLAUDE.md finished, a report | M | The Stage 1 flow works end to end, with what was and wasn't verified written down |
| **Stage 2** | | | |
| B9 | Feature, regression and architecture flows, with the four skills | L | Each flow runs on the fixture; architecture advice lands in its own tab |
| B10 | Flow configuration (edit → new version, per-project overrides) | M | A run records the version it used |
| B11 | Shared asset browsing across projects | S | Attach a shared asset to two projects |
| B12 | Optional GitHub integration: push the task branch and open a pull request after approval | M | Off unless configured; the token never reaches the browser; nothing is pushed without your click |

## Risks

- **Size.** Part B is a full application. The order above keeps a working flow at the end of
  each stage; Stage 2 starts only after B8.
- **Install time per task.** A frozen install per worktree is correct but slow on big
  monorepos. Plan: reuse a finished task's worktree folder for the next task and skip the
  install when the lockfile hash is unchanged. Linking the main checkout's `node_modules` is
  not an option: workspace packages would resolve to the main checkout's sources.
- **Windows paths.** Worktrees under the data folder plus deep `node_modules` can pass 260
  characters for some tools. The worktree root is a setting; a short path such as `C:\nws`
  may be needed.
- **Headless permissions are not a sandbox.** Edit runs run code the agent wrote when the
  checks run. The mitigations are the ones above (no shell, path guards, scrubbed environment,
  no `.env` in worktrees, review before merge), not isolation.
- **The hub repo is public.** This report has no Tattoogenda detail; keep it that way.

## Decisions needed

1. **Agent SDK sign-in**: see the Agent SDK section.
2. **Node 24 for the new project.** Recommended: Node 20 reached end of life in April 2026,
   and `better-sqlite3` 13 and Vitest 5 need 22+. The other PC would need `nvm install 24`
   for this project only; checks still run target repos on their own pinned Node. The
   alternative is pinning `better-sqlite3` 12 and Vitest 4 to keep Node 20 working.
3. **Installing npm dependencies** for `projects/nextjs-workspace` (the stack table, plus
   their transitive dependencies; a few hundred MB in `node_modules`).
4. **Commits**: one commit per slice on a branch (`project-model` in the hub; `main` in the
   new repo), nothing pushed. The new repo stays local until you want a GitHub remote.

## What was checked

- Read: the app's README, nav and cockpit code, the profile format, flows, the run record
  format, the findings store, uploads and assets, `.gitattributes`, the project template.
- Ran the full tool suite (results above) and found the line-ending cause with Node
  (`git ls-files --eol`: index LF, working copy CRLF).
- Package versions and engines from `npm view` today; Claude Code flags from `claude --help`.
- Not checked: the app in the browser (no screenshots taken), Tattoogenda itself (not cloned on
  this PC; only its private profile is here), and nothing was installed.
