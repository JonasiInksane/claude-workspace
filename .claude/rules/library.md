---
paths:
  - "library/**"
---

# Library: global skills and agents

`library/` is the source for skills and agents that get installed to `~/.claude` (all
projects). Claude Code does not read `library/` itself; edit here, then install.

## Skills: `library/skills/<name>/SKILL.md`
- Frontmatter starts on line 1 (`---`) and has `name` and `description`.
- `name` equals the folder name, in kebab-case.
- Never use a built-in command name. A same-named skill can replace the built-in. Avoid: plan,
  resume, recap, run, review, init, memory, doctor, compact, clear, context, config, status,
  hooks, mcp, agents, skills, verify, goal, loop, schedule, batch, fork, help, model, cost,
  usage, rewind, export, add-dir, login, logout, permissions, statusline, tasks, todos, btw,
  diff, effort, plugin, reload-skills, code-review, security-review, simplify, handoff, rename,
  branch, background, stats, theme, terminal-setup, fewer-permission-prompts, settings, new,
  continue, reset, undo, checkpoint, bashes. `node tools/check-workspace.mjs` enforces this list.
- `description`: what the skill does first, then "Use when ..." with trigger phrases. The
  listing cuts description plus `when_to_use` at 1,536 characters, so put triggers early.
  Keep it on one line and avoid ": " inside it (it breaks YAML).
- Skills that take input get `argument-hint` (quoted, e.g. `argument-hint: "[feature description]"`)
  and use `$ARGUMENTS` (or `$0`, `$1`) in the body, plus a fallback for when it is empty.
- `disable-model-invocation: true` for skills only the user should start (they leave the context listing).
- `allowed-tools` only pre-approves tools; it does not restrict anything. Use
  `disallowed-tools` or permission deny rules to restrict.
- Keep SKILL.md short: aim for under ~150 lines (the docs say to stay under 500). Move detail
  to files next to it (for example `reference.md`), linked by relative path.
- Body style: H1, one-line purpose, numbered steps, an exact output template, a
  "What not to do" list, and at most 3 next steps.
- No absolute user paths. Use relative paths or `${CLAUDE_SKILL_DIR}` for files shipped with the skill.

## Agents: `library/agents/<name>.md`
- Frontmatter with `name` and `description` (both required). Optional: `tools` (comma list),
  `model` (sonnet, opus, haiku, inherit), `color`, `maxTurns`.
- `tools` is a real restriction; "read only" in the body is only an instruction. On Windows,
  add `PowerShell` to `tools` if the agent needs a shell.
- The body is the system prompt: role, steps, exact return format, and a length limit.

## After changing anything in library/
1. `node tools/install-library.mjs --dry-run` to preview, then `node tools/install-library.mjs`.
   It copies to `~/.claude/skills` and `~/.claude/agents` and never deletes anything there. A same-named file with other content is backed up to
   `~/.claude/library-backups/<timestamp>/` before it is replaced.
2. Skills and agents reload automatically in running sessions; if one doesn't show up,
   restart Claude Code.
3. `node tools/check-workspace.mjs` validates frontmatter, names and links.
