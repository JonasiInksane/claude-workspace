# Knowledge index

`knowledge/` is this workspace's long-term memory: one topic per note, read on demand, never
auto-loaded. Lessons, gotchas, how-tos and decisions live here; preferences live in `context/`.

**How to search**

- Scan the table below (tags and summaries), then open only the notes you need.
- Or search from the workspace root. Claude uses its Grep tool; in Git Bash:

```bash
grep -ri "mcp" knowledge/
```

In PowerShell:

```powershell
Get-ChildItem knowledge -Recurse -Filter *.md | Select-String -Pattern "mcp"
```

**How to add a note:** run `/capture-lesson <lesson>`, or follow `.claude/rules/knowledge.md`
(frontmatter, H1 = title, TL;DR, one row in this table). Decisions go in
`decisions/YYYY-MM-DD-topic.md`. `node tools/check-workspace.mjs` fails if a note is missing here.

| Note | Tags | Updated | Summary |
|---|---|---|---|
| [CLAUDE.md, imports and rules](claude-code/claude-md-and-rules.md) | claude-code, claude-md, memory, rules, agents-md | 2026-10-20 | Load order, @imports and the backtick rule, CLAUDE.local.md, `.claude/rules` with `paths:`, size limits, AGENTS.md, `/context` |
| [Skills and subagents](claude-code/skills-and-agents.md) | claude-code, skills, subagents, frontmatter | 2026-10-21 | Skill locations and frontmatter, `$ARGUMENTS`, allowed-tools vs disallowed-tools, built-in names to avoid, agent fields, `@agent-<name>` |
| [Agent memory and isolated agent sessions](claude-code/agent-memory.md) | claude-code, subagents, memory, agent, permissions, windows | 2026-10-21 | `memory: project` folders, why `--agent` also loads shared project memory, isolated launch with `--settings` (`autoMemoryDirectory`, `additionalDirectories`), trust gate |
| [Permissions and settings](claude-code/permissions-and-settings.md) | claude-code, settings, permissions, security, windows | 2026-10-20 | Settings precedence, strict JSON, deny/ask/allow, Bash + PowerShell twins, Read deny rules, workspace trust, autoMemoryEnabled |
| [Hooks on Windows](claude-code/hooks-on-windows.md) | claude-code, hooks, windows, node, automation | 2026-10-20 | Hook JSON, events, matchers, exit codes, exec vs shell form, `${CLAUDE_PROJECT_DIR}`, why node exec-form, debugging with `/hooks` |
| [MCP servers](claude-code/mcp-servers.md) | claude-code, mcp, playwright, windows, secrets | 2026-10-20 | `.mcp.json` schema, scopes, approval, env expansion, `claude mcp add`, npx on Windows, Playwright and http examples |
| [Claude Code CLI cheatsheet](claude-code/cli-cheatsheet.md) | claude-code, cli, shortcuts, slash-commands | 2026-10-20 | Verified flags, keys and slash commands for 2.1.304 |
| [Claude Code on Windows](claude-code/windows-setup.md) | claude-code, windows, install, powershell, setup | 2026-10-20 | Install and update, PATH fix, optional Git Bash, PowerShell 5.1 UTF-8 piping, Alt+V, Shift+Enter, `claude doctor` |
| [Next.js project checklist for CLAUDE.md](nextjs/project-checklist.md) | nextjs, claude-md, checklist, env-vars | 2026-10-20 | What to pin in a Next.js CLAUDE.md (router, version, package manager, server/client, NEXT_PUBLIC_, commands) and common mistakes |
| [Engine CLI commands for headless runs and tests](gamedev/engine-cli-commands.md) | gamedev, godot, unity, vite, vitest, testing, cli | 2026-10-20 | Godot `--headless` and GUT, Unity `-batchmode -runTests` (no `-quit`), Vite and Vitest, each marked verified or unverified |
| [Game architecture that Claude can work with](gamedev/architecture-for-claude.md) | gamedev, architecture, testing, godot, unity, git-lfs | 2026-10-20 | Pure logic vs presentation, data-driven tunables, seeded RNG and fixed timestep, debug hooks, Git LFS, which engine files Claude may edit |
| [Launching programs from Node on Windows](windows/node-launching-programs.md) | windows, node, child-process, powershell, windows-terminal, edge | 2026-10-21 | wt.exe app alias vs existsSync, windowsHide hides GUI windows, detached PowerShell has no console, typographic quotes in PowerShell, explorer commas, EACCES on reserved ports |
| [Workspace structure v2](decisions/2026-10-20-workspace-structure.md) | decision, workspace, structure, memory | 2026-10-20 | Why context/knowledge/inbox/reports, Claude-only, Node tools, auto memory off, hub vs project sessions, library vs hub skills |
| [Project agents with their own memory and images](decisions/2026-10-21-project-agents.md) | decision, agents, memory, inbox, workspace | 2026-10-21 | Per-project specialist agents with `memory: project`, per-agent inbox image folders, isolated sessions via `tools/agent-session.mjs` |
| [Flows: saved prompts with reference images](decisions/2026-10-21-flows.md) | decision, flows, workspace-app, prompts, images, inbox | 2026-10-21 | `flows/<flow>.md` in git, images in `inbox/attachments/_flows/`, run in hub/project/agent via a prompt file and `--settings` read access |
