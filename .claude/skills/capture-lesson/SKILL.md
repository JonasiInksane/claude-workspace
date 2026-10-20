---
name: capture-lesson
description: Saves a lesson, gotcha or decision as a knowledge note in knowledge/<area>/ and keeps knowledge/INDEX.md in sync, updating an existing note instead of creating a duplicate. Use when the user says "capture this lesson", "save this gotcha", "add this to knowledge", "write that down for next time", "log this decision", or right after solving a problem worth keeping.
argument-hint: "<the lesson in a sentence or two>"
---

# Capture lesson

Turn one lesson into a short, findable knowledge note and list it in `knowledge/INDEX.md`.

Lesson: `$ARGUMENTS`
If that is empty, take the lesson from the current conversation and state it in one sentence before writing.

## Step 1: Route it
| The lesson is... | Goes to |
|---|---|
| How something works, a gotcha, a command or setting that worked | `knowledge/<area>/<kebab-name>.md` |
| A choice between options, with reasons | `knowledge/decisions/YYYY-MM-DD-topic.md` |
| A personal preference about how the user likes work done | `context/preferences.md`: ask first, keep that file under 40 lines |
| A fact about one project only | that project's `CLAUDE.md` or docs: suggest it, don't write from the hub |

Areas: `claude-code`, `nextjs`, `gamedev`, `decisions`. Add a new area only if none fits, and say so.

## Step 2: Check what exists
1. Read `knowledge/INDEX.md`.
2. Grep `knowledge/` for 2-3 key terms of the lesson (tool names, error text, setting names).
3. If a note already covers the topic, update that note: add the new point in the right section, bump `updated`. Only create a new note for a new topic.

## Step 3: Write the note
New notes use exactly this shape (keep under ~150 lines):

```markdown
---
title: Hooks on Windows
tags: [claude-code, hooks, windows]
updated: 2026-10-20
claude_code_version: 2.1.304
---

# Hooks on Windows

TL;DR: one or two sentences that answer the question on their own.

## Details
- The concrete steps, commands (PowerShell first), paths and settings.

## Example
A short, working example.

## Source
- Where this was learned (docs link, project, date). Mark anything untested as "unverified".
```

- `title` and the H1 are identical. Today's date goes in `updated`.
- Add `claude_code_version` only for notes about Claude Code behaviour; get it with `claude --version`.
- Decision notes use the sections `## Context`, `## Options`, `## Decision`, `## Consequences` instead of Details/Example.

## Step 4: Update knowledge/INDEX.md
- New note: add one row, keeping the existing order and grouping:
  `| [Hooks on Windows](claude-code/hooks-on-windows.md) | claude-code, hooks, windows | 2026-10-20 | Exec-form hooks with node work without Git Bash. |`
- Updated note: change the Updated date (and the Summary if it changed) in its row.
- Match the format of the existing rows.

## Step 5: Confirm
Reply with exactly:

```markdown
Saved: knowledge/claude-code/hooks-on-windows.md (new | updated)
TL;DR: <the TL;DR line>
INDEX.md: row added | row updated
```

## What not to do
- **Don't create a duplicate.** One topic, one file. Update the existing note.
- **Don't write vague notes.** Include the exact command, path, setting or version.
- **Don't record unverified Claude Code behaviour as fact.** Mark it "unverified" or link https://code.claude.com/docs.
- **Don't put secrets, tokens or personal data in a note.**
- **Don't edit `context/` files without asking.**
- **Don't skip INDEX.md.** A note that isn't listed fails `node tools/check-workspace.mjs`.

## After
Suggest at most 3 next steps, for example:
- Capture a related lesson from the same session.
- `/context-sweep` if this area now has overlapping notes.
- `node tools/check-workspace.mjs` to confirm the index is complete.
