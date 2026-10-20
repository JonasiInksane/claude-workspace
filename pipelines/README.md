# Pipelines: how to make Claude Code work reliably

A **pipeline** is a repeatable way of working: the same stages, in the same order,
each with a clear finish line. Claude does its best work when it doesn't have to guess
what stage it's in or what "done" means.

Start with [00 · Daily workflow](00-daily-workflow.md) for how the whole workspace fits together.

## The core loop (use it for everything)

```
 EXPLORE ──► PLAN ──► IMPLEMENT ──► VERIFY ──► REVIEW ──► COMMIT
    ▲                                  │
    └────────── fix and repeat ◄───────┘
```

| Stage      | What happens                                         | What you say / use |
|------------|------------------------------------------------------|--------------------|
| Explore    | Claude reads the relevant code. No edits yet.        | "Read X and Y, don't change anything yet." · `code-explorer` agent |
| Plan       | Claude proposes the change. You correct it.          | `/plan <task>` (or Shift+Tab into plan mode). For a hard problem, put `ultrathink` in the prompt or raise `/effort high` |
| Implement  | Small steps that are easy to review.                 | "Do step 1 only." |
| Verify     | Prove it works: tests, build, run it, look at it.    | `npm run build`, tests, `/run`, browser preview, playtest |
| Review     | A second look at the diff before it's saved.         | `/code-review` · `code-reviewer` agent |
| Commit     | Save a checkpoint with a clear message.              | "commit this" |

Note: phrases like "think hard" are passed through as ordinary text. Only `ultrathink`
is a keyword.

**The most important rule:** Claude needs a way to check its own work. Give it a test,
a build command, a screenshot to compare against, or a game it can run. Without one,
it can only guess.

## The building blocks

These are what you combine into pipelines, roughly in the order you'll need them.

### 1. `CLAUDE.md`: project memory (always loaded)
Markdown that Claude reads at the start of every session. Put in: how to run, build and test;
a folder map; conventions; things to avoid. The official target is under 200 lines; shorter is better.

| File | Scope |
|---|---|
| `~/.claude/CLAUDE.md` | You, in every project |
| `<project>/CLAUDE.md` or `<project>/.claude/CLAUDE.md` | The team. Commit it |
| `<project>/CLAUDE.local.md` | You, this project only. Loads after `CLAUDE.md`. Add it to `.gitignore` yourself |
| `<project>/src/foo/CLAUDE.md` | Loads the first time Claude reads or edits a file in that folder |

- CLAUDE.md files in the folders *above* where you start Claude also load at launch. So a
  session in `projects/<name>` also loads the hub's `CLAUDE.md`.
- `@path/to/file.md` imports another file. Imports load at launch, so they cost context
  like any other text. For files Claude should open only when needed, write the path in
  backticks (`` `knowledge/INDEX.md` ``): even `` `@path` `` inside backticks is not imported.
- **AGENTS.md:** Claude Code reads a repo's `AGENTS.md` by itself only when no `CLAUDE.md`
  (or `CLAUDE.local.md`) exists in that folder or any folder above it. Projects in this
  workspace always have the hub's `CLAUDE.md` above them, so make `@AGENTS.md` the first
  line of the project's `CLAUDE.md` whenever the repo has an `AGENTS.md`.
- Check what loaded with `/context` (under "Memory files").

### 2. Path-scoped rules: `.claude/rules/*.md`
Instructions for one part of the codebase, so they don't fill the context everywhere else.
Every `.md` under `.claude/rules/` is found, including subfolders.

```markdown
---
paths:
  - "app/**"
  - "components/**"
---
# Next.js rules
- Server Components by default. Put "use client" as low in the tree as possible.
```

- With `paths:`, the rule loads when Claude reads or edits a matching file.
- Without frontmatter, it loads at launch like CLAUDE.md.
- `paths` is the only frontmatter field a rule uses.

The templates ship one each: `.claude/rules/nextjs.md` and `.claude/rules/game-core.md`.

### 3. Skills: repeatable procedures (loaded when needed)
A folder with a `SKILL.md`. Run it yourself with `/skill-name`, or let Claude pick it when the
`description` matches the task. Use skills for checklists you'd otherwise retype:
"add a feature the Next.js way", "onboard a repo", "release a build".

| Location | Scope |
|---|---|
| `<project>/.claude/skills/<name>/SKILL.md` | One project (or the hub, for hub skills) |
| `~/.claude/skills/<name>/SKILL.md` | Every project |
| A plugin's `skills/` folder | Runs as `/<plugin>:<skill>` |

- **This workspace:** global skills live in `library/skills/`, but Claude Code doesn't read
  `library/`. Install them with `node tools/install-library.mjs`, which copies them to
  `~/.claude/skills/` (and `library/agents/` to `~/.claude/agents/`). Existing skill folders
  reload live; if `~/.claude/skills` didn't exist when the session started, run `/reload-skills`.
- Always give a skill a `name` (same as the folder) and a `description` that starts with when to use it.
- Never reuse a built-in name such as `plan`, `run`, `review`, `init`, `resume` or `goal`.
  A project skill with that name replaces the built-in.
- `.claude/commands/<name>.md` is the older single-file form. It still works, but a skill
  with the same name wins.

### 4. Subagents: specialists with their own context
A Markdown file with `name` and `description` in its frontmatter (both required). Optional:
`tools` (if you leave it out, the agent gets every tool available to subagents), `model`,
`color` and more. The body is the agent's system prompt.
Claude hands them a task and they return only a summary, so your main conversation stays clean.
Good for: wide code searches, reviews, writing tests, playtest analysis.
- `<project>/.claude/agents/<name>.md` or `~/.claude/agents/<name>.md`
- Use one by asking ("use the code-reviewer agent on the diff") or with `@agent-<name>`.
- `/agents` no longer has a creation wizard. Ask Claude to create the agent, or write the file.

### 5. `settings.json`: permissions and hooks

| File | Scope |
|---|---|
| `~/.claude/settings.json` | You, every project |
| `<project>/.claude/settings.json` | The team. Commit it |
| `<project>/.claude/settings.local.json` | You, this project. Add it to `.gitignore` |

Precedence, highest first: managed policy, `--settings`, local, project, user.
List settings such as `permissions.allow` merge across files. Files are strict JSON
(no comments, no trailing commas).

- **permissions:** `allow` safe commands so Claude stops asking, `deny` secrets.
  Rules are checked deny first, then ask, then allow.
- **Write each shell rule twice on Windows**, once for Bash and once for PowerShell.
  Claude Code can run commands through either tool, and a Bash rule doesn't cover PowerShell.
  Use a space before the `*`: `Bash(npm run build *)` also matches bare `npm run build`.
  Name scripts one by one: `Bash(npm run *)` would also approve deploy or reset scripts.
- **Deny with bare names** like `Read(.env)`: they match in every folder. `Read(./.env)` only
  covers the folder Claude was started in.
- **Workspace trust:** allow rules in a committed `.claude/settings.json` apply only after
  you accept the folder's trust dialog. Deny rules apply right away.
- `.claudeignore` does nothing. Block files with `Read(...)` deny rules.
- **hooks:** commands the harness runs automatically, e.g. format a file after every edit.
  A hook always runs. A line in `CLAUDE.md` is only a request that Claude may follow.
  On Windows, use exec form (`command` + `args`) with `node`; an npm `.cmd` shim such as
  `npx` can't be started that way.

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": ["Bash(npm run build *)", "PowerShell(npm run build *)"],
    "deny": ["Read(.env)", "Read(.env.local)"]
  },
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/format-file.mjs"] }] }
    ]
  }
}
```

### 6. MCP servers: connect outside tools
Browsers, databases, issue trackers, docs. Add one only when a pipeline needs it.

- **Project scope** lives in `.mcp.json` at the project root and is committed:
  ```json
  {
    "mcpServers": {
      "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
      "docs": { "type": "http", "url": "https://example.com/mcp",
                "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
    }
  }
  ```
  No `type` means a local (stdio) server. A `url` entry needs `"type": "http"`.
- **From the command line:**
  ```powershell
  claude mcp add --transport http --scope project docs https://example.com/mcp
  claude mcp add --transport stdio --scope local pw -- npx -y @playwright/mcp@latest
  ```
  `--scope project` writes `.mcp.json`. `local` (the default) and `user` are stored in
  `~/.claude.json`, so they stay private. Options go before the `--`.
- Use `http` for remote servers. `sse` is deprecated.
- Never commit tokens. Use `${VAR}` (or `${VAR:-default}`) in `.mcp.json` and set the value
  in your environment. For a path inside the project, write `${CLAUDE_PROJECT_DIR:-.}/...`.
- Claude Code asks you to approve each project server the first time. `/mcp` shows status;
  `claude mcp reset-project-choices` resets your answers.
- On Windows, try `"command": "npx"` first. If the server fails to start, use
  `"command": "cmd", "args": ["/c", "npx", "-y", "<package>"]`.

## Designing your own pipeline

1. **Write down the stages** you already follow by hand. Five to seven at most.
2. **Define "done" for each stage.** "Types check and the page renders" works.
   "Looks good" doesn't.
3. **Pick a building block for each stage:**
   - Must happen every time, no exceptions → **hook**
   - A procedure with judgment calls → **skill**
   - A big read or search that would flood the conversation → **subagent**
   - A fact about the whole project → **CLAUDE.md**
   - A rule for one part of the code → **path-scoped rule**
   - A tool outside Claude (browser, database) → **MCP server**
4. **Put it in a skill** so `/name` runs the whole thing:
   `<project>/.claude/skills/<name>/SKILL.md` for one project, or
   `library/skills/<name>/SKILL.md` plus `node tools/install-library.mjs` for every project.
5. **Use it three times, then improve it.** Each time Claude goes wrong, add a line
   to the skill or to CLAUDE.md that would have prevented it. File general lessons with `/capture-lesson`.

### Skill template

```markdown
---
name: my-pipeline
description: Use when <the situation, in your own words>. Claude reads this to decide whether to use the skill.
argument-hint: "<what to build>"
---

# My pipeline

The request: $ARGUMENTS
If that is empty, use the user's latest request.

## 1. Explore
- ...
- Done when: ...

## 2. Plan
- Present the plan and WAIT for approval.

## 3. Implement
- Small steps. Check types or tests after each one.

## 4. Verify
- Run: `...`
- Done when: ...

## 5. Wrap up
- Summarize what changed and anything left unverified.
```

Optional frontmatter fields:

| Field | What it does |
|---|---|
| `argument-hint` | Shown in the `/` menu so you know what to type after the name |
| `disable-model-invocation: true` | Only you can run it. Use it for skills with side effects |
| `allowed-tools` | **Pre-approves** tools for the turn that invokes the skill (cleared at your next message), e.g. `Bash(git add *) Bash(git commit *)`. It does not restrict anything |
| `disallowed-tools` | Takes tools away. Use this to restrict |
| `model`, `effort` | Run the skill with a specific model or effort level |
| `shell: powershell` | Runs the skill's `` !`command` `` lines in PowerShell (for machines without Git Bash) |

Keep `SKILL.md` under 500 lines. Put long reference material in a file next to it and link it.

## Go deeper

The knowledge notes have the details, checked against Claude Code 2.1.304:

| Topic | Note |
|---|---|
| CLAUDE.md, imports, rules, AGENTS.md | [claude-md-and-rules.md](../knowledge/claude-code/claude-md-and-rules.md) |
| Skills and subagents | [skills-and-agents.md](../knowledge/claude-code/skills-and-agents.md) |
| Permissions, settings, trust | [permissions-and-settings.md](../knowledge/claude-code/permissions-and-settings.md) |
| Hooks on Windows | [hooks-on-windows.md](../knowledge/claude-code/hooks-on-windows.md) |
| MCP servers | [mcp-servers.md](../knowledge/claude-code/mcp-servers.md) |
| CLI flags and commands | [cli-cheatsheet.md](../knowledge/claude-code/cli-cheatsheet.md) |
| Windows install and setup | [windows-setup.md](../knowledge/claude-code/windows-setup.md) |

Official docs: https://code.claude.com/docs

## Pipelines in this workspace

- [00 · Daily workflow](00-daily-workflow.md): the workspace loop, from inbox to handoff
- [01 · Onboard an existing project](01-onboard-existing-project.md)
- [02 · Next.js](02-nextjs.md)
- [03 · Game dev](03-game-dev.md)
- [04 · Claude Code in the terminal](04-claude-cli.md): commands, keys, scripting and parallel sessions
