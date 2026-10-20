---
title: Workspace structure v2
tags: [decision, workspace, structure, memory]
updated: 2026-10-20
claude_code_version: 2.1.304
---

# Workspace structure v2

**TL;DR:** The hub is a plain-file workspace for Claude Code only: a small always-loaded
`context/`, an on-demand `knowledge/`, an `inbox/` that gets triaged, and dated `reports/` with a
JSON registry. Tools are Node scripts, auto memory is off, and code work happens in project sessions.

## Context

- One user on Windows 11 (Windows PowerShell 5.1, Node 20, Git for Windows), working on Next.js
  apps and games (engine not chosen yet), beginner-to-intermediate with Claude Code 2.1.304.
- Version 1 had `pipelines/`, `library/`, `templates/`, `projects/` and a loose `notes/` folder.
  It had no place for raw input, deliverables or long-term lessons, and its CLAUDE.md loaded
  nothing automatically.
- Three reference workspaces were studied on 2026-10-20:
  - **Mr. Mak Workspace** (`witnesstodark/mr-mak-workspace`): `context/`, `knowledge/`,
    `processes/`, a gitignored `inbox/`, dated `workspace/` task folders registered in
    `workspace.json` as cards, plus a Tauri desktop app and skills mirrored between `.agents/`
    and `.claude/`.
  - **Daniel Rosehill's Claude-Workspace-Setup-Helper and Claude-Code-Notes**: a thin CLAUDE.md
    router pointing into `context/`, an intake folder, slash commands, a `/context-sweep` that only
    reports. Several linked repos now return 404, so it is idea material, not a template.
  - **anthropics/knowledge-work-plugins** (productivity plugin): plain files as the source of truth,
    a short CLAUDE.md as "hot cache" plus a `memory/` tree, skills that name exactly which file to
    read and write, and "draft, never send; archive, never delete" safety rules.
- Verified Claude Code facts that shaped the design: `@imports` load at launch and cost context;
  parent-folder CLAUDE.md files load in subfolder sessions; AGENTS.md is ignored once a CLAUDE.md
  exists; auto memory is on by default; `library/` is not a skill location; exec-form hooks need a
  real `.exe` (see the [claude-code notes](../INDEX.md)).

## Options

| Topic | Options considered |
|---|---|
| Layout | A. Mr. Mak's full layout incl. desktop app. B. Rosehill's thin router + `context/` read on demand. C. Plugin-packaged workspace (knowledge-work-plugins style). D. Hybrid: plain folders, no app, no plugin |
| Agent support | Claude-only, or Claude + Codex via `AGENTS.md` and `.agents/skills` mirrored to `.claude/skills` |
| Tool runtime | PowerShell scripts, Python, or Node `.mjs` with built-ins only |
| Memory | Claude's auto memory (on by default), or versioned files in the repo with auto memory off |
| Where to work | Everything from the hub folder, or hub sessions for workspace tasks plus project sessions inside `projects/<name>` |
| Skill placement | All skills global, all in the hub, or split by scope |

## Decision

1. **Layout D.** `context/` (four files under 40 lines each, `@`-imported by CLAUDE.md, always
   loaded); `knowledge/` (one topic per note, C3 frontmatter, found via `knowledge/INDEX.md` or
   grep, never imported); `inbox/` (drop zone, triaged by `/inbox-triage`, originals moved to
   `_processed/`, never deleted); `reports/` (dated folders plus `reports/reports.json`, revisions
   add steps to the same entry, as in Mr. Mak's cards). `notes/` is removed; decisions live in
   `knowledge/decisions/`.
2. **Claude-only.** No `AGENTS.md`, no `.agents/`. Mirroring skill trees (Mr. Mak) is maintenance
   with no benefit for one tool. Codex can be added later: create `AGENTS.md` and put `@AGENTS.md`
   at the top of CLAUDE.md.
3. **Node tools.** Every tool is `node tools/<name>.mjs` with built-ins only; `.ps1` and `.cmd`
   files only wrap Node. Node already exists for Next.js and web games, runs the same on every OS,
   and works in exec-form hooks. No Python, no jq.
4. **Auto memory off** (`"autoMemoryEnabled": false` in `.claude/settings.json`). `knowledge/` is
   the memory: versioned, greppable, reviewable in the navigator, and shared with every session.
   Hidden per-machine memory in `~/.claude/projects/...` would compete with it.
5. **Hub vs project sessions.** Start `claude` in the hub root for inbox, reports, knowledge and
   scaffolding. Start it inside `projects/<name>` for code work, so that project's
   `.claude/settings.json`, hooks and MCP servers apply. The hub CLAUDE.md still loads there (it is
   a parent folder), so it says that the project's CLAUDE.md is the authority.
6. **Skills split by scope.** Hub skills (`.claude/skills/`: inbox-triage, capture-lesson,
   project-report, new-project, write-handoff, day-recap, context-sweep) operate on the hub's
   folders. Library skills and agents (`library/`: onboard-project, nextjs-feature, game-feature;
   code-explorer, code-reviewer, playtester) are useful in every repo, so
   `node tools/install-library.mjs` copies them to `~/.claude/` (copies, not symlinks, which need
   admin rights or Developer Mode on Windows).

## Consequences

- Always-loaded context stays small; everything else costs nothing until it is read.
  `/context-sweep` and `node tools/check-workspace.mjs` keep files small and INDEX.md complete.
- Lessons only persist if someone files them: CLAUDE.md asks Claude to offer `/capture-lesson`
  at the end of a task. Nothing is remembered silently.
- Library edits need a re-install (`node tools/install-library.mjs`); editing `~/.claude/` directly
  would be overwritten.
- Project sessions see the hub CLAUDE.md and `context/` too. That is intended (identity and
  preferences apply everywhere), but hub-only rules must be phrased so they don't fire there.
- Adding Codex or another agent later is a small, additive change.
- The navigator (`index.html`) is generated and gitignored; it must work over `file://`, so the
  data is embedded, not fetched.
- Revisit if: the user starts using another coding agent daily, auto memory gains a shared or
  versioned mode, or the hub CLAUDE.md plus `context/` grows past about 200 lines in total.
