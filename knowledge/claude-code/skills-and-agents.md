---
title: Skills and subagents
tags: [claude-code, skills, subagents, frontmatter]
updated: 2026-10-20
claude_code_version: 2.1.304
---

# Skills and subagents

**TL;DR:** A skill (`.claude/skills/<name>/SKILL.md`) becomes `/name`; a subagent
(`.claude/agents/<name>.md`) runs in its own context. Give both `name` and `description`, never
reuse a built-in command name, and remember that `allowed-tools` pre-approves but does not restrict.

## Where skills live

| Location | Path | Invoked as |
|---|---|---|
| Personal (all projects) | `~/.claude/skills/<name>/SKILL.md` | `/name` |
| Project | `.claude/skills/<name>/SKILL.md` | `/name` |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | `/plugin:name` |
| Enterprise | managed settings directory | `/name` |

- Name clash: enterprise beats personal, personal beats project.
- A `<subdir>/.claude/skills/` folder loads when Claude works in that subdirectory.
- Claude Code does **not** look in `library/skills/`. This workspace copies library skills to
  `~/.claude/skills/` with `node tools/install-library.mjs`.
- Skills reload live. Only a top-level skills folder that did not exist when the session started
  needs `/reload-skills` (for agents: a restart).
- `.claude/commands/<name>.md` still works (older single-file form), but a skill with the same
  name wins, and only skills can have supporting files. Use skills for new work.

## SKILL.md frontmatter

The frontmatter is read only if `---` is on **line 1**. In Claude Code every field is optional
(`name` defaults to the folder name), but this workspace always sets `name` (= folder name) and
`description`.

| Field | What it does |
|---|---|
| `name` | The `/command` name (the folder name also works) |
| `description` | When to use it. Put the trigger first: description plus `when_to_use` is cut at 1,536 characters in the listing |
| `when_to_use` | Extra trigger text |
| `argument-hint` | Shown in the `/` menu, e.g. `[feature description]` |
| `arguments` | Named arguments, e.g. `arguments: [issue, branch]`, used as `$issue` |
| `disable-model-invocation: true` | Only you can run it; its description is removed from Claude's context |
| `user-invocable: false` | Hidden from the `/` menu; only Claude can load it (background knowledge) |
| `allowed-tools` | **Pre-approves** tools for the turn that invokes the skill (the grant clears when you send your next message), e.g. `Bash(git add *) Bash(git commit *)` |
| `disallowed-tools` | **Restricts**: these tools are not available while it runs |
| `model`, `effort` | Model alias (or `inherit`) and effort `low`..`max` |
| `context: fork`, `agent` | Run in a forked context / as a given agent |
| `paths` | Globs that limit when the skill applies |
| `shell` | `bash` or `powershell`, for `!` commands |
| `hooks` | Hooks defined by the skill (`once: true` works only here) |

Unknown fields are ignored by Claude Code. Outside Claude Code (claude.ai upload, Skills API)
only `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools` are allowed.

**allowed-tools vs disallowed-tools.** `allowed-tools` does not limit anything; Claude can still
use other tools, with the usual prompts. To restrict, use `disallowed-tools` or `permissions.deny`.
Workspace trust never gates `allowed-tools`, so avoid broad entries such as `Bash(*)`.

## Arguments and substitutions

- `$ARGUMENTS` is everything after `/name`. `$0`, `$1` (or `$ARGUMENTS[0]`) are 0-based words.
- If a skill gets arguments but has no placeholder, Claude Code appends `ARGUMENTS: <value>`.
- When Claude invokes a skill itself it may pass nothing, so add a fallback line such as
  "If no arguments were given, use the user's latest request."
- Other substitutions: `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`,
  `${CLAUDE_EFFORT}`. Escape a literal dollar sign as `\$`.
- A line starting with `` !`cmd` `` (or a ```` ```! ```` block) runs **before** the skill loads and
  its output is inserted. A failing command aborts the skill. Without Git Bash, set `shell: powershell`.
- Supporting files sit next to SKILL.md and are linked by relative path (`[reference.md](reference.md)`).
  Run scripts via `${CLAUDE_SKILL_DIR}/scripts/...`. Keep SKILL.md under 500 lines.

```markdown
---
name: capture-lesson
description: Save a lesson as a knowledge note. Use when the user says "remember this" or "file this lesson".
argument-hint: <lesson>
---
Lesson: $ARGUMENTS (if empty, use the lesson from the conversation).
1. grep knowledge/ for an existing note on the topic; update it rather than duplicate.
```

## Built-in names to avoid

In a terminal session a project skill with a built-in's name **replaces** the built-in.
Never name a skill: plan, resume, recap, run, review, init, memory, doctor, compact, clear,
context, config, status, hooks, mcp, agents, skills, verify, goal, loop, schedule, batch, fork,
help, model, cost, usage, rewind, export, add-dir, login, logout, permissions, statusline, tasks,
todos, btw, diff, effort, plugin, reload-skills, code-review, security-review, simplify, rename,
branch, background, stats, theme, terminal-setup, fewer-permission-prompts.
To be safe, the workspace also blocks settings, new, continue, reset, undo, checkpoint, bashes and `handoff` (hence `write-handoff`). `tools/check-workspace.mjs` checks this.

## Subagents

Files: `.claude/agents/<file>.md` (scanned recursively) or `~/.claude/agents/<file>.md`.
Priority: managed > `--agents` JSON > project > user > plugin. The body is the system prompt.

| Field | Notes |
|---|---|
| `name` | **Required.** Max 256 chars, no `:`, not starting with `-`. Filename need not match |
| `description` | **Required.** When to delegate ("use proactively after edits") |
| `tools` | Comma string or YAML list. Omitted = inherits every tool available to subagents |
| `disallowedTools` | Tools to remove |
| `model` | `sonnet`, `opus`, `haiku`, `fable`, `inherit`, or a full model ID |
| `permissionMode`, `maxTurns`, `effort`, `skills`, `mcpServers`, `hooks` | Optional |
| `memory` | `user`, `project` or `local` |
| `isolation: worktree`, `background`, `color`, `initialPrompt`, `omitClaudeMd` | Optional |

```markdown
---
name: code-reviewer
description: Reviews the current diff for bugs. Use proactively after edits.
tools: Read, Glob, Grep, Bash, PowerShell
model: sonnet
---
You are a careful code reviewer...
```

- Subagents get the CLAUDE.md hierarchy (unless `omitClaudeMd: true`) but not auto memory.
- "Only run read-only commands" in the prompt is an instruction, not a restriction. Leave Bash and
  PowerShell out of `tools` if the agent must not run commands.
- On Windows, add `PowerShell` to `tools` if the agent should use the primary shell.
- A built-in read-only `Explore` agent already exists.

**Invoking:** type `@agent-<name>` in your prompt (e.g. `@agent-code-reviewer check my diff`), ask
in plain words ("use the code-reviewer agent"), or run a whole session as one: `claude --agent <name>`.
In 2.1.304 `/agents` only prints a reminder; create agents by asking Claude or by editing the files.

Sources: https://code.claude.com/docs/en/skills and https://code.claude.com/docs/en/sub-agents
