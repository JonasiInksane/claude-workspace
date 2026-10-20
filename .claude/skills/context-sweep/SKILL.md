---
name: context-sweep
description: Report-only housekeeping for CLAUDE.md, context/ and knowledge/ that finds oversized or stale files, notes missing from knowledge/INDEX.md, duplicate topics and context/ files over 40 lines, then suggests fixes and applies none without a yes. Use when the user says "clean up context", "sweep the knowledge base", "is my context too big", "tidy up knowledge", or about once a week.
argument-hint: "[context | knowledge] (optional, default both)"
---

# Context sweep

Keep the always-loaded context small and the knowledge base tidy. Look, report, suggest; change nothing without a yes.

Scope: `$ARGUMENTS` (`context`, `knowledge`, or empty for both).

## Step 1: Measure the always-loaded files
- Count lines in `CLAUDE.md` (limit 120 in this workspace) and each `context/*.md` (limit 40 each).
- These load into every session, so every extra line costs context. Flag anything over its limit.
- Flag details that belong elsewhere: how-tos or long lists in `context/` belong in `knowledge/`; project facts belong in that project's `CLAUDE.md`.

## Step 2: Check knowledge/
For every `knowledge/**/*.md` except `INDEX.md`:
- Frontmatter on line 1 with `title`, `tags`, `updated`; H1 equal to `title`; a TL;DR line.
- Over 150 lines: suggest a split.
- `updated` older than 90 days: stale candidate (suggest re-checking, not deleting).
- `claude_code_version` older than the installed version (`claude --version`): suggest re-verifying the note.
- `knowledge/INDEX.md`: notes without a row, rows pointing to missing files, and dates that don't match the note.
- Duplicates: notes with overlapping titles, tags or TL;DRs. Suggest which one to keep and merge into.
- If `tools/check-workspace.mjs` exists, run `node tools/check-workspace.mjs` and include its knowledge and link errors.

## Step 3: Report and WAIT
Show exactly this, then stop and wait for the reply:

```markdown
## Context sweep - 2026-10-20

| Area | Files | Lines | Over limit |
|---|---|---|---|
| CLAUDE.md | 1 | 84 | - |
| context/ | 4 | 131 | goals.md (52 > 40) |
| knowledge/ | 17 notes | 1,240 | 1 note over 150 |

### Suggestions
| # | File | Problem | Suggested fix |
|---|---|---|---|
| 1 | context/goals.md | 52 lines (limit 40) | Move the "Someday" list to knowledge/decisions/2026-10-20-someday-ideas.md |
| 2 | knowledge/nextjs/env-vars.md | not in INDEX.md | Add its row |
| 3 | knowledge/gamedev/input.md + knowledge/gamedev/controls.md | same topic | Merge into input.md; archive controls.md |
| 4 | knowledge/claude-code/hooks-on-windows.md | written for an older Claude Code version | Re-verify against the docs |

Nothing has been changed. Reply "yes" to apply all, or list the numbers to apply.
```

If everything is within limits, say so in one line and stop.

## Step 4: Apply only what was approved
- Shorten by moving text, not by dropping facts: move details into a knowledge note and leave a one-line pointer.
- Merges: combine the content into the kept note, bump its `updated`, and fix links to the old note.
- Never delete. Once its content is merged into the kept note, move a superseded note to `inbox/_processed/<today>/` (the workspace archive) and remove its INDEX.md row.
- Keep `knowledge/INDEX.md` in sync with every change.
- Finish by running `node tools/check-workspace.mjs` (if it exists) and report the result.

## What not to do
- **Don't change, move or create anything before the user says yes.**
- **Never delete a file.** Archive it instead.
- **Don't drop facts when shortening.** Move them to `knowledge/`.
- **Don't rewrite `context/identity.md` or personal preferences** beyond the approved change.
- **Don't touch `projects/` or other `inbox/` items.**
- **Don't call a Claude Code note wrong without checking.** Flag it for re-verification.

## After
Suggest at most 3 next steps, for example:
- `/capture-lesson` to fill a gap the sweep revealed.
- `/inbox-triage` if items are waiting.
- Run the sweep again next week.
