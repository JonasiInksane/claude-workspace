# Workspace setup

Date: 2026-10-20 · Claude Code 2.1.304 · Status: done

## Summary

- **Where it stands:** the workspace is rebuilt (v2) around small always-loaded context,
  on-demand knowledge, an inbox that gets triaged, and registered reports.
- **How it runs:** Windows-first, PowerShell 5.1 compatible, with Node as the only scripting runtime.
- **Biggest gap:** `context/identity.md` and `context/goals.md` are still empty templates,
  so Claude doesn't know you yet.
- **Next step:** fill in your context, run `Setup.ps1 -Mode Install`, and accept the trust
  prompt the first time you start Claude here.

## What was built

| Area | What changed |
|---|---|
| `CLAUDE.md` | Rewritten as a short router. It imports the four `context/` files and points to everything else |
| `context/` | New: identity, preferences, goals and stack. Small files Claude reads in every session here |
| `knowledge/` | New home for lessons, how-tos and decisions (replaces `notes/`), with `INDEX.md` as the catalog |
| `inbox/` | New drop zone. `/inbox-triage` files items and moves originals to `inbox/_processed/` |
| `reports/` | New: dated report folders plus the `reports.json` registry (this report is the first entry) |
| `.claude/` | Hub settings (permissions, SessionStart and after-edit hooks, auto memory off), path-scoped rules, hub skills |
| `pipelines/` | New daily workflow (`00-daily-workflow.md`); existing pipelines corrected |
| `library/` | Global skills and agents, corrected; installed by `tools/install-library.mjs` |
| `templates/` | Split into `templates/nextjs/` and `templates/game/` folders that `new-project` copies |
| `tools/` | Node scripts: navigator with dashboard, installer, self-check, report registry, project scaffolding, hooks |
| Root | `Setup.ps1`, `setup.sh`, `Start Workspace.cmd`, `start.ps1`, `.gitignore`, `.gitattributes`, `.env.example`, `.mcp.json` |

Design choices, in short:

- **Context vs knowledge.** `context/` is always loaded, so it stays tiny (under 40 lines per
  file). `knowledge/` can grow, because Claude only reads what the task needs.
- **Auto memory off.** `knowledge/` is the memory: plain files you can read, edit and version.
- **Archive, don't delete.** Inbox items are moved, reports are archived by status.
- **Windows-first.** PowerShell 5.1 compatible scripts; Node is the only scripting runtime.

## How to start

1. Open PowerShell in the workspace folder.
2. Run the setup check:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1
```

   Check mode is the default and changes nothing.

3. Start Claude in the workspace folder: double-click `Start Workspace.cmd` and choose `[W]`,
   or type `claude`. The SessionStart hook gives Claude today's date, the inbox, active
   reports and your projects (the launcher also prints it). Ask it what needs attention.
4. Read the daily loop in [pipelines/00-daily-workflow.md](../../pipelines/00-daily-workflow.md).

## What's left for you

- [ ] Fill in [context/identity.md](../../context/identity.md) (role, experience, what you're building).
- [ ] Fill in [context/goals.md](../../context/goals.md) (now, this month, someday).
- [ ] Complete the TODO lines in [context/stack.md](../../context/stack.md) once you pick your
      Next.js stack and game engine.
- [ ] Check [context/preferences.md](../../context/preferences.md) and change any default you don't like.
- [ ] Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1 -Mode Install`.
      It installs the library into `~/.claude`, builds `index.html`, runs the self-check and
      offers to `git init` the workspace.
- [ ] The first time you run `claude` here, accept the trust prompt so the workspace's
      allow rules apply.
- [ ] Optional: if you skipped it during setup, make the workspace a git repo (`git init`)
      so your knowledge and reports are versioned.
- [ ] Add your first project: `/new-project <name> nextjs` or `/new-project <name> game`,
      then start Claude inside it and run `/onboard-project`.

## How to check it

```powershell
node tools/check-workspace.mjs
node tools/build-index.mjs
```

The first prints one line per check and ends with "N errors, M warnings". The second
rebuilds `index.html`; open it to see the dashboard.
