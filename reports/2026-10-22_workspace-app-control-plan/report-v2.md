# Workspace app control panel: build status and remaining work

2026-10-22, Claude Code 2.1.307. Revision 2 of this plan. `report.md` (the design) and
`mockup.html` (the UI) are unchanged; this file says what is built and what is left.

## Summary

- **Built (paused mid-way):** wave 1 (module split, spec, CLI spike) and wave 2 (11 backend
  packages). The full tool suite passes: 1,025 tests, 0 failures, 1 skipped (Node 24.11.1).
- **Not built yet:** the server wiring (routes, engine start-up, recovery), every new screen
  (Today, cockpit, launcher, live run, review gate, palette), and the final acceptance checks.
- **Open from wave 2:** four review/fix steps were stopped before they finished (WP4, WP8 and
  WP10 fixes, WP11 review). Their open findings are listed below.
- **Biggest risk:** the hub repo is public, and this folder (`build/SPEC.md`, `mockup.html`,
  `report.md`) contains Tattoogenda security detail. Make the repo private.
- **Next step:** finish the four wave-2 steps, then wave 3a (wiring), as described below.

## Where everything is

| What | Where |
|---|---|
| Design (behaviour authority) | `report.md` |
| UI (visual authority) | `mockup.html` |
| Build spec: modules, data formats, API, UI, safety rules, work packages, acceptance checks | `build/SPEC.md` |
| Corrections from real `claude -p` runs (win over the spec) | `build/ADDENDUM.md` |
| Raw spike results | `build/SPIKE.md` |
| Developer guide to the module layout | `build/GUIDE.md` |
| Code | branch `app-control-panel`, `tools/workspace-app/` (plus `tools/lib/projects.mjs`, `private-data.mjs`) |
| Generic stage prompts and the example profile | `pipelines/app/` |
| Tattoogenda profile (private) | `%LOCALAPPDATA%\claude-workspace\profiles\tattoogenda.json` on the first PC only |

Paths inside the build docs that point at a `...\Temp\claude\...\scratchpad\` folder only existed
on the first PC. The spike fixtures from there are already copied into
`tools/workspace-app/test/fixtures/stream/`.

## Status per package

| Package | Built | Reviewed | Fixed | Note |
|---|---|---|---|---|
| Wave 1: module split | yes | screenshots identical | - | `build/GUIDE.md` |
| WP1 link, flows, launch | yes | yes | yes | |
| WP2 data, profile, settings | yes | yes | yes | Wrote the private TG profile on the first PC |
| WP3 TAP, baseline | yes | yes | yes | |
| WP4 check runner | yes | yes | **no** | 3 medium findings open |
| WP5 G0 gates | yes | yes | yes | |
| WP6 probes, metrics | yes | yes | yes | |
| WP7 findings, fun, reports | yes | yes | yes | |
| WP8 git, worktree | yes | yes | **no** | 1 medium finding open |
| WP9 Claude stage | yes | yes | yes | |
| WP10 engine core | yes | yes | **no** | 2 medium findings open |
| WP11 pipelines, executor | yes | **no** | **no** | Needs an independent review |

### Open review findings (medium)

- **WP4** `runs/executor.mjs:845` + `gates/commands.mjs:238`: `planChecks` now skips G4 unless the
  caller passes `listening`; the executor's `ensureBaseline` doesn't pass it.
- **WP4** `gates/check.mjs:510`: the must-tick check (safety rule R8) matches case-sensitively,
  unlike `gates/fences.mjs`, which uses `nocase`. Windows paths ignore case.
- **WP4** `gates/commands.mjs:337` (fix belongs in `runs/settings.mjs`, WP9): check programs come
  from the tree's `node_modules`, which an EDIT stage could write into. Add Edit/Write deny rules
  for `<tree>/node_modules/**` in EDIT stage settings, or run checks only after verifying it.
- **WP8** `runs/worktree.mjs:154`: any detached HEAD counts as "branch mode on" when the marker
  file exists; check the recorded commit too.
- **WP10** `runs/manager.mjs:196`: `shutdown()` drops executor writes that are still being handled
  and doesn't wait for the `handling` map.
- **WP10** `runs/manager.mjs:330`: a run file that can't be read is treated as missing, which frees
  its lock. Treat read errors as "keep the lock".

The low-severity findings are in the wave-2 transcript on the first PC only; they are not needed.

## Remaining work, in order

Each step is one Claude session (or one multi-agent workflow) on branch `app-control-panel`.
Start every session with: "Read `reports/2026-10-22_workspace-app-control-plan/report-v2.md`,
then `build/ADDENDUM.md` and the SPEC sections named in the step."

### Step 0: set up the second PC (about 15 minutes)

1. `git fetch; git switch app-control-panel`, then `node tools/run-tests.mjs`. Expect all green.
   This is also the first run on Node 20.15.1: note any failure (SPEC §0 lists the APIs to avoid).
2. Create the private profile: copy `build/SPEC.md` §2.6 into
   `%LOCALAPPDATA%\claude-workspace\profiles\tattoogenda.json`, then fix the paths for this PC
   (the TG checkout path, `isolation.worktreePath`). Validate it with
   `profile/profile.mjs` (`loadProfile`). The app will later offer "Create from the example".
3. `node tools/check-workspace.mjs`. With the profile present, the private-data check flags
   tracked files with TG markers; the files in this folder are known and intended.

### Step 1: finish wave 2 (half a day)

- Fix the six open findings above.
- Independently review WP11 (`runs/{catalog,prompts,intent,actions,executor}.mjs` and
  `pipelines/app/**`) against SPEC §3 WP11 and the ADDENDUM (A5 project instructions, A15
  structured-output retry), then fix what it finds.
- Done when the tests are green and every finding is fixed or answered.

### Step 2: wave 3a, integration (1-2 days; SPEC §7 "Wave 3a")

Three packages with disjoint files, can run in parallel:
- **W3-WIRING**: `app.mjs` (merge route tables, `getEngine`), `server.mjs` (`isBusy` from the
  engine, `manager.recover()` before listening, `shutdown()` on every exit path: ADDENDUM A11),
  `state.mjs` additions, `runs/wiring.mjs` (real deps; `--fake-claude` test flag gated on
  `WS_APP_TEST=1`), `routes/{runs,events}.mjs`, `test/e2e.test.mjs`, README sections,
  `test/fixtures/runs/` (one run per status).
- **W3-ROUTES**: `routes/{cockpit,checks,findings,metrics,settings,today}.mjs` with tests (SPEC §4).
- **W3-UI-SHELL**: `index.html`, `main.js`, `lib.js`, `store.js`, `dialog.js`, `app.css` (mockup
  tokens, theme toggle), `parts/{palette,intent,sparkline,bar,status}.js`, stub views (SPEC §5.1).
- Done when the e2e test with fake-claude passes (Explain, Review, Refactor to commit on a
  synthetic repo) and every route answers with the SPEC §4 shapes.

### Step 3: wave 3b, screens (2-3 days; SPEC §7 "Wave 3b", §5.2-5.12)

Six packages, parallel, each with its own view and CSS file: UI-TODAY, UI-COCKPIT (cockpit and
health), UI-LAUNCHER, UI-RUN, UI-REVIEW, UI-LISTS (runs, library, projects with Link, flows with
the ask field). Build each against the dev server with fake-claude and fixture runs. Done when
each screen matches the mockup, shows every listed state and passes a keyboard-only check.

### Step 4: wave 4, acceptance (1 day; SPEC §7 "Wave 4", 22 checks)

Run the 22 acceptance checks in order. Add these from the ADDENDUM:
- a real CHECK stage asked to run `cat package.json` must be denied by the guard hook;
- one real run confirms `--append-system-prompt` is accepted.
Checks 5, 10, 11 and 22 touch Tattoogenda and need you present: link the checkout, run the
architecture scan and findings import (both read-only), set up `tg-run` (`npm ci`; your OK), one
real Explain and one real Review. No real edit run or commit in TG unless you ask.

### Step 5: wrap up (half a day)

- Update `tools/workspace-app/README.md`, `flows/README.md` and `pipelines/README.md`.
- A knowledge note `knowledge/claude-code/headless-runs.md` from `build/SPIKE.md` and the
  ADDENDUM, stamped `claude_code_version: 2.1.307`, plus a decision note
  `knowledge/decisions/2026-10-22-app-pipelines.md`.
- Merge `app-control-panel` (and `assets-view`, which it is based on) when you are happy.

## Decisions already made

- Every app-side part of the plan is built. No Tattoogenda edits; S2 and the TG-side guardrails
  are out of scope.
- Checks run on whatever Node is active (24.11.1 here, 20.15.1 on the other PC); the version goes
  into baselines and proofs.
- `tg-run` worktree isolation with branch-mode fallback; the app commits on your click and never
  pushes or merges; Opus for scope, implement and review, Sonnet for prove, explain and triage.
- TG data (profile, runs, findings, metrics, baselines) lives in `%LOCALAPPDATA%\claude-workspace\`.
- You chose to push this folder although the repo is public.

## Also in this commit

- Sprite work from another session (`ui/sprite-dialog.js`, `ui/sprite-viewer.js`,
  `sprites.test.mjs`, `assets.mjs`) was in the working tree; its tests pass and it is committed
  separately.

## What was checked and what wasn't

- **Checked:** `node tools/run-tests.mjs` (1,025 tests, 0 failures, 1 skipped) and
  `node tools/check-workspace.mjs` (0 errors) on Node 24.11.1, just before the commit.
- **Not checked:** Node 20; the app in a browser after wave 2 (no new screens exist yet, and the
  existing ones were last compared after wave 1); anything against the real Tattoogenda repo.
