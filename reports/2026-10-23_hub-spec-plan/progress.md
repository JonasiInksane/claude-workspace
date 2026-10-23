# Build log: hub spec (Part A workspace app, Part B Nextjs-Workspace)

Living log for `report.md` (the plan) in this folder. Updated after every step, so the work can
be resumed in a new session or on another PC. Newest status first in each table; the log at the
bottom is chronological.

## How to resume

1. Read `report.md` (the plan) and this file.
2. Hub work is on branch **`project-model`** in `C:\dev\claude-workspace`. It and the `pm/*`
   slice branches are on `origin`; the wave-2 merges are local until pushed. Check
   `git log --oneline main..project-model` against the table below.
3. The new app is the separate repo `projects/nextjs-workspace` (local only, branch `main`, only on
   the Node 24 PC without nvm; not in `projects/repos.json`).
   Its own `CLAUDE.md` and `docs/` describe its architecture.
4. Pick the first step that is not `done`. Workflow scripts used so far are listed under
   "Workflows"; a step marked `in progress` may have a partly merged branch: check
   `git branch -a --list "*pm/*"` (hub) before redoing it.
5. To continue on the other PC, push `project-model` (and the new repo) first, or copy the
   folders. On a checkout made before A0, refresh the test fixtures once (see the log,
   2026-10-23 wave-2 merge), or three run tests fail on CRLF.

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
| Flow asset refs | Flows keep their `assets:` refs in `flows/*.md` (public hub repo); the flow editor warns that a project asset's id becomes public, and `flows/README.md` says so | User: "write it down. they aint sensitive" (Tattoogenda asset titles are not sensitive) |

## Status

### Part A: workspace app (`tools/workspace-app`, branch `project-model`)

| Step | What | Status | Commit / branch |
|---|---|---|---|
| A0 | Line endings for test fixtures (`.gitattributes`) | done | see log |
| A1+A2 | Project types, tabbed project page, new navigation | done (merged `aecd2b0`) | `pm/w1a-project-page` |
| A3 | Project settings and rules (versioned, private): backend + session/run injection | done (merged `9531143`) | `pm/w1b-project-settings` |
| A4 | Asset library (shared and per project, versions): backend | done (merged `fe0f6d0`) | `pm/w1c-asset-library` |
| A5 | Flows shared across projects, flow versions recorded | done (merged `75fab0f`) | `pm/w1d-shared-flows` |
| A3/A4 UI | Settings tab, Assets tab and library screens | done (merged `00369b6`); review state unknown, covered by A-review | `pm/w2a-settings-assets-ui` |
| A6 | Run input manifest, attached assets into runs, flows and sessions; wave-1 follow-ups | done (merged `eb3f13b`); review state unknown, covered by A-review | `pm/w2b-run-provenance` |
| A7 | Ask panel | done (merged `f5355af`) | `pm/w2c-ask-panel` |
| A-review | Independent review of the whole Part A diff, fixes | in progress: review done (0 high, 7 medium, ~20 low), fixes on 4 branches | `pm/w3a..w3d` |
| A-docs | README, flows README, decision note, report revision | todo | |

### Part B: Nextjs-Workspace (`projects/nextjs-workspace`)

| Step | What | Status | Commit |
|---|---|---|---|
| B0 | Repo, pinned toolchain install, architecture doc, 5 decision records, CLAUDE.md, tooling configs | done | `d3d23ec`, `4b6a63c` (nextjs-workspace) |
| B1+B2 | Scaffold of every package, core domain, data layer, start command, auth, shell, skills, CI | in progress (WF-B1) | |
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
| WF-A1 | `hub-app-wave-1`: 4 slices (A1+A2, A3 backend, A4 backend, A5), each implement → review-and-fix in its own worktree | `~/.claude/projects/C--dev-claude-workspace/5108b4b5-cc8f-4f47-adae-6ce3174930d6/workflows/scripts/hub-app-wave-1-wf_05cd4a1a-2f8.js` | `wf_05cd4a1a-2f8` | done: 8 agents, all slices ready-with-notes |
| WF-A2 | `hub-app-wave-2`: Settings/Assets UI, run provenance + follow-ups, Ask panel; implement → review-and-fix | `.../workflows/scripts/hub-app-wave-2-wf_d4458441-b73.js` | `wf_d4458441-b73` | ended without a recorded result; the uncommitted slice work was saved by hand as `w2a additions` and `additions` and pushed; merged on the nvm PC (see log) |
| WF-B1 | `nws-foundation`: core+db ‖ apps skeleton (same checkout, disjoint folders, no agent commits), then integrate + review | `.../workflows/scripts/nws-foundation-wf_7d149b2a-dab.js` | `wf_7d149b2a-dab` | running |

Resume a workflow in the same session with `Workflow({scriptPath, resumeFromRunId})`. In a new
session the run cache is gone: check which `pm/*` branches exist and have commits, and rerun only
the missing slices (the briefs are in the script file).

## Log

- 2026-10-23: Plan written and registered (`report.md`). Baseline: 1,176 tests, 2 failing
  (CRLF fixtures). Agent SDK facts checked in the docs (see report, "Agent SDK").
- 2026-10-23: Decisions taken (table above). Branch `project-model` created.
- 2026-10-23: A0 done: `tools/workspace-app/test/fixtures/** -text` in `.gitattributes`,
  fixtures refreshed from the index (269 files, 0 with CR). Workspace app suite: 1,122 tests,
  1,121 pass, 0 fail, 1 skipped.
- 2026-10-23: Added `tools/workspace-app/test/shots.mjs` (headless Edge screenshots over the
  DevTools protocol, no dependencies; `--example` = temporary workspace with synthetic code,
  asset-pipeline and plain projects and the sample runs). Commits ab5305e, 4ff8677.
- 2026-10-23: WF-A1 launched (run `wf_05cd4a1a-2f8`). Slice branches `pm/w1a..w1d`, merged
  into `project-model` by hand afterwards.
- 2026-10-23: Decision: prepare Part B (new repo, architecture doc, dependency install) in
  parallel with WF-A1 to save time; the two share no files.
- 2026-10-23: B0 done in `projects/nextjs-workspace` (local git repo, branch `main`): pinned
  stack installed (619 packages), `docs/architecture.md` (the contract for all Part B agents),
  `docs/decisions/0001..0005`, CLAUDE.md, README, tooling (tsconfig base, Vitest projects,
  ESLint with import-direction rules, Prettier). Verified: better-sqlite3 13 on Node 24 (SQLite
  3.53.4, WAL), the SDK's bundled Claude Code 2.1.309 reports the claude.ai login, ESLint 10 runs
  eslint-config-next's rules. Decisions: ESLint 10 kept (9 is EOL; plugin peer ranges cosmetic),
  `@eslint/js` + `globals` added, new package `packages/repo` (read-only repo access).
- 2026-10-23: WF-B1 launched (run `wf_7d149b2a-dab`), parallel to WF-A1.
- 2026-10-23: WF-A1 done (2 h 40 min). Reviews: w1a 2 medium + 3 low fixed; w1b 1 medium + 1 low
  fixed; w1c 3 low fixed; w1d 4 low fixed. Open lows went into WF-A2's follow-ups (stale
  "cockpit" messages, fence wording, flow preview, route list test) or stay noted (PDF inline in
  Edge unverified; flow-runs.jsonl not rotated). Note: workflow worktrees start at `main`, not
  the checked-out branch; WF-A2 briefs branch from `project-model` explicitly.
- 2026-10-23: Merged the four branches into `project-model` (README and `app.mjs` conflicts
  resolved by hand, both sides kept). Full suite: 1,364 tests, 1,363 pass, 0 fail, 1 skipped.
  check-workspace: only the two known private-marker errors in the old control-plan folder.
  Merged-app screenshots checked. Workflow worktrees removed (all clean).
- 2026-10-23: WF-A2 launched (run `wf_d4458441-b73`).
- 2026-10-23: Wave 2 picked up on the nvm PC (Node 20.15.1, Claude Code 2.1.309; no WF-A2
  script or run cache, no `projects/nextjs-workspace` there). Branch state: w2c has four agent
  commits (backend, UI, README, a cap-reason fix); w2b has three agent commits plus a hand-saved
  `additions` commit (launch, flows, project settings, flows and run UI); w2a is one hand-saved
  `w2a additions` commit. Whether WF-A2's review-and-fix stage finished for w2a and w2b is not
  known, so A-review must cover them in full. w2a and w2b don't update the README yet (A-docs).
  Each branch alone: full suite green (w2a 1,424 tests, w2b 1,415, w2c 1,388; 0 fail, 1 skipped).
- 2026-10-23: Merged w2a, w2b, w2c into `project-model` (`00369b6`, `eb3f13b`, `f5355af`).
  Conflicts only between w2b and w2c, both additive: the `VARS` list in `runs/prompts.mjs`
  (`assets` and `context`, both kept) and the imports of `routes/runs.test.mjs` (both kept).
  Checked by hand: w2b's `routes/runs.mjs` changes (manifestOk, Settings-tab message) survived
  w2c's move of the run file readers to `runs/run-files.mjs`; `explain/answer.md` has both
  `{{assets}}` and `{{context}}`. Full suite in a fresh worktree of the merge: 1,499 tests,
  1,498 pass, 0 fail, 1 skipped. check-workspace: 0 errors, 5 known warnings. Screenshots
  (shots.mjs with nvm's Node 23.2.0, `--example --seed test/seed-library.mjs --fixtures`, light
  and dark): Settings tab, project and global Assets, Flows, the explain and review-gate run
  pages with the Ask button, Findings, and sample-art's Assets; no console errors. Not checked:
  the run page's Inputs card (the fixture runs predate manifests), the Ask panel opened, a real
  Ask run.
- 2026-10-23: CRLF on the nvm PC: its main checkout still has CRLF copies of 239 fixture files
  (`git ls-files --eol` shows `i/lf w/crlf attr/-text`; A0's refresh only ran on the other PC),
  so three run tests fail there (run-review, run-diff, contextText) while a fresh checkout
  passes. Fix once per old checkout: delete the `w/crlf` files under
  `tools/workspace-app/test/fixtures` and `git checkout -- tools/workspace-app/test/fixtures`.
  Note: Git Bash's `grep` hides CR bytes; use `git ls-files --eol` to check. Done on the nvm PC
  (user approved); `project-model` pushed (fast-forward to `145aa47`, user approved).
- 2026-10-23: Extra UI check (scratch script driving the example app with the fake Claude, Node
  23): a real Explain run with settings v3 and four attached assets shows the Inputs card
  (settings version, each asset with version, pinned or latest, hash; models; versions; "matches
  its hash"); a settings version that attaches a missing asset refuses the run (400) as designed;
  the Ask panel opens with focus in the question box, a question gets its answer and sources,
  Escape returns focus to the Ask button; no console errors. Still not done: one real Ask run.
- 2026-10-23: A-review: four independent read-only reviewers (code-reviewer agents) over
  `git diff ac14380 project-model`, split by area with no overlap: backend stores and launch;
  runs engine and prompts; Settings/assets/Ask UI; project page and navigation. No high findings.
  Medium: (1) `saveRun` throws on a tampered manifest and `recover()` doesn't catch it, so the
  engine can fail to start; (2) asset titles (default: the uploaded file name) sit outside the
  `<data>` fence in stage prompts and in sessions' appended system prompt; (3) sessions get asset
  folders as `additionalDirectories` and can edit the immutable files; (4) flow hash and hub
  commit are not in `sessions.jsonl` (A5); (5) the Checks tab can't show passed/skipped because
  `historyLine` drops them (the plan's "Met" was wrong); (6) a cancelled upload in New asset
  keeps going and later closes whatever dialog is open; (7) Settings/Assets still say runs don't
  read attached assets. About 20 lows (caps, races between loads and saves, history entries,
  focus, SVG prolog bypass of a text upload, settings saves that every launch then refuses).
  Left for the user: flow `assets:` refs in `flows/*.md` expose private project asset ids (made
  from titles) in the public hub repo.
- 2026-10-23: Fixes running in parallel, one agent per area, each in its own worktree on a branch
  from `project-model`: `pm/w3a-runs-fixes` (runs engine), `pm/w3b-backend-fixes` (library,
  settings, sessions, flows), `pm/w3c-ui-fixes` (Settings, library dialogs, flows dialog, Ask
  panel, leave guard), `pm/w3d-project-page-fixes` (Checks counts, nav, routing, Overview).
  File ownership is disjoint; each agent confirms a finding before fixing it.
- 2026-10-23: The Claude Code process restarted mid-way and stopped agents A and B; the user
  stopped C by accident. All work was committed except B's last finding, which B finished after
  a resume. Result: A 5/5 findings fixed (4 commits), B 7/7 (7), C 9/9 (9), D 6/6 (6); every
  finding confirmed real. Notable choices: a run whose run.json was edited by hand can still be
  stopped (a save that stops it and writes back exactly the manifest on disk is allowed) and keeps
  showing `manifestOk: false`; asset folders reach sessions readable plus a deny rule
  `Edit(//c/<path>/**)` (docs: https://code.claude.com/docs/en/permissions, Claude Code 2.1.309;
  case-insensitive matching on Windows not documented; a script writing files is still only
  caught by `verifyFiles` at the next start); a text upload that starts with `<` and has an
  `<svg>` element or the SVG namespace anywhere is refused (Markdown or JSON showing an `<svg>`
  sample still passes); assets get a `revision` used as `expect` for rename and archive (409).
  Merged into `project-model` (w3a, w3c, w3d, then w3b; no conflicts). Plus `678afc3`: the flow
  editor and `flows/README.md` say a flow's asset refs are public (user's decision).
- 2026-10-23: Unexplained: an uncommitted change to `runs/actions.mjs` and its test (Retry for a
  run that failed before its current stage started) appeared in the main checkout at about 09:52.
  None of the four fix agents made it; asked the user. Saved as
  `scratchpad/stray-actions.patch`; left uncommitted.
- 2026-10-23: Agent worktrees are created under `.claude/worktrees/` (git-ignored) and may check
  out with CRLF fixtures (`core.autocrlf=true`); three run tests then fail there for the A0 reason.
