---
paths:
  - "knowledge/**"
---

# Knowledge notes

`knowledge/` is this workspace's long-term memory (auto memory is off here). One topic per
file, read on demand: grep `knowledge/` or scan `knowledge/INDEX.md` before starting a task.

## File format
- Path: `knowledge/<area>/<kebab-name>.md`. Areas: `claude-code`, `nextjs`, `gamedev`,
  `decisions`. Add a new area only when none fits, and tell the user.
- Frontmatter starts on line 1 and is required:

  ```yaml
  ---
  title: Human title
  tags: [tag-a, tag-b]
  updated: YYYY-MM-DD
  claude_code_version: 2.1.304   # only for notes about Claude Code behaviour
  ---
  ```
- Body: an H1 identical to `title`, then a 1-2 sentence TL;DR, then the content.
- One topic per file, ideally under 150 lines. Split a note rather than let it grow.
- Decisions go in `knowledge/decisions/YYYY-MM-DD-topic.md` with the sections
  `## Context`, `## Options`, `## Decision`, `## Consequences`.

## Keep knowledge/INDEX.md in sync
- Every note has exactly one row in the table in `knowledge/INDEX.md`:
  `| [Title](area/file.md) | tags | YYYY-MM-DD | one-line summary |`. Links are relative to `knowledge/`.
- New note: add its row (keep the order and grouping INDEX.md already uses).
- Changed note: bump `updated` in the frontmatter AND in its row; update the summary if it changed.
- Renamed or moved note: fix its row and any links to it from other notes.
- `node tools/check-workspace.mjs` fails when a note is missing from INDEX.md. Run it after bigger changes.

## Writing rules
- Grep `knowledge/` for the topic first. Update the existing note instead of adding a duplicate.
- Be concrete: exact commands (PowerShell first; this is a Windows machine), paths, settings, versions.
- Claude Code facts must be verified (official docs or tested in this version). If unsure, write
  "unverified" or link https://code.claude.com/docs instead of guessing.
- Never put secrets, tokens, passwords or `.env` values in a note.
- Link other notes with relative links; put file paths and commands in backticks.
