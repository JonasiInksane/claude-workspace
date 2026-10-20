# 04 · Claude Code in the terminal

How to drive Claude Code from Windows Terminal and PowerShell, for Next.js and game
projects alike. Checked against Claude Code 2.1.304.

> `claude --help` lists most flags, not all of them (for example `--max-turns` is missing).
> The full list is at https://code.claude.com/docs/en/cli-reference. Type `/help` in a
> session for commands. Native installs update themselves; `claude update` updates right away.

Contents: [General](#general) · [Next.js](#nextjs-in-the-terminal) ·
[Game dev](#game-dev-in-the-terminal) · [Scripting](#scripting-claude--p) ·
[Parallel sessions](#parallel-sessions) · [Troubleshooting](#troubleshooting)

---

## General

### Terminal setup (Windows)
- Use **Windows Terminal** with a PowerShell profile, one tab per project.
- Panes: `Alt+Shift+D` splits the pane, `Alt+Arrow` moves between panes, `Ctrl+Shift+W`
  closes one. A second pane is optional: Claude can run your dev server in the background.
- **Git for Windows is optional** for Claude Code, but recommended (and this workspace needs git).
  With it, the Bash tool runs through Git Bash, and on claude.ai and Console accounts the
  PowerShell tool is on as well. Without it, every command goes through PowerShell.
- Start Claude **from the project root** so it loads that project's `CLAUDE.md` and `.claude/`:
  ```powershell
  cd projects\my-app
  claude
  ```
  CLAUDE.md files in this folder and its parents load at launch. Ones in subfolders load when
  Claude touches files there.

### Starting a session

| Command | What it does |
|---------|--------------|
| `claude` | Start an interactive session |
| `claude "explain the auth flow"` | Start with a first prompt |
| `claude -n settings-page` | Start a **named** session (shown in the prompt box, picker and tab title) |
| `claude -c` | Continue the most recent conversation in this folder |
| `claude -r` | Pick an older conversation (`Ctrl+A` in the picker shows all projects) |
| `claude -r settings-page` | Resume a session by name |
| `claude --permission-mode plan` | Start in plan mode |
| `claude --model opus` | Choose the model. `opusplan` = Opus for planning, Sonnet for the work |
| `claude --effort high` | Effort for this session: low, medium, high, xhigh, max |
| `claude --add-dir ..\shared-lib` | Also allow file access to another folder (not its settings). Pass it again when you resume |
| `claude -w settings-page` | Start in a new git worktree (see [Parallel sessions](#parallel-sessions)) |
| `claude -p "question"` | Headless: print one answer and exit (see [Scripting](#scripting-claude--p)) |

### Permission modes: `Shift+Tab`
New interactive sessions start in **auto** mode when your account has it. `Shift+Tab` cycles:

```
manual ──► accept edits ──► plan ──► (bypass, only if enabled at launch) ──► auto ──► manual ...
```

| Mode | Status bar | Behaviour |
|---|---|---|
| Manual (`default`) | manual mode on | Asks before edits and commands |
| Accept edits | accept edits on | Edits files without asking |
| Plan | plan mode on | Reads and plans, doesn't edit |
| Auto | auto mode on | Far fewer prompts. The default for new sessions |

From auto, the first press goes to manual, so reaching plan takes three presses. Faster:
**`/plan <task>`**, e.g. `/plan add a /settings page`. In plan mode, `Ctrl+G` opens the plan in
your editor. When you approve you choose "Yes, and use auto mode", "Yes, manually approve edits"
or "No, keep planning". On a Windows terminal without VT input the cycle key is `Alt+M`.

### Keys

| Key | Action |
|-----|--------|
| `Shift+Tab` | Cycle permission modes |
| `Esc` | Stop the current response or tool call. Work done so far is kept |
| `Esc` `Esc` | With an empty prompt: open the rewind menu. With text: clear the draft (`Up` brings it back) |
| `Shift+Enter` | New line (works in Windows Terminal). `Ctrl+J` works everywhere |
| `@` | Reference a file or folder: `@app/page.tsx` |
| `!` | Shell mode: `! npm run build`. The output goes into the conversation and Claude replies to it |
| `Ctrl+B` | Send a running command or agent to the background |
| `Alt+V` | Paste an image from the clipboard (Windows) |
| `Alt+P` | Switch model without losing what you typed |
| `Ctrl+C` | Interrupt. When idle: first press clears the input, second press exits |

### Commands you'll actually use

| Command | When |
|---------|------|
| `/plan <task>` | Go straight to plan mode with a task |
| `/clear` | **Starting a new task.** The old conversation stays available in `/resume` |
| `/compact [focus]` | Long session, same task: summarize the history, e.g. `/compact keep the API decisions` |
| `/context` | What's using the context window. "Memory files" shows which CLAUDE.md files loaded |
| `/usage` | Session cost, plan usage limits and stats (`/cost` is an alias) |
| `/model` | Switch model. It becomes your default; press `s` in the picker for this session only |
| `/effort <level>` | Set the effort level: low, medium, high, xhigh or max (see [Thinking harder](#thinking-harder)) |
| `/rewind` | Undo to an earlier prompt (see below) |
| `/resume`, `/rename <name>` | Reopen a conversation; name the current one |
| `/tasks` | Background commands and agents that are running |
| `/goal <condition>` | Keep working across turns until it's true: `/goal npm run build and npm test pass` |
| `/loop 5m <prompt>` | Repeat a prompt on an interval while the session is open |
| `/btw <question>` | A side question that doesn't clutter the main conversation |
| `/code-review` | Review the current diff (`/review` is an alias). Add a level or `--fix` |
| `/run` | Launch the app and drive it to see a change working |
| `/init` | Starter `CLAUDE.md` for a repo (or use `/onboard-project`) |
| `/memory` | Edit CLAUDE.md files; turn auto memory on or off |
| `/permissions` | Allow, ask and deny rules |
| `/hooks`, `/mcp` | Inspect hooks; MCP server status (`/mcp reconnect <server>`) |
| `/agents` | Only prints a reminder now. To make a subagent, ask Claude or write `.claude/agents/<name>.md` |
| `/doctor` | Checkup of install, settings and CLAUDE.md, with fixes after you confirm |
| `/nextjs-feature`, `/game-feature`, `/onboard-project` | Library skills (install with `node tools/install-library.mjs`) |

### Images
- Snip with `Win+Shift+S`, then press **`Alt+V`** in Claude Code. (`Ctrl+V` pastes text in
  Windows Terminal.) An `[Image #1]` chip appears; `Ctrl+Click` it to open the image.
- Or drag the file into the window, or give a path: "Look at C:/shots/bug.png".

### Background tasks
- Ask "Run `npm run dev` in the background", or press `Ctrl+B` while a command or agent runs.
- `/tasks` lists them. Claude can read their output whenever it needs to.
- A command that hits its timeout moves to the background on its own. Background commands
  are cleaned up when Claude Code exits.

### Named sessions
- `claude -n settings-page` or `/rename settings-page`, then tomorrow `claude -r settings-page`.
- `claude -c --fork-session` continues as a copy, leaving the original untouched.
- Flags such as `--add-dir` are not restored on resume. Pass them again.

### Rewind (checkpoints)
Claude Code takes a checkpoint at every prompt. `Esc Esc` (empty prompt) or `/rewind` opens
the menu: **Restore code and conversation**, **Restore conversation**, **Restore code**,
**Summarize from here**, **Summarize up to here**.

Not rewound: files changed by shell commands (`npm install`, code generators, engine imports,
moves and deletes), edits from other sessions, and most subagent edits. **Commit working
states**; git is the real undo.

### Thinking harder
- `/effort high` (or `xhigh`, `max`) for hard bugs and design work; lower it for quick edits.
- Put `ultrathink` in a prompt for one deep answer. "think hard" is just ordinary text.

### Status line
```text
/statusline show model, git branch and context % with a progress bar
```
Claude writes a script and a `statusLine` setting (`{"type": "command", "command": "..."}`).
On Windows it runs through Git Bash, or PowerShell when Git Bash is absent. Use forward
slashes in the path, e.g. `powershell -NoProfile -File C:/Users/<you>/.claude/statusline.ps1`.

### Habits that pay off
1. **One task per conversation.** `/clear` between tasks.
2. **Plan first** for anything bigger than a small fix: `/plan <task>`, read it, correct it.
3. **Point at files with `@`** instead of describing where things are.
4. **Interrupt early.** Going the wrong way? `Esc` and redirect.
5. **Commit checkpoints** whenever something works: "commit this".
6. **Fix the cause.** When Claude repeats a mistake, add a line to `CLAUDE.md` or a
   `.claude/rules/` file. General lessons: `/capture-lesson` in the hub.

---

## Next.js in the terminal

### Daily loop
```powershell
cd projects\my-app
claude -n settings-page
```
```text
> Start npm run dev in the background and tell me if the log shows errors
> /nextjs-feature add a /settings page where users can change their display name
```
Claude explores, shows a plan and waits. You approve; it implements, then runs typecheck,
lint and build. Then `/run` or the Playwright MCP to see the page, and `/code-review`.

### Prompts that work well
```text
> @app/dashboard/page.tsx why does this re-render on every navigation?
> Run npm run build and fix only the errors caused by my last commit
> The dev server output shows a hydration error on /settings. Find the cause.
> Use the code-reviewer agent on the current diff
> Write a Playwright test for the login flow, then run it until it passes
```

### Debugging errors
Paste the full error with its stack trace; don't summarize it. Browser errors: copy them from
DevTools, or screenshot (`Win+Shift+S`, `Alt+V`). If the dev server runs as a background task,
just say "check the dev server output".

---

## Game dev in the terminal

### Daily loop
```powershell
cd projects\my-game
claude -n dash-ability
```
```text
> Start npm run dev in the background                      (web game)
> /game-feature dash ability: 0.2s burst, 8 tiles, 1.5s cooldown, invulnerable during dash
```
For Godot or Unity, run the editor or game yourself in another pane. Headless test and build
commands per engine: [engine-cli-commands.md](../knowledge/gamedev/engine-cli-commands.md).

### Prompts that work well
```text
> @docs/design/dash.md implement this. Logic in src/core with tests first.
> Playtest notes: dash feels sluggish at the start and the cooldown is too long.
  Use the playtester agent to propose tuning.
> Add a debug overlay (F1) that shows player velocity, state, and dash cooldown
> Make enemy spawns reproducible with a seeded RNG; seed from ?seed= in the URL
> Simulate 1000 fights with data/enemies.json and report win rates per enemy
```

### Getting good feedback from playtests
After each playtest, write down **what you did → what happened → what you expected**.
"Dashed into a wall at full speed → went through it → should stop at the wall" is something
Claude can fix in one try. The full loop is in [03 · Game dev](03-game-dev.md#6-playtest-loop).

---

## Scripting: `claude -p`

`-p` runs one prompt without an interactive session, prints the result and exits. Use it in
scripts, npm scripts and CI.

- A `-p` run starts in **manual** mode: any tool call that needs approval is **denied**, unless
  `--allowedTools`, `--permission-mode` or a hook allows it. Reading files inside the folder
  needs no approval.
- **Security:** `-p` (and any run whose output is piped or redirected) skips the workspace trust
  dialog, still runs the project's hooks from `.claude/settings.json`, and loads its `.mcp.json`
  servers without asking. Only run it in repos you trust.

### Windows PowerShell 5.1 gotchas
**Encoding.** PowerShell 5.1 sends piped text to programs as ASCII, so `é`, `ü` or emoji
arrive as `?`. It also decodes what `claude` prints with the old console code page, so
accented text in a captured answer (`$r = claude -p ...`) comes back garbled. Set both
once per window (or put them in your PowerShell profile):
```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)            # text you pipe in
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)  # text you read back
git diff | claude -p "Review this diff for bugs. Be brief."
```
Or skip the pipe and let Claude read the file:
`claude -p "Read data/enemies.json and flag enemies whose damage/HP ratio is an outlier"`.
npm scripts run under cmd.exe and aren't affected.

**Quotes inside arguments.** PowerShell 5.1 drops double quotes inside an argument on the
way to a program: `'{"type":"object"}'` arrives as `{type:object}`. Escape each one with
a backslash: `'{\"type\":\"object\"}'`. This matters for `--json-schema` and for prompts
that contain double quotes.

### Useful flags

| Flag | What it does |
|---|---|
| `--allowedTools "Bash(npm test *),PowerShell(npm test *)"` | **Pre-approves** these. It doesn't remove other tools |
| `--tools "Read,Grep,Glob"` | **Restricts** which tools exist at all |
| `--permission-mode acceptEdits` | Lets an unattended run edit files (also `auto`, `dontAsk`, `plan`) |
| `--permission-prompts none` | Anything that would prompt is denied right away |
| `--max-turns 5` | Stops after 5 turns, with an error (works, though `--help` doesn't list it) |
| `--max-budget-usd 2.00` | Spending cap for the run |
| `--append-system-prompt "..."` | Extra rules for this run (`--append-system-prompt-file .\rules.md` for a file) |
| `--output-format json` | A JSON envelope: the answer is the string in `.result`, plus `session_id` and `total_cost_usd` |
| `--json-schema '<schema>'` | Validated structured output, in `.structured_output` (escape the quotes, see above) |
| `-c -p "..."` | Continue the most recent conversation headlessly |

Put the prompt **before** `--allowedTools` and `--tools`, and give them one comma-separated
value. They take a list, so a prompt placed after them would be read as a tool name.

### Examples
```powershell
# Tests, with only the test command pre-approved
claude -p "Run the tests and summarize failures" --allowedTools "Bash(npm test *),PowerShell(npm test *)"

# Read-only analysis
claude -p "Explain how routing works in app/" --tools "Read,Grep,Glob"

# Capped run with a house style
claude -p --max-turns 5 --append-system-prompt "Write for players, not developers." "Write a changelog from the last 20 commits"

# JSON for a script (set the two encodings above first)
$r = claude -p "List all API routes in app/api" --output-format json | ConvertFrom-Json
$r.result

# Schema-validated output: note the \" escapes for PowerShell 5.1
$s = '{\"type\":\"object\",\"properties\":{\"routes\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"routes\"]}'
$r = claude -p "List all API routes in app/api" --output-format json --json-schema $s | ConvertFrom-Json
$r.structured_output.routes
```

### npm scripts
Escaped double quotes keep these working on Windows:
```json
{
  "scripts": {
    "ai:review": "git diff | claude -p \"Review this diff for bugs and convention issues\"",
    "ai:changelog": "git log --oneline -20 | claude -p \"Write a player-facing changelog\""
  }
}
```

---

## Parallel sessions

Each parallel task needs its own working copy, or the sessions overwrite each other's files.

### `claude -w` (built-in worktrees)
```powershell
cd projects\my-app
claude -w settings-page
```
- Creates `.claude\worktrees\settings-page` on a new branch `worktree-settings-page`, branched
  from the remote's default branch, and starts Claude there. To branch from your current
  commit instead, set `worktree.baseRef` to `"head"` in settings.
- Gitignored files aren't copied, except those listed in **`.worktreeinclude`** (the Next.js
  template lists `.env.local`). Dependencies aren't copied either: run `npm install` first.
- When you exit, a clean worktree is removed; one with changes asks whether to keep it.
- Add `.claude/worktrees/` to `.gitignore`. In the `claude -r` picker, `Ctrl+W` shows all worktrees.
- To work on an **existing** branch, or outside the repo, use git directly:
  ```powershell
  git worktree add ..\my-app-login fix/login
  cd ..\my-app-login
  claude
  ```
  When done: merge, then `git worktree remove ..\my-app-login`.

### Background sessions
Replace `<id>` with the short id that `--bg` prints (`attach` and `logs` also accept a name).
```text
claude --bg "investigate why the login test is flaky"   # prints the session id
claude agents          # agent view: see and manage background sessions
claude attach <id>     # open one in this terminal
claude logs <id>       # print its recent output
claude stop <id>       # stop it (the conversation is kept)
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `claude` not found | Add `%USERPROFILE%\.local\bin` to your user PATH (see [windows-setup.md](../knowledge/claude-code/windows-setup.md)), then open a new terminal |
| Something seems broken | `claude doctor`: read-only diagnostics without starting a session. In a session, `/doctor` can also fix things after you confirm |
| Is my config the problem? | `claude --safe-mode` starts with CLAUDE.md, skills, hooks, MCP servers and plugins turned off |
| Git is installed but Git Bash isn't found | In `~/.claude/settings.json`: `{"env": {"CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe"}}` |
| Settings seem ignored | They must be strict JSON (no comments or trailing commas). `/status` shows which files loaded; `claude doctor` reports errors |
| Claude ignores project rules | Started in the project root? Check `/context` → Memory files, or `/memory` |
| A skill doesn't show up | Installed (`node tools/install-library.mjs`)? If `~/.claude/skills` is new, run `/reload-skills`. Never reuse a built-in name |
| An MCP server doesn't connect | `/mcp`. Did you approve it? On Windows, try the `cmd /c` form from [mcp-servers.md](../knowledge/claude-code/mcp-servers.md) |
| Piped text shows `?`, or captured output is garbled | Set `$OutputEncoding` and `[Console]::OutputEncoding` first (see [PowerShell 5.1 gotchas](#windows-powershell-51-gotchas)) |
| `-p` run is denied or stops | It runs in manual mode. Add `--allowedTools` or `--permission-mode` |
| Answers get worse late in a session | `/clear` (new task), `/compact` (same task) or `/rewind` → Summarize from here |
| Too many permission prompts | Use auto mode (`Shift+Tab`). Accepted workspace trust? Rules written for both Bash and PowerShell? `/fewer-permission-prompts` builds an allowlist from your past sessions |
