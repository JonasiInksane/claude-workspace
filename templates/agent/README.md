# Agent template

Starter files for a project agent: a specialist (for example `asset-builder`) that lives in one
project and keeps its own memory. Used by `node tools/new-agent.mjs`; not a project type, so
`new-project` never copies this folder.

| File | Becomes |
|---|---|
| `agent.md` | `projects/<project>/.claude/agents/<agent>.md` |
| `MEMORY.md` | `projects/<project>/.claude/agent-memory/<agent>/MEMORY.md` |

Placeholders: `{{PROJECT_NAME}}`, `{{AGENT_NAME}}`, `{{AGENT_DESCRIPTION}}`, `{{AGENT_ROLE}}`.
`<...>` lines are for the user to fill in. When `--tools` is given, new-agent adds a `tools:`
line to the frontmatter.

Why `memory: project` and how sessions stay isolated:
[agent memory note](../../knowledge/claude-code/agent-memory.md).
