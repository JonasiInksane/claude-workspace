---
title: CLAUDE.md, imports and rules
tags: [claude-code, claude-md, memory, rules, agents-md]
updated: 2026-10-20
claude_code_version: 2.1.304
---

# CLAUDE.md, imports and rules

**TL;DR:** CLAUDE.md files are context, not enforcement. Keep each one under 200 lines, `@import`
only what must always be loaded, move folder-specific rules into `.claude/rules/` with `paths:`,
and check what actually loaded with `/context`.

## Where instruction files live

| Scope | File | Shared? |
|---|---|---|
| Managed (IT policy) | `C:\Program Files\ClaudeCode\CLAUDE.md` | Machine-wide |
| User (all projects) | `~/.claude/CLAUDE.md` (= `%USERPROFILE%\.claude\CLAUDE.md`) plus `~/.claude/rules/*.md` | Only you |
| Project | `./CLAUDE.md` or `./.claude/CLAUDE.md`, plus `.claude/rules/*.md` | Committed |
| Local (personal) | `./CLAUDE.local.md` | Add it to `.gitignore` yourself |

## Load order

- Files are **concatenated**, broadest first: managed, user, project, local. Nothing overrides
  anything; conflicting lines simply both end up in context.
- `CLAUDE.md` and `CLAUDE.local.md` in the working directory **and every parent directory** load
  at launch, root first, so the file closest to your working directory is read last.
  In one directory, `CLAUDE.local.md` comes after `CLAUDE.md`.
- `CLAUDE.md` files in **subdirectories** load on demand: the first time Claude reads, writes or
  edits a file in that subdirectory.
- Folders added with `--add-dir` do not contribute their CLAUDE.md unless
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` is set.
- Block HTML comments (`<!-- ... -->`) are stripped before the text reaches Claude. A file over
  4 MiB is skipped.

Consequence for this workspace: a session started in `projects/<name>` also loads the hub
`CLAUDE.md` (it is a parent folder), including its `@context/...` imports.

## @imports

```markdown
@context/preferences.md
@context/goals.md
Knowledge lives in `knowledge/` (grep it before starting).
```

- Write `@path` anywhere in the text. Relative paths resolve from the **importing file**, not
  the working directory. Absolute paths and `@~/...` work too.
- Imports can nest up to **4 hops**.
- Escape spaces with a backslash: `@Design\ Docs/api.md`. A quoted path is not imported.
- **The backtick rule:** an `@path` inside backticks or a code fence is **not** imported. Use
  backticks to mention a file Claude should open on demand without loading it every session.
- Imported files load at launch, so they cost context every session. Splitting a big CLAUDE.md
  into imports does not make it cheaper. Import only what must always be loaded.
- The first import that resolves outside the working directory shows a one-time approval dialog.
  If you decline, those imports stay off.

## CLAUDE.local.md

- Current and supported (not deprecated). Loads right after `CLAUDE.md` in the same folder.
- **Not** auto-gitignored: add `CLAUDE.local.md` to `.gitignore`.
- It exists only in the worktree where you created it. For personal notes shared across
  worktrees, import a file from your home folder instead: `@~/.claude/my-notes.md`.
- It counts as a CLAUDE file, so it stops native AGENTS.md reading (see below).

## Path-scoped rules: `.claude/rules/`

Every `.md` file under `.claude/rules/` is discovered recursively.

- No frontmatter: loads at launch, like CLAUDE.md.
- With `paths:` frontmatter: loads only when Claude uses Read, Write or Edit on a matching file.
- `paths` is the only frontmatter field a rule reads.

```markdown
---
paths:
  - "app/**/*.{ts,tsx}"
  - "components/**"
---
# Next.js rules
- Server Components by default; add "use client" only where needed.
```

Use rules for "when working in X, do Y" instructions. They keep Next.js rules out of game
sessions and the other way round. This hub has rules for `knowledge/`, `reports/`, `library/` and
`templates/` in `.claude/rules/`.

## Size guidance

- Official target: **under 200 lines per CLAUDE.md**. This hub's house rule is under 120.
- Move part-of-the-codebase rules into path-scoped rules, and multi-step procedures into skills
  (see [Skills and subagents](skills-and-agents.md)).
- If something must happen every time (formatting, blocking a command), use a hook or a permission
  rule, not a CLAUDE.md line. See [Hooks on Windows](hooks-on-windows.md).

## AGENTS.md behaviour (v2.1.277+)

- Claude Code reads `AGENTS.md` (and `.claude/AGENTS.md`) natively **only when** there is no
  `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` in the working directory or any parent.
  `~/.claude/CLAUDE.md`, managed CLAUDE.md and `.claude/rules/` do not count for this check.
- As soon as a CLAUDE.md exists, AGENTS.md is ignored unless you import it. To share one rulebook,
  put `@AGENTS.md` on the first line of CLAUDE.md. It is never loaded twice.
- Alternative: `/config` > Project instructions = `claude-md-and-agents-md` (other values:
  `claude-md-or-agents-md` (default), `claude-md`, `managed-only`).
- Never read: `AGENTS.local.md`, `AGENTS.override.md`, anything under `.agents/`.
- Don't symlink CLAUDE.md to AGENTS.md on Windows (needs admin or Developer Mode, and Git may
  check the link out as a text file). Use `@AGENTS.md` instead.
- This workspace is Claude-only and has no AGENTS.md. To add Codex later, create AGENTS.md and
  put `@AGENTS.md` at the top of CLAUDE.md.
- **In this workspace a project's AGENTS.md never loads on its own:** the hub `CLAUDE.md` is a
  parent of every folder in `projects/`, so the check above always finds a CLAUDE.md. A project
  with an AGENTS.md always needs `@AGENTS.md` at the top of its own CLAUDE.md.
- Next.js 16.3+ writes an AGENTS.md block when `next dev` detects a coding agent; see the
  [Next.js checklist](../nextjs/project-checklist.md).

## Checking and editing

| Command | Use |
|---|---|
| `/context` | Context usage; look under "Memory files" to see which CLAUDE.md and rule files loaded |
| `/memory` | Open CLAUDE.md files for editing, toggle auto memory |
| `/init` | Draft a starter CLAUDE.md for a repo |
| `claude --safe-mode` | Start with CLAUDE.md, hooks, MCP and plugins disabled, to rule them out |

Source: https://code.claude.com/docs/en/memory
