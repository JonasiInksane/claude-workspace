# Hub spec: Part A done, Part B in progress

2026-10-23, revision of [report.md](report.md) (the plan), Claude Code 2.1.309, Node 20.15.1 on
this PC. The day-by-day record is [progress.md](progress.md).

## Summary

- **Part A is built, reviewed and merged** on branch `project-model` (pushed, not merged into
  `main`): tabbed project pages for every project type, versioned project rules and settings, a
  versioned asset library (shared and per project), shared flows that record their version, an
  input manifest on every run, and an Ask panel. Full suite: 1,537 tests, 1,536 pass, 0 fail,
  1 skipped (the baseline was 1,176 with 2 failing).
- **An independent review found no high-severity problems.** It found 9 medium and about 25 low
  ones, all fixed, each with a test where the code allowed one. The worst mediums were: the run
  engine could fail to start on a hand-edited `run.json`; a session could edit the "immutable"
  asset files; asset titles reached prompts outside the data fence.
- **Biggest remaining risk:** the Ask panel has run only against the fake Claude, never the real
  one; that is the one "done when" condition still open. Second: the asset deny rule for sessions
  is built from the docs and not tested in a real session.
- **Part B** (`projects/nextjs-workspace`) can continue only on the other PC: the repo is local
  there and not pushed. B0 is done; B1+B2 were running there.
- **Recommended next step:** one real Ask run on a project (it uses your subscription), then
  merge `project-model` into `main` once you have used the new screens for a while.

## Part A against the plan

| # | Slice | Status | Notes |
|---|---|---|---|
| A0 | Line endings | done | A checkout made before A0 still needs its fixtures refreshed once (progress.md has the command); agent worktrees can check out with CRLF too |
| A1+A2 | Project types, tabbed page, navigation | done | Old cockpit and Health links redirect; review found no lost features |
| A3 | Project settings and rules | done | Settings tab with versions, Compare and an unsaved-changes guard; a save that every session would refuse is a 400 |
| A4 | Asset library | done | Library and project Assets screens; text uploads that could be SVG are refused, at the price of some Markdown that starts with HTML |
| A5 | Shared flows, flow versions | done | The flow's hash, hub commit and asset versions are now in `sessions.jsonl` too (the review found them missing) |
| A6 | Run manifest | done | Inputs card on the run page, checked in the browser with a real run against the fake Claude |
| A7 | Ask panel | done, one check open | Works end to end with the fake Claude in tests and in the browser; one real run still to do |
| A-review | Independent review and fixes | done | Four reviewers by area, four fix branches, then a review of the fixes (2 medium, 5 low, fixed) |
| A-docs | README, flows README, decision note, this revision | done | [Decision note](../../knowledge/decisions/2026-10-23-project-model.md) |

### Where the plan was wrong or changed

- **Checks tab.** The plan's table called "passed / failed / skipped / pre-existing shown
  separately" already met. It wasn't: the check history kept only new, known and flaky
  failures. Fixed; lines written before the fix show only their failures.
- **Flow asset refs are public.** A flow's attached assets are saved in `flows/*.md`, which the
  public hub repo commits, so project names and asset ids (made from titles) become public. You
  chose to keep it that way and document it.
- **Sessions and asset folders.** The plan said sessions may read the assets' folders. Read
  access alone also allowed edits, so sessions now get an `Edit` deny rule per folder as well.

## What was checked

- Every branch's tests on its own, then the merged result in a fresh checkout, after each merge.
- `node tools/check-workspace.mjs`: 0 errors, the 5 known warnings about old reports.
- Headless Edge screenshots, light and dark, of the Settings tab, the asset library, a project's
  Assets tab, Flows, run pages and Findings. A scratch script drove a real Explain run in the
  example app: the Inputs card, the refusal when an attached asset is missing, and the Ask panel
  (open, ask, answer, Escape). No console errors.
- **Not checked:**
  - a real Claude Ask run;
  - the deny rule in a real Claude session;
  - the app on Tattoogenda itself (not cloned on this PC);
  - the other PC (Node 24) since the merges.

## Open items

1. One real Ask run (uses your subscription).
2. An unexplained uncommitted change to `tools/workspace-app/runs/actions.mjs` in the main
   checkout on this PC (Retry for a run that failed before its stage started). None of the build
   agents made it; it waits for you.
3. Part B on the other PC: push `projects/nextjs-workspace` (or copy it) to continue here.
4. Merge `project-model` into `main` when you are happy with it.
