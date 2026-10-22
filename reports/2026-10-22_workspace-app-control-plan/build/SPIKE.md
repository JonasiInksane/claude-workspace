# S6 headless spike results (Claude Code 2.1.307)

The run engine's assumptions are now settled by real runs. **Three plan assumptions are wrong and change the design:**

- **CLAUDE.md does not load under `--restricted`.** AGENTS.md does not load in any mode when a CLAUDE.md exists.
- **Read deny rules do not protect secrets from Bash.** `grep -r`, `cat .en?` and `git grep --no-index` printed the canary despite `Read(//**/.env*)`.
- **Claude's Bash children outlive the app.** When the Node parent exits, claude.exe dies, but the Git Bash and node processes under it keep running.

Everything else held or has a clean workaround. The details are below.

- **Runs:** 29 claude runs on `--model haiku` (resolves to `claude-haiku-5-5`) with `--effort low`, plus 2 on `--model sonnet` and 3 process tests without claude. The API-equivalent cost was about $0.07 in total.
- **Node:** every run used Node v24.11.1. The nvm folder on this PC has no Node 20, so nothing was checked on Node 20.
- **What I touched:** I worked only under the spike folder: no hub or Tattoogenda files, and no hub git changes.
- **Paths:** `<spike>` below is `C:\Users\jonas\AppData\Local\Temp\claude\C--dev-claude-workspace\f6dd341f-636f-4e74-8fae-0d14a3e72b23\scratchpad\spike`. Each run's evidence is in `<spike>\out\<name>.jsonl`, plus `.meta.json` (argv, env variable names, exit code) and `.stderr.txt`.

**Base argv** for every run unless the row says otherwise:
`-p --output-format stream-json --verbose --model haiku --effort low --max-budget-usd 0.25 --no-session-persistence`

**READ** below means:
`--restricted --strict-mcp-config --permission-mode manual --permission-prompts none --tools Read,Grep,Glob`

**CHECK** is READ with `--tools Read,Grep,Glob,Bash`.

The environment was the user's env minus `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_EFFORT`, `CLAUDE_PID`, `GIT_EDITOR`, `NoDefaultCurrentDirectoryInExePath`, `PWD` and `OLDPWD`. The prompt went on stdin and stdin was then closed.

## Experiments

### E1: prompt on stdin, and `--verbose`
- **argv:** E1a is the base argv with no positional prompt. E1b is the same without `--verbose`.
- **Observed:**
  - E1a exit 0: init, assistant, `rate_limit_event`, result/success.
  - E1b exit 1 with nothing on stdout. Stderr: `Error: When using --print, --output-format=stream-json requires --verbose`.
- **Conclusion:** a plain-text prompt on stdin works, so the fallback isn't needed. `--verbose` is required with stream-json.
- **Evidence:** `<spike>\out\E1a.jsonl`, `<spike>\out\E1b.stderr.txt`

### E2: the system/init event
- **argv:**
  - E2a: base + `--permission-mode manual --tools Read,Grep,Glob`
  - E2b: base with `--model sonnet` + `--permission-mode acceptEdits --tools Read,Edit,Write`
- **Field names:** `type, subtype, cwd, session_id, tools, mcp_servers, model, permissionMode, slash_commands, terminal_slash_commands, apiKeySource, claude_code_version, output_style, agents, skills, plugins, capabilities, analytics_disabled, product_feedback_disabled, uuid, memory_paths, original_cwd, additional_directories, messaging_socket_path, fast_mode_state, fast_mode_disabled_reason, per_turn_effort_active, view_mode, powershell_path`
- **Values:**
  - `permissionMode` is `"default"` for manual and `"acceptEdits"` for acceptEdits.
  - `model` is the resolved id: `claude-haiku-5-5` and `claude-sonnet-5-5`.
  - `apiKeySource` is `"none"` (subscription login). `claude_code_version` is `"2.1.307"`.
- **Tools:** with `--tools`, the list is the requested tools sorted alphabetically, plus every `mcp__claude_ai_Claude_Docs__*` connector tool unless `--strict-mcp-config` is passed. With `--json-schema` it also has `StructuredOutput`. No `EndConversation` appeared in any run. Without `--tools` you get the full built-in set (Task, Bash, PowerShell, WebFetch and so on).
- **mcp_servers:** `[{"name":"claude.ai Claude Docs","status":"connected","source":"claudeai"}]`, or `[]` with `--strict-mcp-config`.
- **cwd:** a Windows backslash path equal to the spawn cwd. `original_cwd` is the same.
- **Restricted fingerprint:** under `--restricted`, the `memory_paths` and `messaging_socket_path` keys are absent and `output_style` is `"default"`. The test repo's `.claude/settings.json` sets `"Explanatory"`, so this shows project settings are ignored.
- **Sensitive:** no email or account id anywhere. Fixtures must redact:
  - user-folder paths: `cwd`, `original_cwd`, `memory_paths`, `additional_directories`, tool file paths, the hook `transcript_path`;
  - `messaging_socket_path` (a pipe name);
  - `rate_limit_event`, which carries your 5-hour usage utilisation and reset time.
- **Evidence:** `<spike>\out\E2a.jsonl`, `<spike>\out\E2b.jsonl`

### E3: CLAUDE.md, AGENTS.md and MCP under `--restricted`
- **argv** (all with `--tools ""` and a "what are the codewords" prompt):
  - E3a: base + `--permission-mode manual`
  - E3b: base + `--restricted --permission-mode manual --permission-prompts none`
  - E3c: E3b + `--strict-mcp-config`
  - E3d and E3e: the non-restricted and restricted runs with `--strict-mcp-config` added, plus `--debug-file`.
- **Observed:**

  | Run | Answer | MCP |
  |---|---|---|
  | E3a, E3d (not restricted) | `CODEWORD=PINEAPPLE AGENTS=NONE` | E3a: connector loaded |
  | E3b (restricted) | `CODEWORD=NONE AGENTS=NONE` | connector still loaded and in tools |
  | E3c (restricted, strict MCP) | `CODEWORD=NONE AGENTS=NONE` | `tools []`, `mcp_servers []` |

  The restricted debug log says `$.fs.ancestors (cc-plugin-agents-md): project memory is off`.
- **Conclusion:**
  - `--restricted` turns project memory off, so CLAUDE.md is not loaded.
  - AGENTS.md is not loaded in either mode when a CLAUDE.md exists; this is the built-in `cc-plugin-agents-md` with its default options.
  - `--restricted` still loads claude.ai MCP connectors unless `--strict-mcp-config` is passed.
- **Evidence:** `<spike>\out\E3b.jsonl`, `<spike>\out\E3c.jsonl`, `<spike>\out\E3d.debug.txt`, `<spike>\out\E3e.debug.txt`

### E4: `--json-schema` with Read, Grep, Glob
- **argv:**
  - E4a: base + READ + `--json-schema {"type":"object","properties":{"name":{"type":"string"},"lines":{"type":"integer"}},"required":["name","lines"],"additionalProperties":false}`
  - E4b: the same with a schema that can't be met: `{"n":{"type":"integer","minimum":10,"maximum":5}}`
- **E4a:**
  - `structured_output: {"name":"spike-e4a","lines":3}` is valid, and `result` holds the same JSON as a string.
  - Claude first answered in plain text, then got an injected user text `[structured-output-enforce] You MUST call the StructuredOutput tool...` and complied.
  - The result has `stop_reason: "tool_use"` and `num_turns: 5`.
- **E4b:** the StructuredOutput tool_result came back as an error (`Output does not match required schema: /n: must be >= 10`) twice. The run still ended `subtype: "success"`, `is_error: false`, exit 0, with **no** `structured_output` key.
- **Conclusion:** check `structured_output` yourself. "success" does not imply it is there.
- **Evidence:** `<spike>\out\E4a.jsonl`, `<spike>\out\E4b.jsonl`

### E5: `--max-turns`
- **argv:** base + READ + `--max-turns 2`
- **Observed:** the flag is accepted (it isn't in the local help). The result:
  - `subtype: "error_max_turns"`, `is_error: true`, `terminal_reason: "max_turns"`
  - `num_turns: 3`, no `result` field, `errors: ["Reached maximum number of turns (2)"]`
  - exit code 1, after 2 assistant responses.
- **Turn counting:** in all 10 runs checked, `num_turns` equals 1 plus the number of user (tool_result) events. Unique assistant message ids undercount: parallel tool calls share one id (E9 had 13 ids against 23 turns).
- **Evidence:** `<spike>\out\E5.jsonl`

### E6: Read deny rules against Read, Grep and Glob
- **argv:** base + READ + `--settings <spike>\settings\E6x.json`, with `permissions.deny` set to:
  - E6a: `["Read(//**/.env*)"]`
  - E6b: `["Read(//c/Users/jonas/.../repos/E6b/.env)"]`
  - E6c: `["Read(**/.env*)"]`
  - E6z (control): `[]`
- **Observed:** all three forms behave the same.

  | Call | With a deny rule | Control (no rule) |
  |---|---|---|
  | Read `.env` | denied: "File is in a directory that is denied by your permission settings." | content shown |
  | Grep `CANARY_SECRET` with `path: ".env"` | denied: "Permission to read ...\\.env has been denied." | content shown |
  | Grep over `.` | "No matches found" (silently filtered) | content shown |
  | Glob `.env*` | "No files found" (silently hidden) | lists `.env` |

  - `result.permission_denials` lists the Read and the Grep-on-path denials.
  - Only the Grep denial also emits a `system/permission_denied` event (`decision_reason_type: "rule"`); the Read denial emits none.
- **Evidence:** `<spike>\out\E6a.jsonl`, `<spike>\out\E6b.jsonl`, `<spike>\out\E6c.jsonl`, `<spike>\out\E6z.jsonl`

### E7: the CHECK profile
- **argv:** base + CHECK + `--settings` with `{"autoMemoryEnabled":false,"permissions":{"allow":["Bash(tg-check *)"],"deny":["Read(//**/.env*)"]}}`. PATH was prefixed with `<spike>\bin-E7`, which holds an extensionless sh script `tg-check` and a `tg-check.cmd`.
- **E7 results:**

  | Command | Outcome |
  |---|---|
  | `tg-check test` | ran (`tg-check ran test`) |
  | `cat .env` | denied by the Read deny rule (`subcommandResults`) |
  | `type .env` | ran (bash builtin: "not found") |
  | `git log -1` | ran, no rule needed |
  | `ls` | ran, no rule needed |
  | `echo $PATH` | denied: needs approval (`asyncAgent`) |
  | `node -e "console.log(1)"` | denied: needs approval (`asyncAgent`) |

- **E7z, control without the deny rule:** `cat package.json`, `cat .env` (printed the canary) and `echo hello` all ran with no rule.
- **E7b, indirect reads with the deny rule:**

  | Command | Outcome |
  |---|---|
  | `grep -r CANARY_SECRET .` | **ran, printed the canary** |
  | `cat .en?` | **ran, printed the canary** |
  | `git grep --no-index CANARY_SECRET` | **ran, printed the canary** |
  | `head -1 .env` | denied (`subcommandResults`) |
  | `sed -n 1p .env` | denied (`subcommandResults`) |
  | `cat ./src/../.env` | denied: needs approval (`asyncAgent`) |

- **Conclusion:**
  - The built-in read-only set (cat, grep, git grep, git log, ls, type, plain echo) runs with no allow rule. `echo $VAR` is not in it on 2.1.307.
  - The Read deny rule catches only literal file arguments. **Deny rules are not a Bash barrier.**
  - The extensionless `tg-check` script resolves from Git Bash.
- **Evidence:** `<spike>\out\E7.jsonl`, `<spike>\out\E7b.jsonl`, `<spike>\out\E7z.jsonl`

### E8: a PreToolUse hook from `--settings` under `--restricted -p`
- **argv:** base + `--restricted --strict-mcp-config --permission-mode manual --permission-prompts none --tools Bash --settings <spike>\settings\E8.json`. The settings file has:
  - `allow ["Bash(echo *)"]`
  - `hooks.PreToolUse [{matcher:"Bash", hooks:[{type:"command", command:"node", args:["<spike>\hooks\hook.mjs","<log>"], timeout:30}]}]`
- **Observed:**
  - The hook fired 3 times, once per Bash call.
  - Its input has `session_id, transcript_path, cwd, prompt_id, permission_mode ("default"), effort {level}, hook_event_name, tool_name, tool_input, tool_use_id`. `transcript_path` is present even with `--no-session-persistence`.
  - `echo hello-ok` ran.
  - `echo DENY_EXIT2` (exit 2) and `echo DENY_JSON` (`permissionDecision: "deny"`) were both refused, even though `Bash(echo *)` is allowed.
  - Both refusals are in `permission_denials`, and their `tool_result_meta` is `{"decision":"reject","source":"hook","reason_type":"hook"}`. There is no `system/permission_denied` event for hook denials.
  - The exit-2 tool_result text contains the full hook command line with absolute paths.
- **Conclusion:** the guard hook works, and a hook deny beats an allow rule.
- **Evidence:** `<spike>\out\E8.jsonl`, `<spike>\out\E8.hooklog.jsonl`

### E9: which files the EDIT profile refuses
- **argv:** base + `--restricted --strict-mcp-config --permission-mode acceptEdits --permission-prompts none --tools Read,Edit,Write --settings` with `{"autoMemoryEnabled":false}`. No Bash.
- **Observed, checked on disk with git status:**
  - **Written:** `src/app.js`, `package.json`, `CLAUDE.md`, `.github/workflows/ci.yml` (new), `.gitignore` (new), `tsconfig.json` (new), `notes/new.txt` (new).
  - **Refused:** `.claude/settings.json`, `.git/config`, `.husky/pre-commit`, `.vscode/settings.json`, `.mcp.json`. Each counted as "needs approval" and was then auto-denied (`asyncAgent`).
  - Haiku first tried a made-up path outside the working folder; `--restricted` refused it ("--restricted: path outside the working directory").
- **Conclusion:** the protected set is `.claude`, `.git`, `.husky`, `.vscode` and `.mcp.json`. **CLAUDE.md and `.github/workflows` are not protected.**
- **Evidence:** `<spike>\out\E9.jsonl`, `<spike>\out\E9.disk.txt`

### E10: scrubbed environment
- **argv:** base + READ, with env reduced to `PATH, PATHEXT, SystemRoot, windir, ComSpec, USERPROFILE, HOMEDRIVE, HOMEPATH, APPDATA, LOCALAPPDATA, TEMP, TMP, ProgramData, ProgramFiles` plus `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`.
- **Observed:** exit 0, `result=ready`. The subscription login works and nothing was missing.
- **Side note:** the inherited user env includes `MESHY_API_KEY` (name seen; value not read), which is one more reason to scrub.
- **Evidence:** `<spike>\out\E10.jsonl`, `<spike>\out\E10.meta.json`

### E11: `--session-id` and `-p --resume`
- **argv:**
  - E11a: base without `--no-session-persistence` + READ + `--session-id <uuid> -n spike-E11`
  - E11b: the same flags with `--resume <uuid>` instead of `--session-id`/`-n`
  - E11c: base + `--resume <uuid>` only
- **Observed:**
  - `init.session_id` equals the chosen uuid in all three.
  - E11b answered `ZEPHYR-42`, so it continued the conversation.
  - With `-n`, `system/session_title_changed` arrives **before** `system/init`.
  - E11c (no flags passed again) came up with the full default tool set, MCP and project settings.
- **Conclusion:** resume works but restores no flags, so pass every flag again. Don't assume init is line 1.
- **Evidence:** `<spike>\out\E11a.jsonl`, `<spike>\out\E11b.jsonl`, `<spike>\out\E11c.jsonl`

### E12: `--input-format stream-json`
- **argv:** base + READ + `--input-format stream-json`
- **Observed:** stdin `{"type":"user","message":{"role":"user","content":"Reply with the single word: ready"}}\n`, then end of stdin, gave exit 0 and `ready`.
- **Evidence:** `<spike>\out\E12.jsonl`

### E13: cancel with a tree kill
- **argv:** base + `--restricted --strict-mcp-config --permission-mode manual --permission-prompts none --tools Bash --settings` with `allow ["Bash(node *)"]`. Claude was asked to run `node -e "setInterval(()=>{},1000)" E13MARK<n>`; `taskkill /T /F /PID` ran 5 s after the Bash tool_use.
- **Observed:**
  - The tree was claude.exe, then conhost and Git `bin\bash.exe`, then `usr\bin\bash.exe` (twice, with a conhost), then node.exe.
  - taskkill killed all 7. Nothing survived and no process with the marker remained.
  - Exit code 1. The output ends at `system/task_started` with no result line.
  - Bash command lines contain the command and `export TEMP='...' TMP='...'`. Neither claude.exe's nor bash's command line contains the cwd.
- **Evidence:** `<spike>\out\E13.jsonl`, `<spike>\out\E13.procs.json`

### E14: survivors when the Node parent exits (`<spike>\e14.mjs`)

| Variant | Child | Grandchild |
|---|---|---|
| node, node, node; parent calls `process.exit` | died | died |
| same tree; the child gets `taskkill /T /F` | died | died |
| node, Git Bash, node; parent calls `process.exit` | bash.exe survived | node.exe survived |
| **node, claude.exe (busy in Bash); parent calls `process.exit`** | **claude.exe died** | **3 bash.exe, conhost and node.exe survived** |

- **Conclusion:** libuv's job object kills direct children, and node chains die too. Anything under Git Bash breaks away. The app must tree-kill before it exits, and startup recovery must look for orphans. All survivors were cleaned up.
- **Evidence:** `<spike>\out\E14-exit.json`, `<spike>\out\E14-taskkill.json`, `<spike>\out\E14-bash-exit.json`, `<spike>\out\E14-claude-exit.json`

### E15: `--add-dir` and `blockReadsOutsideWorkingDirectories`
- **argv:** base + `--strict-mcp-config --permission-mode manual --permission-prompts none --tools Read,Grep,Glob,Bash --add-dir <spike>\repos\E15x-extra --settings` …
  - E15a: settings `blockReadsOutsideWorkingDirectories: true`, not restricted
  - E15b: `--restricted`, no block setting
  - E15c: neither
- **Observed:**
  - Reading the `--add-dir` file worked in all three; init `additional_directories` lists it.
  - Read and Grep outside both folders were denied in all three, for different reasons:
    - E15a: `decision_reason_code: "outside_reads_blocked"`
    - E15b: "--restricted: path outside the working directory"
    - E15c: needs approval (`asyncAgent`)
  - `cat <outside file>` through Bash was denied in all three (`asyncAgent`).
- **Evidence:** `<spike>\out\E15a.jsonl`, `<spike>\out\E15b.jsonl`, `<spike>\out\E15c.jsonl`

### E16: every stream-json event kind seen
Examples of each are in `<spike>\out\E16.events.json` (built by `<spike>\analyze.mjs`).

- **`system/init`**
- **`system/session_title_changed`** (with `-n`; comes before init)
- **`system/thinking_tokens`** (`estimated_tokens`, `estimated_tokens_delta`)
- **`system/task_started`** (`task_id`, `run_id`, `tool_use_id`, `is_backgrounded`, `task_type: "local_bash"`)
- **`system/permission_denied`** (`tool_name`, `tool_use_id`, `decision_reason_type`, `decision_reason`, `decision_reason_code`, `message`). Seen types: `rule`, `subcommandResults`, `asyncAgent`, `other`, and `other` with code `outside_reads_blocked`.
- **`assistant`** with content blocks `text`, `thinking` and `tool_use`.
- **`user`** with `tool_result` (with and without `is_error`) and `text` (the structured-output enforce message). User events also carry:
  - `tool_use_result`
  - `tool_result_meta [{id, non_execution_kind?, permission_decision {decision: accept|reject, source: config|hook, reason_type: mode|subcommandResults|asyncAgent|other|rule|hook}}]`
- **`rate_limit_event`**: `rate_limit_info.status`, `rateLimitType`, `unifiedWindows.five_hour.utilization`, `resetsAt`.
- **`result`** subtypes:
  - `success` (`terminal_reason: "completed"`, fields `result` and `structured_output`)
  - `error_max_turns` (`terminal_reason: "max_turns"`)
  - `error_max_budget_usd` (`terminal_reason: "budget_exhausted"`, `errors: ["Reached maximum budget ($0.0001)"]`, exit 1; the pending tool call never ran; from E16b with `--max-budget-usd 0.0001`)
  - Other result fields: `num_turns`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials [{tool_name, tool_use_id, tool_input}]`, `stop_reason`, `subagent_stats`, `duration_ms`, `ttft_ms`.

### Fixtures
They are in `<spike>\fixtures\`, built by `<spike>\fixtures.mjs`. `<spike>\fixtures\index.json` gives each one's source run, redacted argv, stdin, exit code and expected meaning.

| Group | Fixtures |
|---|---|
| Init, one per tested mode | `init-default`, `init-manual-read`, `init-acceptedits-sonnet`, `init-restricted-mcp`, `init-restricted-strict-notools` |
| Structured output | `success-structured`, `missing-structured` |
| Stops | `max-turns`, `budget-stop`, `cancelled-partial` |
| Denials | `denials-read-rules`, `denials-bash-check`, `bash-read-bypass`, `denials-hook`, `denials-edit-protected`, `denials-outside-dirs` |
| Other | `resume`, `stream-json-input`, `no-verbose` (empty) with `no-verbose.stderr.txt` |

- **Redaction:** the user folder became `C:\Users\user`, the spike folder became `C:\Users\user\spike`, and emails became `user@example.com`. Session ids are kept, and no file still contains the username.
- **One catch:** `bash-read-bypass.jsonl` contains the fake canary line `CANARY_SECRET=not-a-real-secret-7f3a`. If these fixtures go into the hub, S3's secret scan needs to allow it, or the line should be swapped for a placeholder.

## Engine rules

**Argv that works on 2.1.307.** Spawn with an argument array, `windowsHide`, write the prompt to stdin as plain text, then close stdin:
```
claude.exe -p --output-format stream-json --verbose
  --session-id <uuid> -n <run>-<stage>
  --restricted --strict-mcp-config
  --permission-mode manual|acceptEdits --permission-prompts none
  --tools Read,Grep,Glob[,Bash][,Edit,Write]
  --settings <stage>\settings.json
  --max-turns N --max-budget-usd X [--json-schema <inline JSON>]
  --model <alias> --effort <level>
  [--add-dir <run>\inputs]
```
- **Resume:** the same flags with `--resume <sid>` instead of `--session-id`. Nothing is restored otherwise.
- **Not tested:** `--append-system-prompt`, and `--session-id` combined with `--resume`.

**Init check:**
- Use the first event with `type=system, subtype=init`, not line 1 (`-n` puts `session_title_changed` first).
- `permissionMode`: manual shows as `default`; acceptEdits shows as `acceptEdits`.
- `model`: match the family with `/^claude-(opus|sonnet|haiku)-/`. Opus was not tested.
- `tools`: as a set, must equal the requested tools, plus `StructuredOutput` only when a schema is passed. Any `mcp__*` tool or non-empty `mcp_servers` fails the check. There is no EndConversation.
- `cwd` and `additional_directories`: compare against the real paths after resolving, case-insensitively.
- A restricted run also shows `output_style: "default"` and no `memory_paths` key; both are cheap extra checks.
- The init event shows no permission rules. The hook log (`session_id`) is a stronger proof that the guard is active than a canary denial.

**End of a stage:**
- **Exit codes:** 0 for success, including when `structured_output` is missing. 1 for `error_max_turns`, `error_max_budget_usd`, startup errors and killed runs.
- **Structured output:** check that `structured_output` exists, or the stage fails.
- **Denials:** read them from `result.permission_denials`, or from `tool_result_meta.permission_decision.decision == "reject"`. `system/permission_denied` misses Read-rule and hook denials.
- **Turn count:** `num_turns`, or live as 1 plus the number of user tool_result events.

**Reliable:**
- `--restricted`:
  - drops Bash unless `--tools` names it;
  - ignores project settings;
  - confines the file tools to cwd and `--add-dir`;
  - refuses `.claude`, `.git`, `.husky`, `.vscode` and `.mcp.json` writes.
- `--strict-mcp-config` removes the connectors.
- `--permission-prompts none` denies anything that would prompt, immediately.
- Read deny rules (`//**/.env*`, absolute `//c/...`, and `**/.env*` all work) cover Read, Grep, Glob and literal-path Bash.
- The PreToolUse hook from `--settings` fires under `--restricted -p`, and both exit 2 and JSON deny work.
- `blockReadsOutsideWorkingDirectories` works.
- `--max-turns` and `--max-budget-usd` both stop the run.
- A stdin prompt, the scrubbed env, and a tree kill with taskkill all work.

**Not reliable:**
- Deny rules against Bash: `grep -r`, globbed paths and `git grep` leak.
- The built-in read-only set runs cat, grep, git grep, git log, ls and type with no rule.
- `--json-schema` can end in success without output.
- CLAUDE.md is not loaded under `--restricted`. AGENTS.md is never loaded next to a CLAUDE.md.
- The acceptEdits protected set does not include CLAUDE.md, AGENTS.md, `.github/**`, `.gitignore`, `package.json` or `tsconfig.json`.
- Claude's Bash children survive the app exiting.
- The working folder is not visible in `Win32_Process`.

**Safest profiles from what I saw.** All three share `--restricted --strict-mcp-config --permission-prompts none`, and a settings file with `autoMemoryEnabled: false`, `blockReadsOutsideWorkingDirectories: true` and the Read deny rules.

- **READ:** manual mode, `--tools Read,Grep,Glob`, a schema, and inputs through `--add-dir`. The prompt (or injected text) must carry CLAUDE.md and AGENTS.md, because they won't load.
- **CHECK:** READ plus Bash, guarded by a PreToolUse hook (exec form `node guard.mjs`) that works as an **allowlist**. It allows only `^tg-check( [\w:./-]+)*$` with no shell metacharacters and denies everything else. Don't rely on deny rules here.
  - Ship an extensionless sh `tg-check` on the run-only PATH folder.
  - Set TEMP and TMP to a per-run folder. The Bash tool writes TEMP into every `bash -c` command line, which tags orphans for the cleanup scan.
- **EDIT:** acceptEdits with `--tools Read,Grep,Glob,Edit,Write`, adding Bash only behind the same guard hook.
  - Add Edit/Write deny rules for CLAUDE.md, AGENTS.md, `.github/**` and `.gitignore`. These rules were not tested.
  - Make the review gate flag diffs that touch those paths, `package.json` or `tsconfig*`.

**Process cleanup:**
- Before the app exits, `taskkill /T /F` every Claude stage.
- On startup, walk `ParentProcessId` down from the saved claude pid, checking the image name and `CreationDate` against what was stored. Also match the run's `--settings` path or `-n` name in claude.exe's command line, and the per-run TEMP in bash command lines.

**Plan assumptions that were false or need changing:**
1. CLAUDE.md "probably" loads under `--restricted`: it doesn't, and AGENTS.md doesn't load in either mode.
2. The always-present tools are EndConversation and StructuredOutput: there is no EndConversation. MCP connector tools appear unless `--strict-mcp-config`.
3. Init is the first event: not with `-n`.
4. `echo $VAR` is in the read-only set: on 2.1.307 it is denied as needing approval. Plain `echo`, cat, grep and git grep do run with no rule.
5. Read deny rules plus a guard that refuses commands naming `.env` would be enough for CHECK: grep -r, globs and git grep get around name matching. The guard has to be an allowlist.
6. The orphan scan can filter `Get-CimInstance` on the working folder: the cwd isn't visible in any command line.
7. Confirmed rather than false: claude.exe dies with the app and its Git Bash children survive, as the plan suspected. Node-only chains die.
8. Confirmed as the plan said: `manual` shows as `default`; the model is the resolved id; stdin text works; `--verbose` is required; `--max-turns` works (with `error_max_turns`, an `errors[]` field and exit 1); the scrubbed env keeps the login; resume restores no flags.

**Still unverified:**
- Anything on Node 20.
- Opus init values.
- `--append-system-prompt`.
- Edit/Write deny rules.
- `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` semantics (it was only shown not to break E10).
- Interactive resume of a `-p` session.
- lint-staged and the other Tattoogenda-side items, which are out of scope.

**Leftovers in your profile:** the non-restricted runs created empty folders under `C:\Users\jonas\.claude\projects\` for the E1a, E2a, E2b, E3a and E3d repos. The E11 folder holds one transcript. I left them in place.

**Scripts** (in `<spike>`): `harness.mjs`, `experiments.mjs` (`node experiments.mjs E7b` runs one experiment), `e14.mjs`, `hooks\hook.mjs`, `analyze.mjs`, `fixtures.mjs`, `argv.mjs`.