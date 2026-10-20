---
title: Hooks on Windows
tags: [claude-code, hooks, windows, node, automation]
updated: 2026-10-20
claude_code_version: 2.1.304
---

# Hooks on Windows

**TL;DR:** A hook is a command Claude Code runs on an event, with the event JSON on stdin; inspect
them with `/hooks`. On Windows, use exec form (`"command": "node"` plus
`"args": ["${CLAUDE_PROJECT_DIR}/..."]`): no shell, no quoting problems, and it works with or
without Git Bash.

## Structure

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "node",
            "args": ["${CLAUDE_PROJECT_DIR}/tools/hooks/after-edit.mjs"], "timeout": 30 }
        ]
      }
    ]
  }
}
```

Event name, then a list of matcher groups, then a list of handlers. Handler `type` is one of
`command`, `http`, `mcp_tool`, `prompt` or `agent`. Hooks live in any settings file (user, project,
local), in plugins, or in skill/agent frontmatter. An unknown event name gives a settings warning.

## Events worth knowing

| Event | Fires | Typical use |
|---|---|---|
| `SessionStart` | Session starts; matchers `startup`, `resume`, `clear`, `compact`, `fork` | Print status or context |
| `UserPromptSubmit` | You send a prompt (matchers ignored) | Add context, block a prompt |
| `PreToolUse` | Before a tool runs | Guard: deny `rm -rf`, `.env` reads |
| `PostToolUse` | After a tool succeeds | Format the edited file, rebuild an index |
| `PostToolUseFailure` | After a tool fails | Log failures |
| `Stop` | Claude finishes its reply (matchers ignored) | Remind, notify |
| `SubagentStop` | A subagent finishes; matcher = agent type (`Explore`, `code-reviewer`, ...) | Check its result |
| `PreCompact` / `PostCompact` | Around compaction; matchers `manual`, `auto` | Save a handoff note |
| `Notification` | Claude needs your attention; matcher = type (`permission_prompt`, `idle_prompt`, ...) | Sound or toast |
| `InstructionsLoaded`, `FileChanged`, `SessionEnd` | As named | Logging, cleanup |

## Matchers

- `*`, `""` or no matcher: everything.
- Only letters, digits, `_`, `-`, spaces, `,` and `|`: exact names or a list (`Edit|Write`).
- Any other character: an **unanchored** JavaScript regex. `Edit.*` also matches `NotebookEdit`;
  use `^Edit$` for one tool.
- Tool events match on the tool name. To inspect shell commands on Windows match `Bash|PowerShell`.
- `"if": "Bash(rm *)"` filters with permission-rule syntax (tool events only).

## Input (stdin) and output

Every command hook gets one JSON object on stdin. Common fields: `session_id`, `transcript_path`,
`cwd`, `permission_mode`, `hook_event_name`. Tool events add `tool_name`, `tool_input` (for
Edit/Write: `tool_input.file_path`), and PostToolUse adds `tool_response`.

| Exit code | Meaning |
|---|---|
| 0 | Success. A single JSON object on stdout is parsed. For SessionStart, UserPromptSubmit, UserPromptExpansion and PostModelSwitch, plain stdout is added to Claude's context (not shown in the chat); for other events it only goes to the debug log |
| 2 | Block. stderr is the reason (blocks the tool on PreToolUse, the prompt on UserPromptSubmit) |
| other | Non-blocking error; Claude carries on |

- PreToolUse JSON: `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..."}}`
  (`allow`, `deny`, `ask` or `defer`). An allow never overrides a deny or ask rule.
- SessionStart JSON alternative: `hookSpecificOutput.additionalContext`. Output is capped at 10,000 characters.
- PostToolUse and Stop: `{"decision": "block", "reason": "..."}`.

## Exec form vs shell form on Windows

| | Shell form (no `args`) | Exec form (`command` + `args`) |
|---|---|---|
| Runs through | Git Bash if installed, else PowerShell. `"shell": "powershell"` forces PowerShell | No shell |
| `command` | Any shell command line | Must be a real `.exe` (`node`, `powershell.exe`) |
| `.cmd` shims (`npx`, `eslint`) | Work | **Fail**: call `node script.mjs` instead |
| Placeholders | Wrap `"${CLAUDE_PROJECT_DIR}"` in double quotes | Substituted inside `args`, no quoting needed |

- `${CLAUDE_PROJECT_DIR}` is the folder where the session started. It does not follow Claude into
  a worktree; read `cwd` from the input JSON for that. It is also exported as an env var.
- Brace-less `$CLAUDE_PROJECT_DIR` in shell form only works because Git Bash expands the env var.
  Under the PowerShell fallback it expands to nothing. Prefer exec form.
- The documented PowerShell pattern is exec form with a per-process bypass:
  `{"type": "command", "command": "powershell.exe", "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.ps1"]}`.
  In the script: `$in = [Console]::In.ReadToEnd() | ConvertFrom-Json`. Never change the machine
  or user execution policy for this.

## Why this workspace uses node exec-form hooks

- Node is the workspace's only tool runtime, and `node.exe` is a real executable, so exec form works.
- No dependency on Git Bash, jq or PowerShell quirks; the same JSON works on any OS.
- No quoting problems with paths that contain spaces.
- Hub hooks: `SessionStart` runs `tools/hooks/session-start.mjs` (prints a status block that becomes
  context) and `PostToolUse` on `Edit|Write` runs `tools/hooks/after-edit.mjs` (rebuilds `index.html`).
  Both always exit 0, so a broken hook never blocks Claude.

Minimal Node hook that reads stdin and never fails:

```js
// my-hook.mjs
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try {
  const input = JSON.parse(raw || '{}');
  const file = input.tool_input?.file_path;
  if (file) { /* do something with file */ }
} catch { /* ignore bad input */ }
process.exit(0);
```

## Defaults and switches

- Timeout: 600 s for command hooks (30 s on UserPromptSubmit). Set `timeout` (seconds) lower.
- `"async": true` runs the hook in the background. `"onFailure": "block"` (v2.1.295+) blocks the
  action when the hook itself fails.
- `"disableAllHooks": true` turns every hook off. `claude --safe-mode` starts with hooks disabled.
- Hooks from settings files run even under `claude -p` in an untrusted folder.

## Debugging

1. `/hooks` in a session opens a read-only list of configured hooks, each labelled with the file
   it came from. If yours is missing, that file did not load.
2. Run the script by hand with fake input (PowerShell):
   ```powershell
   '{"tool_name":"Edit","tool_input":{"file_path":"README.md"}}' | node tools/hooks/after-edit.mjs
   $LASTEXITCODE
   ```
   Keep test JSON ASCII; Windows PowerShell 5.1 pipes non-ASCII as `?` (see [Windows setup](windows-setup.md)).
3. Start with debug logging: `claude --debug=hooks`, or write it to a file with
   `claude --debug-file hooks.log`.
4. Check the settings file is strict JSON (`node tools/check-workspace.mjs`, or `claude doctor`).
5. Nothing happens? Check the matcher (exact name vs regex) and that `command` is a real `.exe`.

Sources: https://code.claude.com/docs/en/hooks and https://code.claude.com/docs/en/hooks-guide
