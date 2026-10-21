---
title: Permissions and settings
tags: [claude-code, settings, permissions, security, windows]
updated: 2026-10-21
claude_code_version: 2.1.306
---

# Permissions and settings

**TL;DR:** Settings are strict JSON files that merge across scopes, and permission rules are
checked deny, then ask, then allow. On Windows write every Bash rule twice (Bash and PowerShell),
protect secrets with `Read(...)` deny rules (`.claudeignore` does nothing), and remember that
committed allow rules only apply after the folder is trusted.

## Settings files and precedence

Highest first:

| # | Source | Notes |
|---|---|---|
| 1 | Managed (policy) | Set by IT; cannot be overridden |
| 2 | `--settings <file-or-json>` | Command line, this session only |
| 3 | `.claude/settings.local.json` | Personal, per project. Keep it out of git |
| 4 | `.claude/settings.json` | Shared, committed |
| 5 | `~/.claude/settings.json` | User, all projects (`%USERPROFILE%\.claude\settings.json`) |

- Array keys such as `permissions.allow` **merge** across files instead of replacing.
- A deny rule from any scope beats an allow rule from any scope.
- Project settings are read from the folder where you start `claude`. Start it in the repo root.
- Edits are picked up live. `/status` shows which sources loaded; `claude doctor` validates them.
- Under `claude -p`, a settings file that fails validation is silently ignored. Check with `claude doctor`.

## Strict JSON and $schema

No comments, no trailing commas. Add the schema line for editor validation and autocomplete:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": ["Bash(node tools/*)", "PowerShell(node tools/*)"],
    "deny": ["Read(.env)", "Read(.env.local)", "Read(.env.*.local)", "Read(.env.production)"]
  },
  "autoMemoryEnabled": false
}
```

That is the core of this hub's `.claude/settings.json` (it also has hooks; see
[Hooks on Windows](hooks-on-windows.md)).

## How rules are evaluated

- Order: **deny, then ask, then allow**. The first match in that order wins; a more specific rule
  does not beat a broader one.
- A hook that returns "allow" never overrides a deny or ask rule.
- Read-only commands (`ls`, `cat`, `grep`, read-only `git`, ...) already run without a prompt.
- Modes (`defaultMode` or `--permission-mode`): `default` (shown as Manual), `acceptEdits`, `plan`,
  `auto`, `dontAsk`, `bypassPermissions`. `auto` and `bypassPermissions` are **ignored** when set in
  project or local settings. `"disableBypassPermissionsMode": "disable"` blocks bypass entirely.

## Rule syntax

| Rule | Matches |
|---|---|
| `Bash(npm run build)` | Exactly `npm run build` (not `npm run build --watch`) |
| `Bash(npm run *)` | `npm run` plus anything; a trailing ` *` also matches the bare command. Too broad for real projects: it approves deploy and reset scripts too |
| `Bash(node tools/build-index.mjs *)` | One script by exact name. Never `Bash(node tools/*)`: it also matches `node tools/../anything` |
| `Bash(npm run test:*)` | Legacy, same as `Bash(npm run test *)`; `:*` works only at the very end |
| `Bash(ls*)` | Also matches `lsof`: the space before `*` matters |
| `PowerShell(Get-ChildItem *)` | Same shape. Case-insensitive; aliases (`gci`, `ls`, `dir`) are normalized |
| `WebFetch(domain:example.com)` | Only the bare domain; `domain:*.example.com` for subdomains |
| `mcp__github`, `mcp__github__*`, `mcp__github__create_issue` | MCP servers and tools (no parentheses) |

A compound command (`a && b`, `a | b`) must match a rule for **each** part.

## Bash and PowerShell twins (Windows)

- Claude Code on Windows can run commands through the **Bash** tool (Git Bash) or the
  **PowerShell** tool. With a claude.ai account the PowerShell tool is on by default next to Bash,
  and without Git Bash it is the only shell.
- A `Bash(...)` rule does **not** cover the PowerShell tool. Write both:
  `"Bash(npm run lint)"` and `"PowerShell(npm run lint)"`.
- With Git Bash installed, any Bash **deny** rule turns the PowerShell tool off unless a PowerShell
  rule exists or `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` is set.

## Protecting secrets: Read deny rules

- `.claudeignore` has **no effect**. Use `permissions.deny` with `Read(...)` rules.
- Path anchors (gitignore syntax): `//c/abs/path` absolute, `~/path` home, `/path` relative to the
  settings file's project root (in user settings: `~/.claude/`), `path` or `./path` relative to cwd.
  A bare filename matches at any depth: `Read(.env)` = `Read(**/.env)`.
- Windows paths are normalized to POSIX: `C:\dev\app` becomes `/c/dev/app`; `//c/**/.env` matches
  every `.env` on drive C.
- A Read deny also blocks Edit and Write on that path, and Bash readers Claude Code recognizes
  (`cat`, `head`, `tail`, `sed`, `tee`, redirects). It does **not** stop a script (`node x.js`) that
  opens the file itself.
- `Write(...)` and `Glob(...)` path rules are never consulted; use `Edit(...)` or `Read(...)`.
- `Read(./.env.*)` also matches `.env.example`. If Claude should read the example file, deny the
  real files one by one, as this hub does.

## Workspace trust

The first time you run `claude` in a folder it asks whether you trust it.

- Until you accept: `permissions.allow`, `permissions.additionalDirectories`,
  `extraKnownMarketplaces`, `enableAllProjectMcpServers` and most `env` values from a committed
  `.claude/settings.json` are **not applied**. `deny` and `ask` rules apply immediately.
- `claude -p` (and any piped run) skips the trust dialog, and hooks from settings files still run.
  Only use `-p` in repos you trust.
- Trust is per folder: trusting the workspace root does not cover `projects/<name>`; each folder
  gets its own entry (`hasTrustDialogAccepted` per path in `~/.claude.json`). Verified
  2026-10-21 on 2.1.306: a `claude -p` run in an untrusted `projects/game-dev` refused
  `node tools/asset.mjs new ...` although its `.claude/settings.json` allowed it; after starting
  `claude` there once and accepting the dialog, the same rule applied. Open each project
  interactively once before relying on its allow list (or on headless runs there).
- `additionalDirectories` lives under `permissions`, grants file access only, and loads no
  skills or CLAUDE.md from those folders.

## settings.local.json and git

Claude Code adds `**/.claude/settings.local.json` to your global git excludes only when **it**
writes the file. A file you create by hand is not excluded, so list it in `.gitignore` anyway.
On Windows it lives next to `.claude/settings.json` in the folder where you started `claude`.

## env and autoMemoryEnabled

- `"env": { "KEY": "value" }` applies to the session and the processes it starts, and overrides the
  same variable from your shell. Most env values from a committed file wait for workspace trust.
- Auto memory is on by default. Its index is `~/.claude/projects/<project>/memory/MEMORY.md`; the
  first 200 lines or 25 KB load at every session start.
- Turn it off per project with `"autoMemoryEnabled": false` in `.claude/settings.json`, or for a
  shell with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. `/memory` also has a toggle.
- This hub turns it off because `knowledge/` is the memory: see
  [the structure decision](../decisions/2026-10-20-workspace-structure.md).

## Useful commands

| Command | Use |
|---|---|
| `/permissions` | View and edit allow, ask and deny rules |
| `/fewer-permission-prompts` | Scan your transcripts and propose an allowlist for `.claude/settings.json` |
| `/status` | Version, model, account and loaded settings sources |
| `claude doctor` | Read-only check of install health and settings validity |

Sources: https://code.claude.com/docs/en/settings and https://code.claude.com/docs/en/permissions
