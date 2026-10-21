# Claude Code Workspace

Your home base for working with Claude Code on Windows. It keeps what Claude should always
know about you (`context/`), what you have learned (`knowledge/`), things to process
(`inbox/`), finished work (`reports/`), step-by-step workflows (`pipelines/`), reusable
skills and agents (`library/`), project templates (`templates/`) and your repos (`projects/`).

Everything is plain Markdown and JSON. Double-click `index.html` to browse it all in a
navigator with a dashboard (setup builds it; see "The navigator" below). For day-to-day
control there is also a small **workspace app** (`Workspace App.cmd`): run saved flows, start
every skill and tool with a button, start Claude in projects, manage project agents, and drop
or paste images (see "The workspace app" below).

## Folder map

```
claude-workspace/
├── CLAUDE.md             instructions Claude reads in every session started here (a short router)
├── README.md             you are here
├── Setup.ps1, setup.sh   first-time setup (Windows / Git Bash, macOS, Linux)
├── Start Workspace.cmd   double-click launcher: opens the start.ps1 menu
├── start.ps1             menu: start Claude in the hub or a project, continue a chat, open the navigator or the app
├── Workspace App.cmd     double-click: opens the workspace app (tools/workspace-app/) in its own window
├── index.html            generated navigator (gitignored)
├── .mcp.json             MCP servers for the hub (empty on purpose)
├── .env.example          names of environment variables, never values
├── .claude/              hub settings (permissions, hooks), path-scoped rules, hub skills
├── context/              always loaded: identity, preferences, goals, stack (small files)
├── knowledge/            lessons and how-tos, one topic per file, read on demand (INDEX.md)
├── inbox/                drop zone; /inbox-triage files items and archives the originals
├── reports/              dated deliverables plus the reports.json registry
├── pipelines/            how to work: the daily loop and per-type workflows
├── library/              global skills and agents, installed to ~/.claude
├── templates/            starter files for new Next.js and game projects
├── flows/                saved prompts for the workspace app's Flows view (images live in the inbox)
├── projects/             your repos, each with its own git history (gitignored here)
└── tools/                Node scripts: navigator, installer, checks, reports, new projects and agents,
                          and the workspace app (tools/workspace-app/)
```

## First-time setup

Run `Setup.ps1` once, in PowerShell, from this folder:

```powershell
# Check (the default): reports Node, git, Git Bash, claude, PATH and the library. Changes nothing.
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1

# Install: installs the library into ~/.claude, builds index.html, runs the self-check,
# and offers to "git init" the workspace. Add -FixPath if claude is not on your PATH.
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1 -Mode Install
```

`-ExecutionPolicy Bypass` applies only to that one PowerShell process. Your system's
execution policy is not changed.

Then:

1. Fill in `context/identity.md` and `context/goals.md`, and the TODO lines in
   `context/stack.md`. Claude reads these in every session here; it asks rather than guesses.
2. Start Claude in this folder: double-click **`Start Workspace.cmd`** and choose `[W]`,
   or type `claude` here. The first time, it asks whether you trust the folder. Say yes:
   the workspace's allow rules only apply in a trusted folder.
3. Check that everything is in order:

```powershell
node tools/check-workspace.mjs
```

## Daily use

Start each day with **`Start Workspace.cmd`**: `[W]` opens Claude in the hub, a number opens
it in a project, `[O]` opens the navigator, `[A]` opens the workspace app. Or double-click the
**Claude Workspace** shortcut (or `Workspace App.cmd`) to go straight to the app.

The loop:

```
drop it in inbox/  ->  /inbox-triage  ->  work in a project  ->  /project-report  ->  /capture-lesson
```

1. **Collect.** Drop links, screenshots, PDFs and notes into `inbox/`
   (screenshots go in `inbox/attachments/_hub/YYYY-MM-DD/`; images for one project agent go in
   `inbox/attachments/<project>/<agent>/YYYY-MM-DD/`, see [inbox/README.md](inbox/README.md)).
2. **Triage.** In the hub, run `/inbox-triage`. Claude proposes where each item goes and
   waits for your OK, then files it and moves the original to `inbox/_processed/`.
3. **Work.** Start Claude inside the project (`cd projects/my-app; claude`, or pick it in the
   `start.ps1` menu). Use `/nextjs-feature` or `/game-feature`.
4. **Report.** Back in the hub, `/project-report my-app status` writes a dated report and
   registers it.
5. **Learn.** `/capture-lesson <what you learned>` saves it in `knowledge/`, so next time
   Claude finds it before starting.

The full walkthrough is in [pipelines/00-daily-workflow.md](pipelines/00-daily-workflow.md).
The building blocks and per-type workflows are in [pipelines/README.md](pipelines/README.md).

## Where things belong

| It is... | It goes in | How |
|---|---|---|
| A preference ("always do X") | `context/preferences.md` | Edit it (keep it under 40 lines) |
| A goal or current focus | `context/goals.md` | Edit it |
| A lesson, gotcha or how-to | `knowledge/<area>/<name>.md` | `/capture-lesson` |
| A decision and its reasons | `knowledge/decisions/YYYY-MM-DD-topic.md` | Context, Options, Decision, Consequences |
| A repeatable procedure | a library skill (`library/skills/`) or a pipeline (`pipelines/`) | After a library change, `node tools/install-library.mjs` |
| A deliverable | `reports/YYYY-MM-DD_slug/` | `/project-report` or `node tools/register-report.mjs` |
| Raw material | `inbox/` | `/inbox-triage` |
| Code | `projects/<name>/` | `/new-project` |

## Skills and agents

Hub skills work when Claude is started in this folder:

| Skill | What it does |
|---|---|
| `/inbox-triage` | Proposes a filing plan for inbox items, waits for approval, files them, archives the originals |
| `/capture-lesson <lesson>` | Writes or updates a knowledge note and its row in `knowledge/INDEX.md` |
| `/project-report <project> [type]` | Investigates a project read-only, writes and registers a report |
| `/new-project <name> <nextjs\|game> [git-url]` | Creates or clones a project from a template |
| `/write-handoff` | Saves a handoff note to `inbox/handoffs/` so a fresh session can continue |
| `/day-recap [date]` | Summarizes what happened on a day (reports, commits, triaged items, notes) |
| `/context-sweep` | Reports oversized, stale or unindexed context and knowledge files; changes nothing without a yes |

Library skills and agents work in every project once installed with
`node tools/install-library.mjs`:

| Name | What it does |
|---|---|
| `/onboard-project` | Maps an existing repo, verifies its commands, writes its `CLAUDE.md` |
| `/nextjs-feature` | Builds a Next.js feature: explore, plan, implement, verify |
| `/game-feature` | Builds a game mechanic with testable logic separate from presentation |
| `code-explorer` agent | Read-only investigation of a codebase |
| `code-reviewer` agent | Reviews the current diff before you commit |
| `playtester` agent | Turns playtest notes into concrete tuning proposals |

Edit skills and agents in `library/`, never in `~/.claude`, then re-run the installer.

## The navigator

```powershell
node tools/build-index.mjs
```

This writes `index.html`, a single page you open by double-clicking (no server needed).
The home view is a dashboard: inbox items, active and recent reports, projects with their
type and a "copy start command" button, recently updated knowledge, and all skills.
The sidebar shows every file in the workspace.

You rarely need to run it yourself: a hook rebuilds `index.html` whenever Claude edits a file
outside `projects/` and `inbox/`. Run it after you add or move files by hand.

## The workspace app

Double-click **`Workspace App.cmd`** (or the **Claude Workspace** desktop shortcut). The app
opens in its own window. It has five views:

- **Dashboard:** what is waiting in the inbox, agent images, flows, active reports and projects.
- **Flows:** saved prompts with reference images. **+ New flow**, then write the prompt, pick
  where it runs (the hub, a project or one agent), optionally how the session starts (plan
  mode, model, effort, pre-approved tools), and drop images on it (they become Image 1,
  Image 2 ..., each with an optional caption). **Run…** shows the exact prompt, takes notes for
  that run and starts Claude. Format: [flows/README.md](flows/README.md).
- **Tools:** a button for every hub and project skill (Claude opens in a new terminal and runs
  it), **New project**, and Check workspace, Run tests, Rebuild navigator and Install library
  (these run in the app and show their output).
- **Projects:** one card per project with **Start Claude**, **Continue**, **Folder**, your
  editor and, without a CLAUDE.md, **Onboard**. Each project lists its **agents**:
  - **Start** opens a terminal tab where that agent sees only its own memory and images.
  - **Edit** changes its file (description, model, instructions); **Archive…** in there takes
    it out of use and **Restore** brings it back, with its memory and images.
  - **Memory** shows what it has learned.
  - **+ New agent** creates one.
- **Images:** choose where images go (the hub, a project's shared folder, or one agent). Then
  drag and drop, paste a screenshot with **Ctrl+V**, or choose files. Images are saved in a
  dated folder and never overwritten. **Copy path** gives you the full path to paste into Claude.

The app runs in the background and stops by itself a few minutes after you close its window.
It only listens on this PC (`127.0.0.1`), and only a browser with its sign-in link (new for
every run; the app opens it for you) can use it. Details
and the safety rules are in [tools/workspace-app/README.md](tools/workspace-app/README.md).

```powershell
node tools/workspace-app/make-shortcut.mjs                # desktop shortcut "Claude Workspace"
node tools/workspace-app/make-shortcut.mjs --start-menu   # also in the Start menu (pin it from there)
node tools/workspace-app/make-shortcut.mjs --remove       # remove the shortcut(s) that start this workspace's app
```

## Tools

| Command | What it does |
|---|---|
| `node tools/build-index.mjs` | Rebuilds the navigator (`index.html`) |
| `node tools/check-workspace.mjs` | Self-check: JSON, skills, agents, knowledge index, reports, links, imports, hooks, `.env.example`, absolute paths |
| `node tools/install-library.mjs [--dry-run]` | Copies `library/` skills and agents to `~/.claude` (backs up a same-named file before replacing it; never deletes) |
| `node tools/register-report.mjs --folder reports/<id> ...` | Adds or updates a report in `reports/reports.json` |
| `node tools/new-project.mjs <name> --type nextjs\|game [--from <url>]` | Creates or clones a project |
| `node tools/new-agent.mjs <project> <agent> [--role "..."] [--description "..."] [--tools "..."]` | Adds a project agent with its own memory folder and inbox image folder |
| `node tools/agent-session.mjs <project> <agent> [--print] [--prompt-file <file>]` | Starts Claude as that agent, seeing only its own memory and images (the prompt file is how the workspace app's flows start it) |
| `node tools/workspace-app/server.mjs [--no-open]` | Runs the workspace app (what `Workspace App.cmd` starts, hidden) |
| `node tools/workspace-app/make-shortcut.mjs [--start-menu] [--remove]` | Creates or removes the "Claude Workspace" shortcut |
| `node tools/run-tests.mjs [filter]` | Runs the tool tests (any Node version; `filter` picks files by path, e.g. `workspace-app`) |

## Good to know

- **Memory.** Auto memory is turned off for sessions started in this folder
  (`"autoMemoryEnabled": false` in `.claude/settings.json`). `knowledge/` is the memory
  instead: you can read it, edit it, grep it and version it. Project sessions use the
  project's own settings, so auto memory (on by default) is on there unless a setting turns it off.
  Project agents each keep their own memory in `projects/<name>/.claude/agent-memory/<agent>/`
  ([agent memory note](knowledge/claude-code/agent-memory.md)).
- **What Claude loaded.** In a session, `/context` shows which memory files loaded,
  `/hooks` lists the hooks, and `/status` shows which settings files are in use.
- **Secrets.** Never commit tokens. `.env` files are gitignored, Claude is denied reading
  `.env`, `.env.local`, `.env.*.local`, `.env.production`, `.env.development` and `.env.test`
  in any folder (including projects read from the hub), and `.env.example` lists names only.
- **Git.** You can make this folder a git repo. `.gitignore` keeps `inbox/` contents,
  `projects/` and `index.html` out of it.
- **Other agents.** This workspace is Claude Code only. To add Codex or another tool later,
  create an `AGENTS.md` and put `@AGENTS.md` at the top of `CLAUDE.md`.
- **Claude Code changes fast.** Notes about its behaviour carry the version they were checked
  with. Docs: https://code.claude.com/docs

More: [knowledge/INDEX.md](knowledge/INDEX.md) ·
[inbox/README.md](inbox/README.md) ·
[reports/README.md](reports/README.md) ·
[projects/README.md](projects/README.md) ·
[templates/README.md](templates/README.md)
