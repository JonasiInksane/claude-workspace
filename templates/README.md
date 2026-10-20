# Templates

Starter Claude Code files for new or cloned projects. Each folder is copied as-is into
`projects/<name>/`.

| Template | For | Details |
|---|---|---|
| `nextjs/` | Next.js apps | [nextjs/README.md](nextjs/README.md) |
| `game/` | Games: web (Phaser, Three.js, ...), Godot or Unity | [game/README.md](game/README.md) |
| `agent/` | One project agent (not a project type; used by `tools/new-agent.mjs`) | [agent/README.md](agent/README.md) |

## How they are used

```powershell
node tools/new-project.mjs my-app --type nextjs                     # new folder + git init
node tools/new-project.mjs my-game --type game --from https://github.com/you/my-game.git
```

Or in a hub session: `/new-project my-app nextjs [git-url]`.

- Every file in `templates/<type>/` is copied into the project, keeping its folder structure.
- An existing file is **never overwritten**; the output lists each file as `added` or
  `kept (exists)`. Safe to run on a cloned repo.
- `templates/<type>/README.md` is not copied (it describes the template).
- `{{PROJECT_NAME}}` in text files is replaced with the project name.

Then start Claude in the project and let it fill in the blanks:

```powershell
cd projects\my-app
claude
```

In that session, run `/onboard-project`. It maps the code, verifies the commands, and fills
in `CLAUDE.md` and `.claude/settings.json` (it waits for your approval before writing).
It is a global library skill: install it once with `node tools/install-library.mjs` from
the workspace root.

## What every template has

| File | Purpose |
|---|---|
| `CLAUDE.md` | Fill-in instructions, loaded at the start of every session in the project. HTML comments in it are stripped before Claude reads it, so they cost nothing. |
| `.claude/settings.json` | Strict JSON. Allow rules as Bash **and** PowerShell twins (on Windows Claude Code can run commands through either); deny rules for `.env` files. |
| `.claude/rules/*.md` | Rules with `paths:` frontmatter. They load only when Claude reads or edits a matching file, which keeps `CLAUDE.md` short. |
| `.mcp.json` | Project MCP servers (Playwright for Next.js, none for games). Each server asks for approval the first time. |

## Copying by hand

To use a template in a repo outside `projects/`, copy the files you want and replace
`{{PROJECT_NAME}}` in `CLAUDE.md` yourself. Don't overwrite a `CLAUDE.md` the repo already
has; merge by hand or let `/onboard-project` propose the edits. If the repo has an
`AGENTS.md`, start `CLAUDE.md` with the line `@AGENTS.md`: once a `CLAUDE.md` exists,
Claude Code stops reading `AGENTS.md` on its own.

## Changing a template

Edit the files here. Projects that were already created keep their own copies. Check the
JSON afterwards with `node tools/check-workspace.mjs`.

While you edit a template in a hub session, its `CLAUDE.md` loads too (Claude Code loads a
subfolder's `CLAUDE.md` once it reads or edits a file there). The placeholders are harmless;
they only become real instructions inside a project.
