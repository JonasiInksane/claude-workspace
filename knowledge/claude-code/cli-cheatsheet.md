---
title: Claude Code CLI cheatsheet
tags: [claude-code, cli, shortcuts, slash-commands]
updated: 2026-10-20
claude_code_version: 2.1.304
---

# Claude Code CLI cheatsheet

**TL;DR:** The flags, keys and slash commands worth remembering in Claude Code 2.1.304, checked
against `claude --help` and the docs. For the full workflow (terminal layout, scripting, worktrees)
read the pipeline [pipelines/04-claude-cli.md](../../pipelines/04-claude-cli.md).

`claude --help` does not list every flag (for example `--max-turns` is missing). Full list:
https://code.claude.com/docs/en/cli-reference

## Starting sessions

| Command | What it does |
|---|---|
| `claude` | Interactive session in the current folder (start in the repo root) |
| `claude "explain the auth flow"` | Session with a first prompt |
| `claude -c` | Continue the most recent conversation in this folder |
| `claude -r` / `claude -r <id-or-name> ["prompt"]` | Pick a session to resume, or resume one directly |
| `claude -n settings-page` | Name the session (shown in the `/resume` picker) |
| `claude --permission-mode plan` | Start in plan mode (also `acceptEdits`, `auto`, `dontAsk`, `manual`) |
| `claude --model opus` | Model alias: `opus`, `sonnet`, `haiku`, `fable`, `opusplan`, or a full ID |
| `claude --effort high` | Effort: `low`, `medium`, `high`, `xhigh`, `max` |
| `claude --add-dir ..\shared-lib` | Grant file access to another folder (not restored on resume) |
| `claude -w feature-x` | New git worktree in `.claude/worktrees/feature-x` and start there |
| `claude --agent code-reviewer` | Run the whole session as a subagent definition |
| `claude --chrome` | Enable Claude in Chrome for browser testing |
| `claude --safe-mode` | All customizations off (CLAUDE.md, hooks, MCP, plugins): for troubleshooting |

## Headless and scripting (`-p`)

| Command | What it does |
|---|---|
| `claude -p "question"` | Print the answer and exit. Skips the trust dialog; only use in trusted repos |
| `claude -c -p "check for type errors"` | Continue the last conversation headlessly |
| `--output-format json` | Metadata envelope; the answer is the `.result` string |
| `--json-schema '<schema>'` | Validated structured output, read from `.structured_output` |
| `--max-turns 3`, `--max-budget-usd 2.00` | Cap a run (print mode only) |
| `--allowedTools "Bash(npm test *),PowerShell(npm test *)"` | **Pre-approves** these; other tools still exist |
| `--tools "Read,Grep,Glob"` | **Restricts** the tool set |
| `--permission-prompts none` | Anything that would prompt is denied automatically |
| `--append-system-prompt "..."` / `--append-system-prompt-file rules.md` | Extra system instructions |
| `--bare` | Minimal run: skips CLAUDE.md discovery, hooks and auto memory; auth only via `ANTHROPIC_API_KEY` or an `apiKeyHelper`, never your subscription login |

A `-p` run starts in Manual mode, so tool calls that need approval are denied unless
`--allowedTools`, `--permission-mode` or a hook allows them. Settings files that fail validation
are silently ignored under `-p`; check them with `claude doctor`.

Windows PowerShell 5.1 gotchas (see [Claude Code on Windows](windows-setup.md)):

- It pipes non-ASCII text as `?`. Before `Get-Content x | claude -p ...` run
  `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)`, or let Claude read the file itself.
- It strips the inner quotes from `'{"type":"object"}'`. Pass JSON flags (`--json-schema`,
  `--agents`, `--settings`) as `'{\"type\":\"object\"}'`, or give `--settings` a file path.

## Shell commands

| Command | What it does |
|---|---|
| `claude doctor` | Read-only health check (install, settings, auto-update) |
| `claude update` | Update now (native installs also auto-update) |
| `claude mcp list` / `add` / `get` / `remove` | Manage MCP servers ([MCP servers](mcp-servers.md)) |
| `claude plugin install <name>@<marketplace>` | Install a plugin |
| `claude --version` | Print the version |

## Keys

| Key | What it does |
|---|---|
| `Shift+Tab` | Cycle modes: Manual, accept edits, plan, (bypass), auto. `Alt+M` on Windows terminals without VT input |
| `Esc` | Stop the current response or tool call; work done so far is kept |
| `Esc Esc` (empty prompt) | Rewind menu: restore code and/or conversation, or summarize |
| `Ctrl+C` | Interrupt; on an idle prompt, first press clears input, second exits |
| `Ctrl+B` | Move a running command (dev server, watcher) to the background |
| `Alt+V` | Paste an image from the clipboard (Windows). `Win+Shift+S` to snip first |
| `Shift+Enter` or `Ctrl+J` | New line in the prompt (Shift+Enter works natively in Windows Terminal) |
| `Alt+P` | Switch model without clearing the prompt |
| `Ctrl+G` | Open the proposed plan in your editor |
| `@path` | Mention a file or folder (`@app/page.tsx`) |
| `!` at line start | Shell mode: run a command, output goes into context |
| `Up` | Recall earlier input |

## Slash commands

| Command | What it does |
|---|---|
| `/init` | Draft a starter CLAUDE.md |
| `/plan <task>` | Enter plan mode with a task |
| `/clear` | New conversation (old one stays in `/resume`) |
| `/compact [focus]` | Summarize the conversation, e.g. `/compact keep the API decisions` |
| `/context` | Context usage grid; shows which memory files loaded |
| `/rewind` | Checkpoint menu (aliases `/checkpoint`, `/undo`). Bash-made changes are not rewound |
| `/resume` | Session picker |
| `/model`, `/effort` | Switch model or effort |
| `/memory` | Edit CLAUDE.md files, toggle auto memory |
| `/permissions` | Allow, ask and deny rules |
| `/hooks`, `/mcp` | Inspect hooks; MCP status, login, reconnect |
| `/agents` | In 2.1.304 only prints a reminder: ask Claude to create agents, or edit `.claude/agents/` |
| `/tasks` | Running background shells and subagents |
| `/diff` | View uncommitted changes |
| `/code-review`, `/security-review` | Review the current diff (`/review` is an alias of `/code-review`) |
| `/goal <condition>` | Keep working until a condition holds, e.g. `/goal npm run build passes` |
| `/btw <question>` | Side question that doesn't pollute context |
| `/usage` | Cost, plan limits, stats (`/cost` is an alias) |
| `/status`, `/config` | Version, account, loaded settings; settings UI |
| `/doctor` | Checkup that can apply fixes after you confirm |
| `/fewer-permission-prompts` | Propose an allowlist from your transcripts |
| `/reload-skills` | Only needed after creating a brand-new top-level skills folder |

## Prompt keywords

- `ultrathink` in a prompt asks for deeper reasoning on that turn. "think hard" is ordinary text now.
- `@agent-<name>` delegates to a subagent ([Skills and subagents](skills-and-agents.md)).
