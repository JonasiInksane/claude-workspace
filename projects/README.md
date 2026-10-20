# Projects

Your actual repos, one folder per project. Each project is its own git repo with its own
`CLAUDE.md` and `.claude/` settings. The workspace's `.gitignore` ignores everything in this
folder except this README, so project code never ends up in the workspace's history.

## Add a project

In a Claude session started in the workspace root:

```text
/new-project my-app nextjs
/new-project my-game game
/new-project my-app nextjs https://github.com/<you>/my-app.git
```

Or run the tool yourself in PowerShell:

```powershell
node tools/new-project.mjs my-app --type nextjs
node tools/new-project.mjs my-game --type game
node tools/new-project.mjs my-app --type nextjs --from https://github.com/<you>/my-app.git
```

- Names are kebab-case (`my-app`, not `My App`).
- Without `--from` it creates `projects/<name>/` and runs `git init`. With `--from` it
  clones the repo (HTTPS URLs work).
- It copies `templates/nextjs/` or `templates/game/` into the project but never overwrites
  a file that already exists. It prints each file as "added" or "kept (exists)".
- It does not run `npm install` or anything else over the network except `git clone`.

## Work on a project

Start Claude inside the project folder, not in the workspace root:

```powershell
cd projects/my-app
claude
```

Or double-click `Start Workspace.cmd` and pick the project from the menu.

The first time, run `/onboard-project`. It maps the code, checks the run, build and test
commands, and writes or improves the project's `CLAUDE.md`. Then use `/nextjs-feature` or
`/game-feature` for day-to-day work.

Why start inside the project? Claude reads `.claude/settings.json` (permissions, hooks) from
the folder you start in, so the project's own settings only apply when you start there.
The workspace `CLAUDE.md` still loads too, because it sits in a parent folder, and the
project's own `CLAUDE.md` is read after it.

The workspace `CLAUDE.md` imports your `context/` files, which are outside the project
folder. The first time, Claude Code may ask you to approve those imports. Approve them if
you want your preferences and goals available in project sessions.

## Detected types

The navigator, the SessionStart status and `start.ps1` label each project:

| Type | Detected by |
|---|---|
| `nextjs` | `next.config.*`, or `next` in package.json dependencies |
| `godot` | `project.godot` |
| `unity` | `ProjectSettings/ProjectVersion.txt` |
| `web-game` | package.json mentions phaser, three, pixi.js, kaplay or excalibur |
| `other` | anything else |

## Reports about a project

From the workspace root, `/project-report <project> [type]` writes a dated report in
`reports/` without changing the project. See [reports/README.md](../reports/README.md).
