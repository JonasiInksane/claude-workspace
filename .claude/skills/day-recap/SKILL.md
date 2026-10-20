---
name: day-recap
description: Summarizes what happened in the workspace on one day (default today) from reports/reports.json, git history, inbox/_processed/<date>/, handoffs and knowledge notes updated that day, and shows the recap in chat without writing files. Use when the user asks "what did I do today", "recap yesterday", "daily summary", "what changed on <date>", or at the end of a work day.
argument-hint: "[YYYY-MM-DD | today | yesterday]"
---

# Day recap

Answer "what happened on this day?" from the workspace's own records. Read only; output in chat.

Date: `$ARGUMENTS`. Accept `YYYY-MM-DD`, `today` or `yesterday`; if empty, use today's local date. If the date is unclear, ask.

## Step 1: Collect the sources
Use `<date>` = the resolved `YYYY-MM-DD` everywhere below.

1. **Reports**: read `reports/reports.json`. Entries with `created` = `<date>` are new; entries with `updated` = `<date>` (and an earlier `created`) were revised.
2. **Workspace git**: if `git rev-parse --is-inside-work-tree` succeeds in the workspace root, run
   `git log --since=<date>T00:00:00 --until=<date>T23:59:59 --oneline --name-only`.
   Always include both times, so the window is exactly that day.
3. **Project repos**: for each folder in `projects/` that has a `.git` folder, run the same command with `git -C projects/<name> log ...`.
4. **Inbox**: list `inbox/_processed/<date>/` (items filed that day) and `inbox/handoffs/<date>-*.md` (handoffs written that day).
5. **Knowledge**: grep `knowledge/` for notes whose frontmatter has `updated: <date>`.

If a source doesn't exist (no git repo, no `reports.json`), skip it and say so in one line at the end.

## Step 2: Write the recap in chat
Use exactly this format. Leave out sections that have nothing in them.

```markdown
## Recap for 2026-10-20 (Tuesday)

**In short:** one or two sentences on the main thing that got done.

### Reports
- New: My app audit (audit, my-app) - reports/2026-10-20_my-app-audit/
- Revised: Workspace setup (added Report v2)

### Commits
- workspace: 3 commits - "Add capture-lesson skill", ...
- projects/my-game: 5 commits - "Player dash", "Fix jump buffer", ...

### Knowledge
- Updated: Hooks on Windows (knowledge/claude-code/hooks-on-windows.md)

### Inbox and handoffs
- Filed 4 items (inbox/_processed/2026-10-20/)
- Handoff: inbox/handoffs/2026-10-20-auth-redirect-fix.md

### Loose ends
- Active reports not updated in 7+ days, items still waiting in inbox/, the open handoff's next step.

Not checked: <sources that were missing>
```

If nothing at all is found, reply: "Nothing recorded for <date>." and list which sources you checked.

## What not to do
- **Don't write, move or change any file.** The recap lives in chat only.
- **Don't invent activity.** Only report what the sources show.
- **Don't drop the `T00:00:00` / `T23:59:59` times from the git command.** They pin the window to that day.
- **Don't dump full diffs or file contents.** Subjects and paths are enough.

## After
Suggest at most 3 next steps, for example:
- `/inbox-triage` if items are still waiting.
- `/write-handoff` to leave a clean starting point for tomorrow.
- `/project-report <project> status` for a project with a lot of activity.
