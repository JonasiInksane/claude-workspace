---
title: The workspace app's project model
tags: [decision, workspace-app, projects, settings, assets, flows, runs, provenance]
updated: 2026-10-23
claude_code_version: 2.1.309
---

# The workspace app's project model

**TL;DR:** Every project gets a tabbed page whose tabs come from its type (`code`, `assets`,
`generic`). A project's rules and settings, and the asset library (shared and per project), are
stored as immutable, hashed versions in private places (the data folder, the gitignored inbox).
Runs freeze an input manifest of exactly what they started with; flows can target any project and
record their version. An Ask panel starts a read-only Explain run about a run or finding. All of it
stays plain Node with no dependencies, in `tools/workspace-app`.
Plan and build log: [hub spec plan](../../reports/2026-10-23_hub-spec-plan/report.md),
[progress](../../reports/2026-10-23_hub-spec-plan/progress.md).

## Context

- A spec for "a workspace for projects" asked for projects with their own instructions, tools,
  assets and settings; assets and flows shared across projects; runs that record exact inputs; and
  an assistant beside the active task. The app had one cockpit page per profiled project, images
  per folder without versions, flows fixed to one project, and no per-project rules.
- The hub repo is public. Tattoogenda's details must not land in tracked files.
- Two PCs (Node 20 and Node 24); the tools must run on both and need no npm install.

## Options

| Topic | Options considered |
|---|---|
| Project screens | Keep the cockpit and add screens; or one tabbed page for every project with tabs from a type registry |
| Where rules and settings live | In the project repo (CLAUDE.md edits); in the hub repo; in the private data folder as versions |
| Asset storage | Inside project repos; a database; files in the gitignored inbox with `asset.json` and `v<N>` files |
| How runs see assets | Paths into the library; copies in the run's `inputs/` with hashes |
| Run provenance | Trust `run.json` as is; a manifest frozen at the start with its own hash |
| Assistant | A chat with its own state; Explain runs with a context reference, chained by `parent` |
| Isolation per task | A worktree per task; one run worktree per project (kept) |

## Decision

1. **A type registry** (`project-types.mjs`): `code` (has a private profile), `assets` (has an
   asset pipeline), `generic`. Each type lists its tabs; every project has a page
   `#project/<name>/<tab>`; old `#cockpit/` and `#health/` links redirect.
2. **Rules and settings as immutable versions in the data folder**
   (`projects/<name>/settings/v<N>.json`, with hash; stale saves 409; saves every session would
   refuse are a 400). Runs record the version and get the rules as a
   `<project_instructions source="workspace-rules@v<N>">` block; sessions get them as
   `--append-system-prompt` through a Node spawn argument, never PowerShell.
3. **An asset library in the inbox** (`_assets/<id>/` shared, `<project>/_assets/<id>/` own):
   content checked by bytes, no SVG even as text, each new content a new version with its SHA-256,
   a `revision` for metadata changes. Projects and flows attach a ref, following the latest or
   pinned to a version.
4. **Runs copy attached assets into `inputs/assets/`** and verify them against the library hash;
   prompts get them as `<data kind="asset">` blocks (titles only as escaped attributes). Sessions
   may read asset folders and get an `Edit` deny rule for each.
5. **A frozen input manifest per run** (`runs/manifest.mjs`): template hashes, profile hash,
   settings version, asset versions, models, versions, hub commit, plus `manifestSha256`. A
   hand-edited manifest stays visible, can be stopped, and never goes on.
6. **Shared flows:** `project: "*"` asks for a project at launch; every launch records the flow's
   hash, hub commit and asset versions (`sessions.jsonl` and `flow-runs.jsonl`). A flow's asset
   refs live in `flows/*.md` and are therefore public; the user accepted that (asset titles are
   not sensitive) and the editor and `flows/README.md` say so.
7. **Ask = Explain runs with a context reference** (`runs/context.mjs`): the page sends only a
   reference; the server builds a capped, redacted context from its own records; follow-ups chain
   by `parent`.
8. **Kept:** one run worktree per project (a Tattoogenda install per task is too slow and too
   big); the app never pushes or merges. Per-task worktrees belong to the separate Next.js app
   (Part B of the plan).

## Consequences

- Private data stays out of the public repo, except project names and asset ids in flow files.
- Every run can be explained after the fact: which prompts, rules, assets and models it used.
- Settings and assets add two places to back up: the data folder
  (`%LOCALAPPDATA%\claude-workspace`) and `inbox/attachments/`. Neither syncs between the PCs.
- A missing or changed attached asset blocks starts in that project until it is fixed in Settings.
- The deny rule's path form on Windows follows the docs (`//c/...`,
  https://code.claude.com/docs/en/permissions, read for 2.1.309); case-insensitive matching is not
  documented and not tested, and a script that writes files itself is only caught at the next
  start.
- Built in three waves of parallel agents plus an independent review (0 high, 9 medium, about 25
  low findings, all fixed); 1,537 tests on 2026-10-23.
