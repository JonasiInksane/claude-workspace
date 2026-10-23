# Build log: hub spec (Part A workspace app, Part B Nextjs-Workspace)

Living log for `report.md` (the plan) in this folder. Updated after every step, so the work can
be resumed in a new session or on another PC. Newest status first in each table; the log at the
bottom is chronological.

## How to resume

1. Read `report.md` (the plan) and this file.
2. Hub work is on branch **`project-model`** in `C:\dev\claude-workspace` (not pushed). Check
   `git log --oneline main..project-model` against the table below.
3. The new app is the separate repo `projects/nextjs-workspace` (local only, branch `main`).
   Its own `CLAUDE.md` and `docs/` describe its architecture.
4. Pick the first step that is not `done`. Workflow scripts used so far are listed under
   "Workflows"; a step marked `in progress` may have a partly merged branch: check
   `git branch --list "pm/*"` (hub) before redoing it.
5. Nothing is pushed anywhere. To continue on the other PC, push `project-model` (and later the
   new repo) first, or copy the folders.

## Decisions (2026-10-23)

| Topic | Decision | Why |
|---|---|---|
| Hub app stack | Keep plain Node + plain JS, zero npm dependencies, no build step | Existing decision; Part B uses the spec's stack |
| Agent SDK sign-in | **Subscription** via the local Claude Code login (user's choice). Visible setting: Subscription (local Claude account) or API (explicit Console key). In subscription mode the runner removes `ANTHROPIC_API_KEY` and provider overrides from the agent environment, keeps the user profile and `CLAUDE_CONFIG_DIR`, never uses `--bare`, records `apiKeySource` from the init message and stops a run that reports an API key | User: "we would not use api then ofc but the subscription usage" |
| Node for Nextjs-Workspace | Node 24 (`engines >=24`); target repos still run checks on their own pinned Node | Node 20 is EOL; better-sqlite3 13 and Vitest 5 need 22+ |
| TypeScript | 6.0.x, not 7.0 | typescript-eslint 8.72 supports TS < 6.1 |
| Commits | One commit per step; hub on `project-model`, new repo on its own `main`; nothing pushed | User approved |
| Execution | Multi-agent workflows (user's choice), each under ~10 agents; I merge and verify between workflows | User approved |
| Project folder | `projects/nextjs-workspace` (kebab-case rule); product name "Nextjs Workspace" | `tools/new-project.mjs` NAME_RE |
| Autonomy | Continue without asking; follow the plan's recommendations; record every further decision here | User, 2026-10-23 |

## Status

### Part A: workspace app (`tools/workspace-app`, branch `project-model`)

| Step | What | Status | Commit / branch |
|---|---|---|---|
| A0 | Line endings for test fixtures (`.gitattributes`) | done | see log |
| A1+A2 | Project types, tabbed project page, new navigation | todo | |
| A3 | Project settings and rules (versioned, private) | todo | |
| A4 | Asset library (shared and per project, versions) | todo | |
| A5 | Flows shared across projects, flow versions recorded | todo | |
| A6 | Run input manifest, attached assets into runs | todo | |
| A7 | Ask panel | todo | |
| A-review | Independent review of the whole Part A diff, fixes | todo | |
| A-docs | README, flows README, decision note, report revision | todo | |

### Part B: Nextjs-Workspace (`projects/nextjs-workspace`)

| Step | What | Status | Commit |
|---|---|---|---|
| B1+B2 | Scaffold, core types, data layer, architecture doc | todo | |
| B3 | Runner core | todo | |
| B4 | Import, inspector, git, checks | todo | |
| B5 | Audit flow (real SDK) | todo | |
| B6 | Fix, verify, review, merge | todo | |
| B7 | Web UI | todo | |
| B8 | Stage 1 acceptance | todo | |
| B9-B12 | Stage 2 | todo | |

## Workflows

| # | Name | Script | Run id | Result |
|---|---|---|---|---|

## Log

- 2026-10-23: Plan written and registered (`report.md`). Baseline: 1,176 tests, 2 failing
  (CRLF fixtures). Agent SDK facts checked in the docs (see report, "Agent SDK").
- 2026-10-23: Decisions taken (table above). Branch `project-model` created.
- 2026-10-23: A0 done: `tools/workspace-app/test/fixtures/** -text` in `.gitattributes`,
  fixtures refreshed from the index (269 files, 0 with CR). Workspace app suite: 1,122 tests,
  1,121 pass, 0 fail, 1 skipped.
