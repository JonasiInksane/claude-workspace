# 00 · Daily workflow

The operating loop for this workspace: how a normal day goes, and where each thing you
produce ends up. Pipelines 01-03 cover the project work in the middle.

```
 START -------> CAPTURE -------> WORK --------> DELIVER -------> LEARN ---------> END OF DAY
   |               |               |               |               |                 |
 Start         drop files in    pipelines      /project-report /capture-lesson  /write-handoff
 Workspace.cmd inbox/, then     01-03          -> reports/     -> knowledge/    /day-recap
 (start.ps1)   /inbox-triage                                   /context-sweep
                                                               (weekly)
 [hub]         [hub]            [project]      [hub]           [hub]            [project + hub]
```

## Two kinds of sessions

| Session | Start it in | Use it for |
|---|---|---|
| **Hub** | the workspace root | inbox, reports, knowledge, handoffs, recaps, creating projects |
| **Project** | `projects\<name>` | code: features, fixes, tests, playtests (pipelines 01-03) |

- Hub skills (`/inbox-triage`, `/project-report`, `/capture-lesson`, `/new-project`,
  `/write-handoff`, `/day-recap`, `/context-sweep`) live in the hub's `.claude/skills/`.
  Run them in a hub session.
- Library skills (`/onboard-project`, `/nextjs-feature`, `/game-feature`) and the agents
  work everywhere once installed with `node tools/install-library.mjs`.
- A project session uses the project's own `.claude/settings.json` (the hub's hooks don't run
  there). It also loads the hub's `CLAUDE.md` (and your `context/` files), because CLAUDE.md
  files in parent folders load at launch. The project's `CLAUDE.md` is read last, and the hub
  `CLAUDE.md` tells Claude to treat it as the authority there. The `context/` imports sit
  outside the project folder, so the first project session may ask you to approve them.

## 1. Start

- Double-click **`Start Workspace.cmd`** (it runs `start.ps1`). The menu offers `[W]` the hub,
  a number for each project, `[C]` continue the last conversation there (`claude -c`), `[O]`
  the navigator, and `[A]` the workspace app (also `Workspace App.cmd` or the Claude Workspace
  shortcut: projects, agents and images in one window). By hand: `claude` in the workspace
  root, or `cd projects\<name>; claude`.
- First time in a folder, Claude Code asks whether you trust it. Accept only for folders you
  know. Allow rules from a committed `.claude/settings.json` apply only after you trust it.
- In the hub, a SessionStart hook gives Claude a status block: date, inbox items, active reports
  and projects. It isn't shown in the chat. `[W]` in the launcher prints it for you before
  Claude starts, or ask Claude "What needs attention today?", or run
  `node tools/hooks/session-start.mjs` yourself.
- Continuing yesterday's work?
  - `claude -c` resumes the last conversation in this folder, `claude -r` opens a picker.
  - Or start fresh: "Read the newest handoff for <project> in `inbox/handoffs/` and continue
    from its next steps." (The file name and its `Where:` line name the project.)
    From a project session the folder is `..\..\inbox\handoffs\` (reading outside the project
    may need your approval).
- `[O]` in the menu rebuilds and opens the dashboard (`index.html`): inbox, reports, projects,
  recent knowledge.

## 2. Capture

- Drop anything into `inbox/`: a `.md` with links or ideas, PDFs, design notes, playtest notes.
  Screenshots go in `inbox/attachments/_hub/YYYY-MM-DD/`; reference images for one project agent
  go straight into `inbox/attachments/<project>/<agent>/YYYY-MM-DD/` (not triaged).
- In the hub, run `/inbox-triage`. Claude proposes a filing plan as a table and **waits**.
  After your OK it files each item (knowledge, a project, or a report) and moves the original
  to `inbox/_processed/YYYY-MM-DD/`. Nothing is deleted.
- Aim for inbox zero once a day, not after every drop.

## 3. Work

- New project: in the hub, `/new-project my-app nextjs https://github.com/you/my-app.git`
  Use `game` for a game; leave out the URL to start an empty repo (it has no app code yet: see
  [02 · New app from scratch](02-nextjs.md)). Then `cd projects\my-app; claude`.
- Then follow the pipeline:
  - [01 · Onboard an existing project](01-onboard-existing-project.md): first session in any repo.
  - [02 · Next.js](02-nextjs.md): `/nextjs-feature <what you want>`.
  - [03 · Game dev](03-game-dev.md): `/game-feature <mechanic>`.
- One task per conversation. `/clear` between tasks. Commit whenever something works.
- Before a task, check [knowledge/INDEX.md](../knowledge/INDEX.md): you may have solved it before.

## 4. Deliver

- In the hub: `/project-report my-app status` (types: status, onboarding, audit, research,
  playtest, plan, other). It reads the project without changing it, writes
  `reports/YYYY-MM-DD_my-app-status/report.md` and registers it in `reports/reports.json`.
- Revise: add `report-v2.md` to the same folder, then
  `node tools/register-report.mjs --folder reports/<id>`. Never start a second report for the same work.
- Finished: `node tools/register-report.mjs --folder reports/<id> --status done`.
- Details: [reports/README.md](../reports/README.md).

## 5. Learn

- When something surprised you (a gotcha, a command that works, a fix that took an hour):
  `/capture-lesson <the lesson in one or two sentences>`. It updates an existing note
  instead of making a duplicate, and keeps `knowledge/INDEX.md` in sync.
- Made a real decision (engine, library, structure)? `/capture-lesson` handles that too: it
  writes `knowledge/decisions/YYYY-MM-DD-topic.md` (Context, Options, Decision, Consequences)
  and adds it to the index.
- When Claude repeats a mistake in a project, add a line to that project's `CLAUDE.md`
  or one of its `.claude/rules/` files.
- **Weekly:** `/context-sweep`. It only reports (oversized or stale files, notes missing
  from the index, duplicates) and changes nothing without your yes.

## 6. End of day

- Write the handoff **in the session where the work happened**. A handoff records the
  conversation it is written in, so a hub handoff can't describe project work.
  - In a project session: commit or note your work in progress, then ask:
    "Write a handoff for this session to `..\..\inbox\handoffs\YYYY-MM-DD-<project>-<slug>.md`
    using the structure in `..\..\.claude\skills\write-handoff\SKILL.md`." Approve the write
    outside the project folder when asked. Also `/rename <name>` so `claude -r <name>` finds
    the session tomorrow.
  - In the hub, for hub work only: `/write-handoff [topic]`. It saves
    `inbox/handoffs/YYYY-MM-DD-<slug>.md` with the goal, state, decisions, open problems and
    exact next steps, and changes nothing else.
- In the hub: `/day-recap` summarizes the day in chat (reports, processed inbox, updated notes).

## Where things belong

| It is... | Put it in | How |
|---|---|---|
| Raw material: links, screenshots, PDFs, notes | `inbox/` (images in `inbox/attachments/_hub/YYYY-MM-DD/`) | `/inbox-triage` later |
| Reference images for one project agent | `inbox/attachments/<project>/<agent>/YYYY-MM-DD/` | The workspace app's Images view; not triaged |
| Who you are, preferences, goals, stack | `context/*.md` (always loaded, under 40 lines each) | Edit by hand |
| A lesson, gotcha or how-to | `knowledge/<area>/<name>.md` + `knowledge/INDEX.md` | `/capture-lesson` |
| A decision and why | `knowledge/decisions/YYYY-MM-DD-topic.md` | `/capture-lesson` |
| A deliverable (status, audit, plan, playtest) | `reports/YYYY-MM-DD_slug/` + `reports/reports.json` | `/project-report` or `register-report.mjs` |
| Where you stopped | `inbox/handoffs/` | `/write-handoff` |
| Code, plus its `CLAUDE.md` and `.claude/` | `projects/<name>/` | `/new-project` |
| Rules for one part of a codebase | `<project>/.claude/rules/*.md` with `paths:` | Edit by hand |
| Your personal, uncommitted project rules | `<project>/.claude/settings.local.json`, `<project>/CLAUDE.local.md` | Add both to `.gitignore` |
| A skill or agent for every project | `library/` | `node tools/install-library.mjs` |
| A skill for the hub only | `.claude/skills/<name>/SKILL.md` | Edit by hand |
| A repeatable way of working | `pipelines/` | See [README](README.md) |

## Cheat sheet

```text
Morning   Start Workspace.cmd -> [W] hub (status printed) -> "What needs attention?" -> /inbox-triage
Work      Start Workspace.cmd -> project number -> /nextjs-feature ... or /game-feature ...
Deliver   hub: /project-report <project> <type>
Learn     hub: /capture-lesson <lesson>     (weekly: /context-sweep)
Evening   project: handoff (step 6) + /rename; hub: /day-recap (/write-handoff for hub work)
```
