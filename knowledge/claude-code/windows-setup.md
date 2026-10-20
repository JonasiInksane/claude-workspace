---
title: Claude Code on Windows
tags: [claude-code, windows, install, powershell, setup]
updated: 2026-10-20
claude_code_version: 2.1.304
---

# Claude Code on Windows

**TL;DR:** Install natively with the PowerShell installer (auto-updates, no admin), make sure
`%USERPROFILE%\.local\bin` is on PATH, and check with `claude doctor`; Git Bash is optional.
In Windows PowerShell 5.1, set `$OutputEncoding` to UTF-8 before piping text into `claude`.

## Install and update

```powershell
irm https://claude.ai/install.ps1 | iex     # native install, auto-updates in the background
claude --version                            # e.g. 2.1.304 (Claude Code)
claude doctor                               # read-only health check
```

- Needs Windows 10 1809 or later. No admin rights.
- The native install puts `claude.exe` in `%USERPROFILE%\.local\bin`.
- Alternative: `winget install Anthropic.ClaudeCode`. WinGet installs do **not** auto-update; run
  `winget upgrade Anthropic.ClaudeCode`.
- `claude update` (alias `claude upgrade`) updates right away. `claude doctor` shows the result of
  the last update attempt.

## PATH fix

If `claude` is "not recognized" after installing, add the folder to your user PATH:

```powershell
$currentPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
[Environment]::SetEnvironmentVariable('PATH', "$currentPath;$env:USERPROFILE\.local\bin", 'User')
```

Then open a **new** terminal. Check with `(Get-Command claude).Source`.

## Git Bash: optional

- Without Git for Windows, Claude Code runs shell commands through its **PowerShell tool**.
- With it, the **Bash tool** uses Git Bash, and for claude.ai and Console accounts the PowerShell
  tool is also on by default. The Bash and Monitor tools need Git Bash.
- Shell-form hooks run through Git Bash when it is installed, otherwise PowerShell
  (see [Hooks on Windows](hooks-on-windows.md)).
- If Git Bash is installed but not found, point to it in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe" } }
```

- Because either shell can run commands, write permission rules for both
  (see [Permissions and settings](permissions-and-settings.md)).
- Sandboxing is not supported on native Windows.

## Windows PowerShell 5.1 gotchas

- No `&&`, `||`, `??` or ternary. Chain with `;` or `cmd; if ($?) { next }`.
- **UTF-8 piping.** In a fresh 5.1 session `$OutputEncoding` is US-ASCII, so `é` piped into a
  native program arrives as `?` (tested on this machine). Fix it for the session:

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
git diff | claude -p "Summarize this diff"
```

  To make it permanent, add that line to your profile (`notepad $PROFILE`). Profiles only load when
  your execution policy allows scripts (for example `RemoteSigned` for CurrentUser). Or skip the
  pipe and let Claude read the file: `claude -p "Read data/enemies.json and flag outliers"`.
- **JSON arguments.** 5.1 strips inner double quotes when passing `'{"a":"b"}'` to a native
  program (it arrives as `{a:b}`). Write `'{\"a\":\"b\"}'` instead, or put the JSON in a file.
- **Arguments like `-name=file.ext`.** 5.1 can split them at the dot (`-gtest=x.gd` arrives as
  `-gtest=x` and `.gd`). Quote the whole argument: `'-gtest=x.gd'`.
- Run scripts you wrote yourself with `-ExecutionPolicy Bypass` per process, or `Unblock-File` a
  downloaded script once. Don't change the machine-wide policy.

## Keys that differ on Windows

| Want | Key |
|---|---|
| Paste a screenshot | `Win+Shift+S` to snip, then **`Alt+V`** in Claude Code (not `Ctrl+V`) |
| Open a pasted image | `Ctrl+Click` on the `[Image #N]` chip |
| New line in the prompt | `Shift+Enter` (works natively in Windows Terminal), `Ctrl+J`, or `\` then Enter |
| Cycle permission modes | `Shift+Tab`; `Alt+M` on terminals without VT input mode |
| Split Windows Terminal | `Alt+Shift+D` (auto), `Alt+Shift+Plus` / `Alt+Shift+Minus`, `Alt+Arrow` to move |

You can also drag an image file into the window or type its path
(`Analyze this image: C:/shots/bug.png`).

## Notifications

By default Claude Code sends desktop notifications only in Ghostty, Kitty and iTerm2. To hear
when a long task finishes or needs input, add this to `~/.claude/settings.json`, or use a
`Notification` hook:

```json
{ "preferredNotifChannel": "terminal_bell" }
```

## Troubleshooting

| Symptom | Try |
|---|---|
| `claude` not found | PATH fix above, then a new terminal |
| Something is broken after an update | `claude doctor`; in a session `/doctor` (can apply fixes) |
| Suspect your own config (CLAUDE.md, hooks, MCP) | `claude --safe-mode` |
| Git Bash not detected | `CLAUDE_CODE_GIT_BASH_PATH` in settings `env` |
| Accents become `?` in piped input | `$OutputEncoding` fix above |
| `Filename too long` in deep `node_modules` | `git config --global core.longpaths true` |
| Allow rule ignored in a new repo | Accept the workspace trust dialog first |
| Backspace deletes a whole word | Set env `CLAUDE_CODE_BS_AS_CTRL_BACKSPACE=0` |
| Shift+Enter submits in the VS Code or Cursor terminal | Run `/terminal-setup` once (or use `Ctrl+J`) |

Sources: https://code.claude.com/docs/en/setup, https://code.claude.com/docs/en/troubleshoot-install,
https://code.claude.com/docs/en/terminal-config
