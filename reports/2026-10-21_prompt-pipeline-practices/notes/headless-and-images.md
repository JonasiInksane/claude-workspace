# Automating Claude Code: headless mode, pipelines, the Agent SDK, and images (Claude Code 2.1.30x)

Researched 2026-10-21. Local install checked: `claude --version` printed `2.1.306 (Claude Code)`, and `claude --help` was captured (read-only). Claude was not run with a prompt, so none of the command examples below were executed. Docs: https://code.claude.com/docs. Labels used below: **[local]** means confirmed in the local `claude --help` output (v2.1.306). **[constructed]** means a PowerShell 5.1 example written from the docs and not run.

## 1. `claude -p` / print mode: input, output formats, JSON contents, limits, model and system-prompt flags

### Takeaway
`claude -p "prompt"` runs a single non-interactive agent run and exits. It reads piped stdin (10 MB cap) along with the prompt argument and prints `text` (the default), a single `json` object, or `stream-json` (NDJSON events). The JSON result carries `result`, `session_id`, `total_cost_usd`, `usage`, a per-model breakdown (`modelUsage`), `num_turns`, `subtype`, `stop_reason` and, when you pass `--json-schema`, `structured_output`. For scripts and CI the docs recommend `--bare`, and say it will become the default for `-p` in a future release.

### Cited Findings
- **Basic form.** `claude -p "Find and fix the bug in auth.py" --allowedTools "Read,Edit,Bash"` runs non-interactively. Not every flag combines with `-p`: `--bg` is rejected, and so is `--cloud` with a task description. — [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- **The CLI commands table** lists `claude "query"` (interactive session with an initial prompt), `claude -p "query"` (query, then exit), `cat file | claude -p "query"` (process piped content), `claude -c -p "query"` (continue via SDK) and `claude -r "<session>" "query"` (resume by ID or name). — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- **Stdin.** "Non-interactive mode reads stdin, so you can pipe data in and redirect the response out." Example: `cat build-error.txt | claude -p 'concisely explain the root cause of this build error' > output.txt`. Piped stdin is capped at 10MB, and going over it exits with an error and a non-zero status. For larger inputs, write the content to a file and reference the path in the prompt. If stdin can't be read, Claude Code warns on stderr and continues with the command-line prompt. — [headless](https://code.claude.com/docs/en/headless)
- **Workspace trust.** The `-p` help text says: "The workspace trust dialog is skipped when Claude is run in non-interactive mode (via -p, or when stdout is not a TTY, e.g. piped or redirected output). Only use this in directories you trust. Settings files that fail validation are silently ignored in this mode." — [local] `claude --help`, v2.1.306
- **Output formats.** `text` (default), `json` ("structured JSON with result, session ID, and metadata") and `stream-json` ("newline-delimited JSON for real-time streaming"). With `json`, the payload includes `total_cost_usd` and a per-model cost breakdown. After `--continue`/`--resume`, the figure is the whole conversation's total, earlier runs included. Both numbers are client-side estimates. — [headless](https://code.claude.com/docs/en/headless)
- **Result message fields.**
  - Every result subtype carries `total_cost_usd`, `usage`, `num_turns` and `session_id`.
  - `result` (the final text) exists only on `subtype: "success"`.
  - The other subtypes are `error_max_turns`, `error_max_budget_usd`, `error_during_execution` and `error_max_structured_output_retries`.
  - `usage` covers only the main loop. `modelUsage` covers the whole tree, subagents included.
  - `stop_reason` is `end_turn`, `max_tokens`, `refusal` or null.
  - [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- **Structured output.** `--json-schema '<schema>'` together with `--output-format json` puts schema-conforming output in the `structured_output` field. An invalid schema exits with `Error: --json-schema is not a valid JSON Schema`. The `format` keyword is accepted as an annotation but not enforced. If the run ends without valid structured output (for example a refusal), `structured_output` is absent, "Before your script uses `structured_output`, check that the field is present." — [headless](https://code.claude.com/docs/en/headless); also listed as "(only works with --print)" in [local] `claude --help`
- **Streaming.** `claude -p "Explain recursion" --output-format stream-json --verbose --include-partial-messages` emits one JSON event per line. The last line is a `result` message. The first event is `system/init`, which reports the model, tools, MCP servers (`mcp_servers`, `mcp_server_errors`) and plugins (`plugins`, `plugin_errors`). Retries show up as `system/api_retry` events. Denied tool calls show up as `permission_denied` system messages and are listed in `permission_denials` on the result. — [headless](https://code.claude.com/docs/en/headless)
- **Input format.** `--input-format stream-json` (print mode only) takes realtime streaming input. `--replay-user-messages` re-emits stdin user messages on stdout and requires both stream-json formats. — [CLI reference](https://code.claude.com/docs/en/cli-reference); [local] `claude --help`
- **Turn and budget caps.**
  - `--max-turns` limits agentic turns (print mode only), "Exits with an error when the limit is reached. No limit by default."
  - `--max-budget-usd` stops the run when estimated spend reaches the amount (print mode only). Subagent spend counts. Spend can pass the cap, so leave headroom.
  - [CLI reference](https://code.claude.com/docs/en/cli-reference). The agent-loop page says the response that crosses the cap still completes ([agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)).
  - `--max-turns` is documented but missing from the local `--help` output. `--max-budget-usd` is present. The CLI reference says "`claude --help` does not list every flag".
- **Model and effort.** `--model` takes an alias (`fable`, `opus`, `sonnet`, `haiku`) or a full model name, and overrides the `model` setting and `ANTHROPIC_MODEL`. `--fallback-model sonnet,haiku` takes a comma-separated chain to use when the primary is overloaded or unavailable. `--effort low|medium|high|xhigh|max` (plus `ultracode`) applies to the session only. — [CLI reference](https://code.claude.com/docs/en/cli-reference); [local] `claude --help`
- **System prompt flags.**
  - `--system-prompt` and `--system-prompt-file` replace the default prompt. `--append-system-prompt` and `--append-system-prompt-file` add to it. All work in interactive and print mode, and they can be combined.
  - Replacing the prompt "drops all of the default prompt, including tool guidance and safety instructions". The docs recommend appending when Claude should stay a coding assistant.
  - A replaced prompt also starts without the git status snapshot.
  - [CLI reference](https://code.claude.com/docs/en/cli-reference); [headless](https://code.claude.com/docs/en/headless)
- **System prompt snapshot (pipeline gotcha).** By default the system prompt is recorded on a conversation's first request and reused, unchanged, on every later request and on resume until compaction. Passing different `--append-system-prompt` text on a later `--resume` has no effect until compaction or a new conversation. Use `--system-prompt-snapshot off` to rebuild it on every request (v2.1.257+). Under `--bare`, recording is off unless you pass `--system-prompt-snapshot on`. — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- **`--verbose`** "shows full turn-by-turn output". Every docs example with `--output-format stream-json` in `-p` mode pairs it with `--verbose`. — [CLI reference](https://code.claude.com/docs/en/cli-reference); [Best practices](https://code.claude.com/docs/en/best-practices)
- **Bare mode.** `--bare` skips auto-discovery of hooks, skills, custom commands, subagents, plugins, MCP servers, auto memory and CLAUDE.md, and leaves Claude with the Bash, file read and file edit tools. Context goes in explicitly through `--append-system-prompt[-file]`, `--settings`, `--mcp-config`, `--agents` and `--plugin-dir`. Bare mode never reads OAuth or the keychain: it needs `ANTHROPIC_API_KEY` or an `apiKeyHelper` in `--settings`. "`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release." — [headless](https://code.claude.com/docs/en/headless)
- **Without `--bare`**, a `-p` session runs the hooks in the project's `.claude/settings.json` and connects the servers in its `.mcp.json`, "even in a folder you've never trusted". — [headless](https://code.claude.com/docs/en/headless)
- **Slash commands in `-p`.** User-invoked skills and custom commands work if you put `/skill-name` in the prompt string. Terminal-only built-ins such as `/login` don't. `/model sonnet`, `/effort`, `/config key=value` and `/output-style` accept arguments. — [headless](https://code.claude.com/docs/en/headless)
- **Background work at exit.** A `-p` run waits for background work Claude started (background commands, subagents, workflows, Monitor watches, `/loop` wakeups). By default it stops leftover work after 10 minutes of idle waiting, configurable with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (`0` means no cap). — [headless](https://code.claude.com/docs/en/headless)
- **Other print-mode-only flags.** `--no-session-persistence` (the session isn't saved and can't be resumed), `--include-partial-messages`, `--forward-subagent-text`, `--prompt-suggestions`, `--append-subagent-system-prompt[-file]`, `--init`/`--maintenance` (Setup hooks). — [CLI reference](https://code.claude.com/docs/en/cli-reference)

### Inferences
- In a pipeline, branch on `subtype` first, then read `result` or `structured_output`. Neither field is guaranteed on error subtypes.
- For local pipelines on a Claude subscription login, `--bare` is not usable as-is, because it ignores OAuth and requires `ANTHROPIC_API_KEY`. To get reproducibility without bare mode, use `--setting-sources`, `--strict-mcp-config --mcp-config <file>` and `--disable-slash-commands`.
- Pipelines that resume one session across steps with a different system prompt per step should put per-step instructions in the user prompt, not in `--append-system-prompt`, or pass `--system-prompt-snapshot off`.

### Gaps
- Fields such as `is_error`, `duration_ms`, `duration_api_ms` and `num_turns` semantics in the CLI `json` payload were not confirmed verbatim on the pages fetched. The full shape is in the `SDKResultMessage` type reference ([TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage)), which was not fetched.
- The docs fetched don't say explicitly that stdin alone, with no prompt argument, is treated as the prompt. All examples combine piped data with a prompt argument.
- The docs don't say whether `--json-schema` accepts a file path (the `--settings`, `--mcp-config` and `--agents` flags do).

## 2. Permissions in automation: modes, allow/deny syntax, bypass cautions, settings, dirs and MCP

### Takeaway
Since v2.1.302, a `claude -p` run with no permission mode set starts in Manual (`default`) mode. Any call that needs approval is denied unless an allow rule, hook or permission-prompt tool approves it. For unattended runs, pass an exact `--allowedTools` allowlist together with `--permission-mode dontAsk`, or use `--permission-mode auto`. Keep `bypassPermissions` / `--dangerously-skip-permissions` for isolated containers or VMs only.

### Cited Findings
- **Local mode choices.** `--permission-mode` accepts `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk` and `plan`. — [local] `claude --help`, v2.1.306. Docs: `default` is also accepted, and `manual` is an alias for `default` (v2.1.200+). — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- **What runs without asking in each mode:**
  - `default`: reads only.
  - `acceptEdits`: reads, file edits and common filesystem commands.
  - `plan`: reads, plus classifier-approved commands when auto mode is available.
  - `auto`: everything, with background safety checks.
  - `dontAsk`: file reads inside working directories and pre-approved tools; anything that would prompt is denied.
  - `bypassPermissions`: everything; "Isolated containers and VMs only".
  - [Choose a permission mode](https://code.claude.com/docs/en/permission-modes)
- **Starting mode for `-p`.** `claude -p` and the Agent SDK start in `default`, while interactive terminal and VS Code sessions start in `auto` on v2.1.283+. "In Claude Code v2.1.302 or later, `claude -p` and Agent SDK runs with no permission mode set start in Manual mode... Calls needing approval are denied unless you approve them with an allow rule, hook, `canUseTool` callback, or `--permission-prompt-tool`." — [permission modes](https://code.claude.com/docs/en/permission-modes)
- **Precedence of the starting mode:** the `--permission-mode` flag (or `--dangerously-skip-permissions`), then `permissions.defaultMode` in settings, then the built-in default. `"auto"` or `"bypassPermissions"` set in project `.claude/settings.json` or `.claude/settings.local.json` does not take effect. — [permission modes](https://code.claude.com/docs/en/permission-modes)
- **Recommended CI setup.** "Run in CI with an exact allowlist": `claude -p "run the test suite" --permission-mode dontAsk --allowedTools "Bash(npm test)" "Read"`. Fully unattended in a container: `claude -p "<prompt>" --dangerously-skip-permissions`, which needs isolation (container, VM or sandbox runtime) and a non-root user on Linux/macOS. — [permission modes](https://code.claude.com/docs/en/permission-modes)
- **`--allowedTools` syntax.** A comma- or space-separated list. It uses permission-rule syntax: `Bash(git diff *)` is a prefix match, and "The space before `*` is important: without it, `Bash(git diff*)` would also match `git diff-index`." Example: `--allowedTools "Bash(git diff *),Bash(git log *),Bash(git status *),Bash(git commit *)"`. In a run that starts in auto mode, a bare `Bash` entry is dropped and the classifier evaluates each command instead. — [headless](https://code.claude.com/docs/en/headless); [local] `claude --help`
- **`--disallowedTools`.** A bare name removes the tool from Claude's context (`"Edit"`, `"*"` for all tools, `"mcp__*"` for every MCP tool). A scoped rule such as `Bash(rm *)` keeps the tool and denies only matching calls. `--tools "Bash,Edit,Read"` restricts which built-ins exist, `""` disables all of them, and `--tools` doesn't affect MCP tools. — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- **Deny rules** block in every mode, including `bypassPermissions`. Allow rules have no effect in `bypassPermissions`. — [permission modes](https://code.claude.com/docs/en/permission-modes)
- **`acceptEdits`** auto-approves file edits plus `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` and `sed` within the working directory or `additionalDirectories`. With the PowerShell tool enabled it also auto-approves `Set-Content`, `Add-Content`, `Clear-Content` and `Remove-Item` on in-scope paths. Other shell commands and network requests still need an allow rule. — [permission modes](https://code.claude.com/docs/en/permission-modes); [headless](https://code.claude.com/docs/en/headless)
- **`dontAsk`** denies `AskUserQuestion`, MCP tools marked `requiresUserInteraction`, network-path reads and critical-path `rm`, even when an allow rule matches. — [permission modes](https://code.claude.com/docs/en/permission-modes)
- **`--permission-prompts none`** (v2.1.259+) is for runs with nobody to answer prompts. Anything that would prompt is denied, Claude is told not to retry, and `AskUserQuestion` is removed. Example: `claude -p "Update the dependency pins and run the tests" --permission-mode auto --permission-prompts none`. `--permission-prompt-tool mcp__<server>__<tool>` routes prompts to an MCP tool instead. — [headless](https://code.claude.com/docs/en/headless); [CLI reference](https://code.claude.com/docs/en/cli-reference)
- **Plan mode in `-p`.** "Plan mode keeps its blocks wherever Claude Code runs without an interactive terminal, including non-interactive runs with `-p`." — [permission modes](https://code.claude.com/docs/en/permission-modes)
- **Auto mode in `-p`.** Critical-path removals are denied immediately in `-p` runs. When the classifier keeps blocking actions in `-p`, the run does not stop (see "when auto mode falls back"). — [permission modes](https://code.claude.com/docs/en/permission-modes); [Best practices](https://code.claude.com/docs/en/best-practices)
- **bypassPermissions cautions.**
  - "Only use this mode in isolated environments like containers, VMs, or dev containers without internet access."
  - It "offers no protection against prompt injection or unintended actions".
  - It's refused as root/sudo on Linux/macOS, refused under `--restricted`, and shows no warning dialog in `-p`.
  - Admins can disable it with `permissions.disableBypassPermissionsMode`.
  - `--allow-dangerously-skip-permissions` only adds it to the Shift+Tab cycle.
  - [permission modes](https://code.claude.com/docs/en/permission-modes)
- **Protected paths** (`.git`, `.claude`, `.vscode`, `.idea`, `.husky`, `.devcontainer` and others): writes are prompted in default/acceptEdits, denied in `dontAsk` and allowed only in `bypassPermissions`. `permissions.allow` rules can't pre-approve them. — [permission modes](https://code.claude.com/docs/en/permission-modes)
- **`--settings`** takes a file path or inline JSON. Its values override the same keys in the settings files for that session. The file must be 2 MiB or smaller. `--setting-sources user,project,local` picks which files load. — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- **`--add-dir`** "grants file access". Claude Code "doesn't discover most `.claude/` configuration from these directories". Most network paths (`\\server\share`) can't be added. Use `permissions.additionalDirectories` to persist added directories. — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- **`--mcp-config`** loads servers from JSON files or strings. With `-p` it waits up to `MCP_TIMEOUT` (30 s) for servers to connect. Invalid entries are skipped and the run still exits cleanly, so a CI gate should check `mcp_server_errors` in `system/init`. `--strict-mcp-config` uses only servers from `--mcp-config`. — [CLI reference](https://code.claude.com/docs/en/cli-reference); [headless](https://code.claude.com/docs/en/headless)
- **`--restricted`** (v2.1.248+) removes code-running tools and WebFetch unless `--tools` names them, ignores user, project and local settings, confines file tools to the working directories and refuses `bypassPermissions`. — [CLI reference](https://code.claude.com/docs/en/cli-reference); [local] `claude --help`

### Inferences
- For a hub pipeline on this machine, `--permission-mode dontAsk` plus a narrow `--allowedTools` list is the safest default. It never hangs, and anything unexpected shows up as a denial in `permission_denials`, not as a silent action.
- On Windows with the PowerShell tool enabled, an allowlist that only contains `Bash(...)` rules may not cover commands Claude chooses to run through PowerShell. Add matching `PowerShell(...)` rules. The rule syntax exists ([tools reference](https://code.claude.com/docs/en/tools-reference)), but I did not verify it in a `-p` run.
- Plan mode in `-p` is a read-only analysis mode: approving the plan (ExitPlanMode) needs an interactive prompt or a permission-prompt tool.

### Gaps
- The exact set of commands auto mode's classifier blocks in `-p` runs, and its fallback thresholds, were not extracted ("When auto mode falls back" section of the permission modes page).

## 3. Sessions: continue, resume, session-id, fork, and starting interactive sessions with a prompt

### Takeaway
Every `-p` run creates a resumable session unless you pass `--no-session-persistence`. To chain steps, capture `session_id` from the JSON output and pass it to `--resume <id>`. `--continue` is ambiguous when runs happen in parallel. Use `--fork-session` to branch from a shared base without changing it. A resumed `-p` run does not restore the permission mode, MCP config, settings, add-dirs or fallback model, so pass those flags again on every step.

### Cited Findings
- **Chaining by session ID.** `session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')`, then `claude -p "Continue that review" --resume "$session_id"`. Resume by ID works from any directory, because Claude Code finds the session in any project on the machine. `--resume` also accepts the absolute path to a `.jsonl` transcript. — [headless](https://code.claude.com/docs/en/headless)
- **Continuing the most recent conversation.** `claude -p "Now focus on the database queries" --continue` continues the most recent conversation in the directory. Interactive `claude --continue` skips sessions created with `-p` or the SDK, but `claude -p --continue` includes them. — [headless](https://code.claude.com/docs/en/headless); [CLI reference](https://code.claude.com/docs/en/cli-reference); [Manage sessions](https://code.claude.com/docs/en/sessions)
- **`--session-id <uuid>`** uses a specific session ID, which must be a valid UUID. — [CLI reference](https://code.claude.com/docs/en/cli-reference); [local] `claude --help`
- **`--fork-session`**, used with `--resume` or `--continue`, creates a new session ID instead of reusing the original. Example: `claude --resume abc123 --fork-session`. A fork in a separate process "starts without" the "Allow for this session" grants. Resuming the same session in two terminals without forking interleaves both into one transcript. — [CLI reference](https://code.claude.com/docs/en/cli-reference); [sessions](https://code.claude.com/docs/en/sessions)
- **Permission mode on resume with `-p`.** `claude -p --resume` and `claude -p --continue` start "in the permission mode a new `claude -p` run would start in". The exception is a session that ended in plan mode, which resumes in plan mode only with `--permission-prompt-tool` and under further conditions. — [sessions](https://code.claude.com/docs/en/sessions)
- **What a resume doesn't restore.** "If the session depended on `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model`, or directories added with `--add-dir`, pass them again when you resume." The model and agent are restored. — [sessions](https://code.claude.com/docs/en/sessions)
- **Naming.** `-n/--name` sets a display name, and `claude --resume <name>` resumes it. "A `claude -p` run you start directly from a shell or script doesn't get" an auto-generated title. — [sessions](https://code.claude.com/docs/en/sessions); [local] `claude --help`
- **Transcripts** live at `~/.claude/projects/<project>/<session-id>.jsonl`. "The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release." Retention is 30 days by default (`cleanupPeriodDays`). — [sessions](https://code.claude.com/docs/en/sessions)
- **Asking an existing session a question from a script:** `claude -p --resume <session-id> --output-format json "summarize what we changed" | jq -r '.result'`. — [sessions](https://code.claude.com/docs/en/sessions)
- **Interactive start with a prompt.** `claude "explain this project"` starts an interactive session with an initial prompt. You can combine it with `--permission-mode plan` (for example `claude --permission-mode plan`), `--model`, `-n` and `--effort`. — [CLI reference](https://code.claude.com/docs/en/cli-reference); [Common workflows](https://code.claude.com/docs/en/common-workflows)
- **SIGTERM and interrupted turns.** SIGTERM exits with code 143 and records no result for the interrupted turn. On resume the interrupted turn is left as it is unless `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` is set. — [headless](https://code.claude.com/docs/en/headless)

### Inferences
**[constructed] PowerShell 5.1 equivalents (not run):**
```powershell
# Step 1: capture session id and result
$s1 = (claude -p "Review src/auth for bugs. List findings as a numbered list." --output-format json --permission-mode dontAsk --allowedTools "Read,Grep,Glob") -join "`n" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $s1.subtype -ne 'success') { throw "step 1 failed: $($s1.subtype)" }

# Step 2: same conversation (re-pass permission flags; they are not restored on -p resume)
$s2 = (claude -p "Propose fixes for the top 3 findings" --resume $s1.session_id --output-format json --permission-mode dontAsk --allowedTools "Read,Grep,Glob") -join "`n" | ConvertFrom-Json

# Branch: try an alternative from the same base without touching it
$alt = (claude -p "Instead, propose a redesign" --resume $s1.session_id --fork-session --output-format json) -join "`n" | ConvertFrom-Json

# Pre-assign an id so a later step can find it without parsing output
$id = [guid]::NewGuid().ToString()
claude -p "Step one" --session-id $id
claude -p "Step two" --resume $id

# Interactive start with prompt, mode, model and name
claude --permission-mode plan --model opus -n auth-oauth "Read src/auth and propose a plan for adding Google OAuth"
```
- Prefer explicit `--resume <id>` over `--continue` in any pipeline that can run concurrently, or in a directory where you also work interactively. `--continue` picks "the most recent".

### Gaps
- Pre-assigning a UUID with `--session-id` and then resuming it in a later `-p` call is not shown as a pattern in the docs. It is inferred from the flag descriptions.

## 4. Scripted pipelines: chaining, fan-out, CI/GitHub Actions, cost and turn limits, errors and exit codes

### Takeaway
The documented patterns are: pipe data in and redirect out, call `claude -p` in a loop over a task list with `--allowedTools` plus `--permission-mode dontAsk`, pass state through files, JSON (`--output-format json`, `--json-schema`) or session IDs, and cap each step with `--max-turns` and `--max-budget-usd`. Branch on the exit code and on the result `subtype`. In GitHub, `anthropics/claude-code-action@v1` wraps the same CLI and takes CLI flags through `claude_args`.

### Cited Findings
- **Exit codes.** "Claude Code exits with code 0 on success and a non-zero code when the run fails." An invalid flag is reported on stderr before the run. A failure inside the run, such as missing authentication, "prints the failure as the result on stdout". SIGTERM gives 143. — [headless](https://code.claude.com/docs/en/headless). `--max-turns` "Exits with an error when the limit is reached" — [CLI reference](https://code.claude.com/docs/en/cli-reference). An SDK error result goes with a nonzero exit of the underlying process — [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop).
- **Fan-out loop**, from the docs:
  ```bash
  for file in $(cat files.txt); do
    claude -p "Migrate $file from Python 2 to Python 3. Return OK or FAIL." \
      --allowedTools "Edit,Bash(git commit *)" \
      --permission-mode dontAsk
  done
  ```
  "Refine your prompt based on what goes wrong with the first 2-3 files, then run on the full set." Alternatively, `/batch <instruction>` splits a change across 5 to 30 subagents, each in its own worktree. — [Best practices](https://code.claude.com/docs/en/best-practices)
- **Data pipelines.** `claude -p "<your prompt>" --output-format json | your_command`. — [Best practices](https://code.claude.com/docs/en/best-practices)
- **Build-script integration.** `"lint:claude": "git diff main | claude -p \"you are a typo linter...\""`. "Piping the diff means Claude doesn't need Bash permission to read it, and the escaped double quotes keep the script portable to Windows." — [headless](https://code.claude.com/docs/en/headless)
- **Writer/Reviewer pattern** across separate sessions: "A fresh context improves code review since Claude won't be biased toward code it just wrote." — [Best practices](https://code.claude.com/docs/en/best-practices)
- **Verification gates.** "Give Claude a check it can run: tests, a build, a screenshot to compare." Options: in-prompt checks, `/goal`, a Stop hook as a deterministic gate, or a verification subagent. — [Best practices](https://code.claude.com/docs/en/best-practices)
- **Budget and turn semantics.** `max_turns` counts tool-use turns only. Hitting a limit gives `error_max_turns` or `error_max_budget_usd`. Spend can exceed the cap by up to one response plus any running subagents. — [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- **CI hygiene.** "In CI or other scripted environments, add `--bare` so Claude Code starts without loading the host's hooks, plugins, auto memory, or `CLAUDE.md`." — [headless](https://code.claude.com/docs/en/headless). For headless subscription auth in CI, `claude setup-token` generates a long-lived OAuth token (requires a subscription) — [CLI reference](https://code.claude.com/docs/en/cli-reference).
- **GitHub Actions.**
  - The action is `anthropics/claude-code-action@v1`.
  - Inputs: `prompt` (plain text or `/skill-name`), `claude_args`, `anthropic_api_key` or `claude_code_oauth_token`, `settings`, `plugins`, `plugin_marketplaces`, `trigger_phrase`.
  - Without `prompt` it runs in interactive mode (responds to `@claude`). With `prompt` it runs in automation mode.
  - Example: `claude_args: "--max-turns 5 --model claude-sonnet-5 --mcp-config /path/to/config.json"`.
  - Cost advice: set `--max-turns`, workflow timeouts and concurrency controls, and keep CLAUDE.md concise.
  - In automation mode with a plain-text prompt, Claude has no shell or GitHub API access until you grant tools through `--allowedTools` in `claude_args` or the `settings` input.
  - Quick setup: `/install-github-app`.
  - [GitHub Actions](https://code.claude.com/docs/en/github-actions)
- **Scheduling options** besides CI: cloud routines, Desktop scheduled tasks, GitHub Actions cron and `/loop`. "When writing prompts for scheduled tasks, be explicit about what success looks like and what to do with results. The task runs autonomously, so it can't ask clarifying questions." — [Common workflows](https://code.claude.com/docs/en/common-workflows)
- **Prompt-cache reuse across machines.** `--exclude-dynamic-system-prompt-sections` moves per-machine context into the first user message to improve cache reuse in multi-user scripted workloads. — [CLI reference](https://code.claude.com/docs/en/cli-reference)

### Inferences
**[constructed] PowerShell 5.1 fan-out with result logging (not run).** It is serial: `ForEach-Object -Parallel` exists only in PowerShell 7+, so in 5.1 you would use `Start-Job` with throttling, or a Node driver script with a concurrency limit.
```powershell
Get-Content .\files.txt | ForEach-Object {
  $f = $_
  $raw = claude -p "Migrate $f to the new API. Reply with exactly OK or FAIL and one line of reason." `
    --allowedTools "Edit,Bash(git commit *),PowerShell(git commit *)" --permission-mode dontAsk `
    --max-turns 20 --max-budget-usd 1 --output-format json
  $code = $LASTEXITCODE
  $r = ($raw -join "`n") | ConvertFrom-Json
  [pscustomobject]@{ file=$f; exit=$code; subtype=$r.subtype; result=$r.result; cost=$r.total_cost_usd; session=$r.session_id }
} | Export-Csv .\fanout-results.csv -NoTypeInformation -Encoding UTF8
```
- **Handing data between steps.** Make step N write a file, such as `step1.json`, or emit `structured_output`. Step N+1 reads that file, either from the path in its prompt or piped through stdin. This keeps each step's context clean, and the steps can be re-run one at a time. Session-ID chaining is the alternative when a step needs the earlier conversation's reasoning, not only its output.
- **Logging.** Record `session_id` per step, so a failed step can be inspected or resumed by hand with `claude --resume <id>`. Record `total_cost_usd` and `permission_denials` too.
- **Node driver option.** The workspace's tools are dependency-free Node ESM scripts, so a pipeline runner can shell out with `child_process.spawn('claude', [...args])`, passing an argument array. That avoids PowerShell quoting entirely (see question 7). It's inferred and untested.

### Gaps
- No official guidance on a recommended concurrency level for parallel `claude -p` fan-out, or on rate-limit behavior beyond the `system/api_retry` event, was found.
- `/batch` details (worktree cleanup, result format) were not researched.

## 5. Claude Agent SDK (TypeScript/Python): what it adds over the CLI, and when to use it

### Takeaway
The Agent SDK is Claude Code as a library: the same tools, agent loop, permissions, sessions, hooks, skills and plugins. Its packages bundle a native Claude Code binary. Over shelling out to `claude -p`, it adds typed message streams, in-process hook callbacks, a `canUseTool` approval callback, in-process custom tools through SDK MCP servers, streaming input (including image attachments, queued messages and interrupt), mid-session `setPermissionMode` and model changes, and pluggable session storage. Use the CLI for shell scripts, CI and any non-Python/TypeScript language. Use the SDK when your program has to make decisions mid-run.

### Cited Findings
- **Comparison table.** Agent SDK: "Embed Claude Code's agent in your own Python or TypeScript application... A library that runs the Claude Code binary." CLI: "interactive development or run one-off tasks from a terminal". Client SDK: the raw API, where you write the tool loop yourself. Managed Agents: an Anthropic-hosted harness. "To drive the same agent loop from a language other than Python or TypeScript, run the CLI as a subprocess with the `-p` flag and `--output-format json`." — [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- **Capabilities:** built-in tools, hooks, subagents, MCP, permissions, sessions (resume/fork), skills/commands/memory loaded from `.claude/` and `~/.claude/`, and plugins. — [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- **Bundled binary.** "Both the TypeScript and Python SDKs bundle a native Claude Code binary, so most installs need no separate Claude Code install." — [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- **Package names.** The TypeScript import is `@anthropic-ai/claude-agent-sdk`, as in `import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"`. The Python import is `claude_agent_sdk` (`query`, `ClaudeSDKClient`, `ClaudeAgentOptions`, `tool`, `create_sdk_mcp_server`). — [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools); [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode). The changelog repos are `anthropics/claude-agent-sdk-typescript` and `anthropics/claude-agent-sdk-python` — [overview](https://code.claude.com/docs/en/agent-sdk/overview).
- **Permission evaluation order** in the SDK: (1) hooks, (2) deny rules, (3) ask rules, (4) permission mode, (5) allow rules, (6) the `canUseTool` callback. "Auto-approved tools never reach `canUseTool`." "`allowed_tools` does not constrain `bypassPermissions`." For checks that must run on every call, use a `PreToolUse` hook. `setPermissionMode()` / `set_permission_mode()` changes the mode mid-session. In TypeScript, `bypassPermissions` also requires `allowDangerouslySkipPermissions: true`. — [SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions); [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- **Locked-down pattern:** `{ allowedTools: ["Read","Glob","Grep"], permissionMode: "dontAsk" }`. — [SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- **Hooks** run in your application process and don't consume context: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStart`/`SubagentStop` and `PreCompact`. A rejecting `PreToolUse` prevents the tool call. — [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- **Custom tools.** Define them with `tool(name, description, zodSchema, handler)` in TypeScript or `@tool` in Python. Wrap them in `createSdkMcpServer` / `create_sdk_mcp_server`, which run in-process. Pass the server through `mcpServers` and allow `mcp__<server>__<tool>`. Handlers return `content` blocks (text, image, resource and others), can set `isError: true`, and can include `structuredContent` (TypeScript only for in-process servers). — [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- **Streaming input vs single message.** Streaming input is "the preferred way" and supports image uploads, queued messages, interruption and natural multi-turn. Single message input "does not support: Direct image attachments in messages; Dynamic message queueing; Real-time interruption; Natural multi-turn conversations." A single-shot `query()` raises after yielding an error result. — [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- **Sessions in the SDK.** Capture `ResultMessage.session_id` to resume. Forking is supported. `sessionStore` adapters mirror transcripts to your own backend for stateless hosts. — [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- **Auth, terms and branding.** "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods." Use of the SDK falls under Anthropic's Commercial Terms. A product may not call itself "Claude Code". — [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- **The Claude Code GitHub Action is built on the SDK.** — [GitHub Actions](https://code.claude.com/docs/en/github-actions)

### Inferences
- **When to choose the SDK over `claude -p`:**
  1. You need per-call approval logic, such as a UI that approves edits.
  2. You need your own functions as tools without running a separate MCP server process.
  3. You want to send images as message content, not by file path.
  4. You need a long-lived conversation with queued follow-ups or interruption.
  5. You want typed messages without parsing NDJSON yourself.
- **When to stay on the CLI:** linear pipelines where each step is a prompt plus files, CI jobs, and anything driven from PowerShell or another language.
- **Cost of adopting the SDK here.** The workspace tools have no npm dependencies by design. Moving to the SDK means adding `@anthropic-ai/claude-agent-sdk` (and `zod` for typed tools), and the user's preferences say to ask before installing dependencies.

### Gaps
- The pip package name (presumably `claude-agent-sdk`) and the install commands weren't confirmed. The quickstart page wasn't fetched.
- Whether a personal, non-distributed script on your own machine may use a Claude subscription login through the SDK, as opposed to an API key, isn't answered by the overview note, which addresses "third party developers... for their products". It needs a check of the [quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart) and the [authentication](https://code.claude.com/docs/en/authentication) docs.

## 6. Images and reference material: paste, drag-drop, paths, @-mentions, `-p` with images, limits, and practices

### Takeaway
In the interactive TUI, images go in by drag and drop, by clipboard paste (on native Windows the image-paste key is **Alt+V**), or by typing a file path. Claude's Read tool returns PNG, JPEG, GIF and WebP files as visual content and resizes large ones. In `-p` mode, the practical route is putting image paths in the prompt. That works because Read runs without approval inside the working directory; add `--add-dir` or an allow rule for images elsewhere. Image attachments as message content need SDK streaming input. Label each image, say what to look at, and pre-crop or resize for fine detail.

### Cited Findings
- **Three ways to add an image:** "Drag and drop an image into the Claude Code window", "Copy an image and paste it into the CLI with `Ctrl+V`, or with `Alt+V` on Windows and WSL", and "Provide an image path to Claude, for example 'Analyze this image: /path/to/your/image.png'". You can use multiple images in a conversation. `[Image #1]` references open with Ctrl+Click on Windows/Linux. — [Common workflows](https://code.claude.com/docs/en/common-workflows)
- **Paste key.** The shortcut table lists "`Ctrl+V` or `Cmd+V` (iTerm2) or `Alt+V` (Windows and WSL) | Paste image from clipboard | Inserts an `[Image #N]` chip at the cursor so you can reference it positionally in your prompt. On WSL, both `Ctrl+V` and `Alt+V` are bound; use `Alt+V` if your terminal intercepts `Ctrl+V`". — [Interactive mode](https://code.claude.com/docs/en/interactive-mode)
- **@-mentions.**
  - `Explain the logic in @src/utils/auth.js` includes the file's content when it fits the Read tool's limit (25,000 tokens by default). A text file over 256KB isn't included.
  - `@src/components` (a directory) gives a listing, not contents.
  - `@server:resource` pulls MCP resources.
  - @ references also add `CLAUDE.md` from the file's directory and its parents.
  - `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1` (v2.1.299+) sends only the paths.
  - If Read refuses an @-mentioned file (for example a binary type such as `.xlsx`), Claude gets only the path.
  - [Common workflows](https://code.claude.com/docs/en/common-workflows); [Tools reference](https://code.claude.com/docs/en/tools-reference)
- **Read tool and images.**
  - "PNG, JPEG, GIF, and WebP files are returned as visual content that Claude can see... Claude Code resizes and recompresses large images to fit the model's image size limits before sending them, so Claude may see a downscaled version of a large screenshot."
  - "If Claude misses fine pixel-level detail in a large image, ask it to crop the region you care about, such as with ImageMagick via Bash, and then read the crop."
  - Read refuses images over 128 MB.
  - PDFs over 10 pages are read in ranges of up to 20 pages and need `pdftoppm` (poppler) on PATH, Windows included.
  - [Tools reference](https://code.claude.com/docs/en/tools-reference)
- **Read permissions.** File-access tools, Read included, need no permission inside the working directory but "still prompt for paths outside the working directory and additional directories". — [Tools reference](https://code.claude.com/docs/en/tools-reference). In a Manual-mode `-p` run, a call that needs approval is denied unless something approves it. Listing `Read` in `--allowedTools` lets Claude read without asking, apart from network paths. — [headless](https://code.claude.com/docs/en/headless)
- **Image attachments as content blocks.** In the Agent SDK, images go in as `{"type":"image","source":{"type":"base64","media_type":"image/png","data":...}}` blocks inside a streaming-input user message. Single message mode doesn't support direct image attachments. An image block with no valid `source` is replaced by a text note, `[Image could not be processed: ...]`. — [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- **API vision limits.**
  - Formats: JPEG, PNG, GIF and WebP. Only the first frame of an animation is used.
  - Maximum size: 8000x8000 px per image. When a request has more than 20 images, resize each to 2000 px or less per side.
  - Per-image size: 10 MB (base64) on the Claude API, 5 MB on Bedrock and Google Cloud.
  - Images per request: up to 600 on the API (100 for 200k-context models), 20 per message on claude.ai.
  - Total request size limit: 32 MB.
  - [Vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- **Resolution and token cost.** Cost is `⌈width/28⌉ × ⌈height/28⌉` visual tokens. "Claude 4.7 and later models" use the high-resolution tier (2576 px long edge, at most 4784 visual tokens). All other models use the standard tier (1568 px, at most 1568 tokens). A 1920x1080 screenshot isn't resized on the high-res tier and costs 2691 tokens, versus 1560 tokens at 1456x819 on standard. "Downsample images before sending to control token costs" when the extra fidelity isn't needed. — [Vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- **Prompting with images.**
  - "Claude works best when images come before text."
  - "When sending several images, introduce each one with a short text label (`Image 1:`, `Image 2:`, and so on)."
  - Keep important text legible, and watch out for heavy JPEG compression.
  - Claude "might hallucinate or make mistakes when interpreting low-quality, rotated, or very small images under 200 pixels".
  - Claude doesn't read image metadata.
  - [Vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- **Claude Code prompt guidance for images.** "Use images when text descriptions would be unclear or cumbersome". Include screenshots of errors, UI designs or diagrams. Example prompts: "Generate CSS to match this design mockup", "Here's a screenshot of the error. What's causing it?". — [Common workflows](https://code.claude.com/docs/en/common-workflows). Visual verification loop: "[paste screenshot] implement this design. take a screenshot of the result and compare it to the original. list differences and fix them." — [Best practices](https://code.claude.com/docs/en/best-practices)
- **Other reference material.** "Reference files with `@`", "Paste images directly", "Give URLs for documentation and API references", "Pipe in data", "Let Claude fetch what it needs". — [Best practices](https://code.claude.com/docs/en/best-practices)
- **`--file <specs...>`.** "File resources to download at startup. Format: file_id:relative_path (e.g., --file file_abc:doc.txt file_def:img.png)". — [local] `claude --help`, v2.1.306

### Inferences
**[constructed] Image review in `-p` from PowerShell 5.1 (not run):**
```powershell
claude -p "Image 1 is C:\shots\expected.png (the approved design). Image 2 is C:\shots\actual.png (the current build). Read both images. Compare only layout, spacing and colors of the header and booking form; ignore text content. List differences, most important first, with approximate pixel offsets." `
  --add-dir C:\shots --allowedTools "Read" --permission-mode dontAsk --output-format json
```
- **Where to keep images.** Images saved by the workspace app to `inbox/attachments/` sit inside the hub's working directory, so a hub `-p` run can Read them with no extra flags. For a project session, copy reference images into the project, for example `docs/reference/`, or pass `--add-dir`.
- **Practices for reference images**, combining the cited guidance:
  - Name each image and its role ("Image 1 = target design").
  - Say what to look at and what to ignore.
  - Put the images (paths or chips) before the request.
  - Crop to the region of interest instead of sending full 4K screenshots.
  - Ask Claude to describe what it sees first, so you can catch a misread before it acts on it.
- **Images over stdin.** For pipelines that must send images as content, not paths, `--input-format stream-json` should accept the same user-message shape the SDK uses, because the SDK drives the CLI. This was not verified for raw CLI use.

### Gaps
- No doc fetched states explicitly that `@path` mentions inside a `-p` prompt string are expanded the way they are interactively.
- The exact downscale target Claude Code's Read tool uses (as opposed to the API's tier limits) isn't documented on the pages fetched.
- The exact NDJSON line format for `--input-format stream-json` on the raw CLI (whether fields such as `parent_tool_use_id` or `session_id` are required) wasn't found on the pages fetched.

## 7. Windows-specific gotchas for passing prompts and arguments to claude.exe

### Takeaway
On Windows PowerShell 5.1, arguments to native programs use the "Legacy" quoting behavior, which mangles embedded double quotes and drops empty strings. That breaks inline JSON for `--json-schema`, `--settings`, `--agents` and `--mcp-config`. Piping text into `claude` encodes it with `$OutputEncoding`, which defaults to ASCII in 5.1, so non-ASCII characters turn into `?`. Prefer file-based flags, stdin with UTF-8 forced, or a Node `spawn` with an argument array.

### Cited Findings
- **PowerShell 7.3 changed native argument passing.** It's "a breaking change from the Windows PowerShell 5.1 behavior". `$PSNativeCommandArgumentPassing` (`Legacy`, `Standard`, `Windows`) defaults to `Windows` on Windows. In 7.3+, embedded quotes and empty-string arguments are preserved. In `Windows` mode, `cmd.exe` and `.bat`/`.cmd` files still use Legacy passing. In Legacy mode "you must escape the quotes or use the stop-parsing token (`--%`)", for example `TestExe -echoargs "\""C:\Program Files (x86)\Microsoft\\"""`. — [about_Parsing](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing)
- **Stop-parsing token `--%`.** It passes the rest of the line literally. Only `%ENVVAR%` is expanded: no PowerShell variables, and no redirection. "The stop-parsing token is effective only until the next newline or pipeline character." — [about_Parsing](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing)
- **`$OutputEncoding` in 5.1.** "Determines the character encoding method that PowerShell uses when piping data into native applications." Default in 5.1: "ASCIIEncoding object". Microsoft's own example shows `'café'` arriving as `caf?`. Fix: `$OutputEncoding = [System.Text.UTF8Encoding]::new()`. — [about_Preference_Variables (5.1)](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-5.1)
- **Portable npm scripts.** Use escaped double quotes inside `package.json` scripts so they work on Windows. — [headless](https://code.claude.com/docs/en/headless)
- **Claude's own PowerShell tool on Windows** (this is about the commands Claude runs, not about invoking `claude`):
  - It's on by default for claude.ai and Console accounts when Git Bash is installed. It auto-detects `pwsh.exe` and falls back to `powershell.exe` 5.1, and runs with `-ExecutionPolicy Bypass` at process scope.
  - "On Windows with Git Bash installed, denying Bash also turns the PowerShell tool off for the session", scoped rules like `Bash(git push *)` included, unless `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` or a `PowerShell(...)` rule is set.
  - With this tool, redirection writes UTF-8 on 5.1 and piped stdin to native commands is UTF-8.
  - [Tools reference](https://code.claude.com/docs/en/tools-reference)
- **Remove-Item safeguards.** System paths and bare wildcards are denied in every mode. `cmd /c rd /s /q C:\...` on system paths is denied (v2.1.283+). — [permission modes](https://code.claude.com/docs/en/permission-modes)
- **Local install.** This machine runs a native install at `%USERPROFILE%\.local\bin\claude.exe`, v2.1.306, per `context/stack.md` and the local `claude --version`. — [local]

### Inferences
**[constructed] PowerShell 5.1 patterns (not run):**
```powershell
# 1) Long or non-ASCII prompts: send via stdin with UTF-8 forced (avoids both quoting and ASCII mangling)
$OutputEncoding = [System.Text.UTF8Encoding]::new()
Get-Content .\prompts\step1.md -Raw -Encoding UTF8 | claude -p "Follow the instructions above." --output-format json

# 2) Inline JSON (e.g. --json-schema) in 5.1: escape inner quotes as \" and keep the JSON free of spaces
$schema = '{\"type\":\"object\",\"properties\":{\"functions\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"functions\"]}'
claude -p "Extract the main function names from auth.py" --output-format json --json-schema $schema
# NOTE: the same \" string would be double-escaped under PowerShell 7.3+ Standard/Windows mode; there pass the plain JSON.

# 3) Prefer file forms where they exist (no quoting at all)
claude -p "Run the audit" --settings .\ci\settings.json --mcp-config .\ci\mcp.json --strict-mcp-config --agents .\ci\agents.json

# 4) Save output as UTF-8 explicitly rather than with '>'
claude -p "Summarize CHANGELOG.md" | Out-File -Encoding utf8 .\summary.md
```
- **npm installs vs native.** Under PowerShell 7.3+, invoking `claude` through an npm-installed `claude.cmd` shim would still get Legacy quoting, because `.cmd` files are a Legacy-mode exception. The native `claude.exe` used on this machine avoids that.
- **Capturing output into PowerShell.** Reading claude's stdout into a variable decodes it with `[Console]::OutputEncoding`, the OEM code page by default. Non-ASCII text in JSON results could be mangled, so setting `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()` before capturing is likely needed. This was not verified here.
- **Redirection in 5.1.** In the user's own Windows PowerShell 5.1 console, `>` / `Out-File` default to UTF-16LE (unlike Claude's PowerShell tool, which forces UTF-8). This comes from general PowerShell knowledge and was not verified in this session, so use `Out-File -Encoding utf8` or `Set-Content -Encoding utf8`.
- **Most robust option on Windows.** Drive multi-step pipelines from a Node script (`child_process.spawn('claude', ['-p', prompt, '--output-format', 'json', ...])`) and pass the prompt through stdin. This sidesteps both the 5.1 quoting rules and the ASCII pipe encoding, and it matches the workspace's existing Node tooling.

### Gaps
- No Anthropic doc page specifically about quoting `claude` arguments in PowerShell 5.1 vs 7.3+ was found. The guidance above combines Microsoft's parsing docs with the CLI flag descriptions.
- How claude.exe parses its own Windows command line (standard MSVC/CommandLineToArgvW rules or otherwise) is undocumented, so the `\"` workaround is inferred and should be tested once, for example with `--json-schema` on a trivial prompt.
- How claude.exe decodes stdin (always UTF-8, or the console code page) isn't documented on the pages fetched.
