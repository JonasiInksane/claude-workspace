# Workspace app

A small local app for this workspace, opened in its own Edge window: Today (what waits for
you, what runs, next up, health, inbox, active reports), a page for every project with the tabs
of its type (a code project: Overview, Tasks, Findings, Changes, Checks, Architecture; see
"Project pages" below), headless pipeline runs (launcher, live run, review gate and commit; see
"Runs" below) with an Ask panel next to runs, review gates and findings (see "Ask"), flows
(saved prompts with reference images, run in the hub, a project, any
project you pick, or one agent; every launch records the flow's version), the Library with a
button for every skill and workspace tool, the pipelines and the
settings, project cards that start Claude, per-project agents (create, edit, archive and restore, start
isolated, view memory), image upload (Inbox images, opened from Assets: drag and drop, Ctrl+V,
or choose files) into the hub inbox, a chosen agent's image folder or a flow, and an Assets view for projects with an asset
pipeline: 3D models (`projects/game-dev`: renders, check results, a 3D view and your verdict)
and sprites (`projects/game-dev`, `tools/sprite.mjs`: an HD-2D preview, the pixels, check results and your verdict).

Start it with a double-click on `Workspace App.cmd` (workspace root) or the "Claude Workspace"
shortcut, or `[A]` in the `start.ps1` menu. All three run `start-app.ps1`, which starts the
server hidden, with its messages in `%TEMP%\claude-workspace\app.log`. By hand:

```powershell
node tools/workspace-app/server.mjs            # opens the window (this console shows the log)
node tools/workspace-app/server.mjs --no-open  # prints the sign-in link instead
node tools/workspace-app/make-shortcut.mjs [--start-menu] [--remove]
```

Close the window and the app stops by itself a few minutes later (sleep and hibernate don't
count; the page sends a heartbeat every 15 seconds). Starting it again while it
runs just opens another window.

## How it works

| File | Job |
|---|---|
| `server.mjs` | Startup: port 4317 (or a free one), sign-in token, one app per workspace, run recovery before it listens, idle shutdown (never while `isBusy()`), stopping the runs on every exit, opens the window; `--data-dir`, `--fake-claude` (tests only) |
| `app.mjs` | `createApp`: access checks, the page's static files, `/img`, `/asset-file` and `/library-file` (sandboxed), the dispatch to `routes/*.mjs` (`ROUTE_MODULES`), and `ctx.getEngine()` (the run engine, made on first use) |
| `runs/wiring.mjs` | Builds the run engine: the manager (`runs/manager.mjs`) with the real executor and modules, `claude.exe` from the launcher (or the fake in tests); `stopEngine` for exits |
| `routes/runs.mjs`, `routes/events.mjs` | Runs over HTTP: pipelines, start (with an Ask context, see "Ask") and preview, the runs list, one run with its timeline and buttons, review data, diffs, run files; `/api/events` (live update signals) |
| `runs/context.mjs` | The Ask context: checks the reference a question names against the app's records, records it in `run.json` with the parent, and builds `inputs/context.md` (capped, redacted) when the Explain stage starts |
| `runs/run-files.mjs` | The run file readers the runs routes and the Ask context share: capped reads, a run's JSON files, redacted text, the diff split into files |
| `http.mjs` | `HttpError`, `send`/`json`, body readers, cookie and token helpers, `PAGE_CSP`, and the startup scan of `ui/` (`listUiFiles`) |
| `state.mjs` | `buildState`: everything the page shows (`GET /api/state`), async; git runs as child processes, requests during a build share it. Each project carries its `type` and `tabs` |
| `project-types.mjs` | The project types, in order: `code` (has a private profile), `assets` (has an asset pipeline), `generic`; each lists its page's tabs. `projectTypeOf()` returns the first that matches |
| `lookup.mjs` | Finds the project, agent, flow, image target or asset project a request names (or throws 404/400); `launchableOrThrow` |
| `routes/*.mjs` | The JSON API by area: `state`, `images`, `agents`, `assets`, `launch` (start Claude, open places), `flows`, `tools` (skills, workspace tools), `projects` (new, clone, list repos), `project-settings` (a project's rules and settings, see "Project settings"), `library` (the asset library) |
| `project-settings.mjs` | A project's rules and settings as numbered, immutable versions in the data folder: save (stale saves 409, every problem listed), read with checks, `rulesBlock` for stage prompts, `launchWithSettings` for sessions |
| `catalog.mjs` | The Library's list: skills (with their form fields and how the prompt is built) and workspace tools |
| `uploads.mjs` | Image targets, type check by content, dated folders, no overwrites |
| `launch.mjs` | Builds the commands for terminals, Explorer, the editor and the window; applies a project's settings to every session started in it; runs workspace tools and collects their output |
| `claude-prompt.mjs` | Runs in the new terminal: starts `claude <prompt>` with the prompt, the project's rules (`--append-system-prompt`) and readable folders from a prompt file, `tools/lib/prompt-file.mjs` |
| `../lib/flows.mjs` | Flows: read, check, save, archive and restore `flows/<flow>.md` (`project: "*"`: any project, chosen on each run); build a run's prompt ([flows/README.md](../../flows/README.md)) |
| `flow-versions.mjs` | Which version of a flow a launch used (`flowVersion`: the file's SHA-256 with CRLF as LF, the hub commit and whether the file is committed there, the hash of each image and of the captions), the launch record `flow-runs.jsonl`, and what changed since a launch |
| `../lib/agents.mjs` | Agents, shared with the CLI tools; editing (`saveAgentText`, refuses renames and stale saves), archiving and restoring live here too |
| `start-app.ps1` | Starts the server hidden with `--log` (shows a dialog if Node is missing) |
| `make-shortcut.mjs` | Desktop / Start menu shortcut; never replaces or removes a "Claude Workspace" shortcut that starts something else (another workspace copy included) |
| `make-icon.mjs` | Draws `ui/icon.ico` (16 to 256 px) from the same design as `ui/icon.svg`; its PNG encoder is shared with `bmp.mjs` |
| `bmp.mjs` | BMP to PNG on upload (uncompressed 1, 4, 8, 24 and 32-bit; others are refused with a message) |
| `assets.mjs` | The Assets view: finds projects with `tools/asset.mjs` (3D) or `tools/sprite.mjs` (sprites) and `assets/`, reads each asset's `asset.json` (`"kind": "sprite"` for a sprite), check reports, renders and brief log, and a sprite's sheet (`export/SPR_<Name>.png`, `.json`, `_N` normal map, `_E` emissive); serves only PNG, JPEG, JSON and GLB files from inside `assets/` (sandboxed); writes a verdict (Approve, Revise, Reject) as the `asset.json` status plus a dated line in the brief's log |
| `asset-library.mjs` | The asset library (see "Asset library" below): shared and per-project assets with immutable, hashed versions; the content check per kind, refs, listing, uploads, meta, archive, the sandboxed file lookup for `/library-file`, and `resolveAttachments` for runs and flows. `routes/library.mjs` is its API |
| `ui/index.html` | The page shell: sidebar (the nav `#nav`, and `#navFoot` for Library above the Hub session buttons), `<main>`, the dialog, the palette (`#palette`) and commit dialog (`#commitDialog`), the live-updates pill and the "waiting" live region; links `app.css` then `css/<view>.css`; loads `main.js` as a module |
| `ui/main.js` | The views registry (`VIEWS`), the sidebar (`ui/parts/nav.js`: Today; Projects with every project under it, a code project with its amber waiting count; Assets; Flows; Runs with up to three review gates under it; Library at the foot, above the Hub session buttons), hash routing with sub-routes (`#project/<name>/<tab>`, `#run/<id>`; a project route the state completes is corrected in place; unknown goes to `#today`; Back works), live updates (one `EventSource('/api/events')`, polling while it is down), keyboard (`Ctrl K`, `g t`/`g p`/`g a`/`g f`/`g r`), notifications, the theme toggle, pasted and dropped images, heartbeat, refresh on focus |
| `ui/lib.js` | `h()` (data always as text; refuses a `style` prop), `api()`, `act()`, `toast()`, `copy()`, formatting helpers (`fmtAgo`, `fmtDuration`, `fmtClock`), `statusBadge`, focus helpers, `announce`, `confirmDialog`, the "not connected" overlay |
| `ui/store.js` | The shared state (`state`, `view`, `sub`, `currentProject`, `settings`, `pipelines`, run signals), `setState`, `subscribe`, `refresh`, `go()`, the hash helpers (`projectRoute`, `projectSub`, `goProject`, `canonicalProjectSub`; the old `#cockpit/<name>` and `#health/<name>` read as Overview and Architecture), `openLauncher` and the title badge |
| `ui/dialog.js` | `openDialog` (with an unsaved-changes guard), `closeDialog`, `formDialog` |
| `ui/parts/*.js` | Shared pieces: the nav, the palette (every project tab is a jump target), the intent box, sparkline, bar, status dot and badge, the Ask panel (`ask-panel.js`, see "Ask"); for the project page `patch.js` (repaint without losing the focus), `project-data.js` (each tab's data, kept fresh), `project-ui.js` (small builders) and `project-actions.js` (buttons several tabs offer) |
| `ui/views/*.js` | One file per view: `today`, `project` (a project's page, its tabs in `views/project/`; Findings has Ask on every card), `launcher`, `run` and `review` (both with Ask in their header), `runs`, `flows`, `tools` (Library), `projects`, `assets` (with the Inbox images button), `images` (Inbox images), with their dialogs (`home`, the old dashboard, is no longer a view; `#home` shows Today) |
| `ui/app.css`, `ui/css/*.css` | Tokens, layout and shared components; styles for one view in `css/<view>.css` (the project page: `project.css`, plus `project-cards.css` for the code tabs' cards and `architecture.css`; the Ask panel: `ask.css`) |
| `ui/viewer.js` | The 3D view: a small WebGL2 GLB viewer, no libraries (base colour, metal/roughness and normal maps; studio light and a fake sky; turntable, wireframe). No Draco or meshopt compression, skins or morphs |
| `ui/sprite-viewer.js` | The sprite views, no libraries: `loadSprite` (the sheet's Aseprite-style JSON, frames by `<anim>_<direction>` tag), an HD-2D diorama (WebGL2: the sprite as a billboard in a small pixel-art scene, sun shadows the sprite casts, a torch, normal-mapped light and glowing pixels, tilt-shift depth of field, bloom, vignette, day/night, a walk-around mode that faces the way it moves) and a pixel view (integer zoom, play/step). A missing direction plays its mirror (west from east), then the nearest one |
| `ui/sprite-dialog.js` | The Assets view's dialog for a sprite: both sprite views with the animation, direction and lighting controls, the palette, facts, verdict, checks and review images |
| `ui/` (other) | `icon.svg` (plus `icon.ico` for the shortcut); `package.json` only tells Node (the tests) that these `.js` files are ES modules. Plain JS, no build step |

The app does what the command-line tools do and nothing more. "Start" on an agent runs
`tools/agent-session.mjs` in a Windows Terminal tab, and "New agent" runs `tools/new-agent.mjs`.
In Tools, a skill starts Claude in the hub or a project with `/<skill> <form values>` as its
first prompt; "New project" runs `tools/new-project.mjs` in a terminal; Check workspace, Run
tests, Rebuild navigator and Install library run inside the app and show their output (Install
library always shows its `--dry-run` preview first). A flow's Run starts `claude-prompt.mjs`
(hub, project) or `agent-session.mjs --prompt-file` (agent) in a terminal, with the flow's
launch settings as `--permission-mode` / `--model` / `--effort` and its pre-approved tools in
the settings file (`tools/lib/prompt-file.mjs` checks them; `bypassPermissions` and `dontAsk`
are refused), plus the project's settings in a project (see "Project settings"). A flow for any
project starts in the project picked in its run dialog (the server checks it by name; a fixed
project refuses another one). Each launch that started adds a line with the flow's version to
`flow-runs.jsonl`; the flow editor lists the newest as Recent runs (`GET /api/flow-runs`).
Archiving an agent
moves its file to `.claude/agents-archived/`, outside the folder Claude Code loads agents
from; archiving a flow moves it to `flows/_archived/`. Memory and images always stay.
In Projects, the Repositories card reads `projects/repos.json` (`tools/lib/repos.mjs`): Clone
and "Clone a repo…" run `tools/projects.mjs clone` in a terminal (a plain `git clone`; only
listed names or a checked `https://` / `git@` URL, never into an existing folder), and "Add to
list" writes a project folder's origin remote into the file.
The inbox counts come from `tools/lib/inbox.mjs`. Image rules:
[inbox/README.md](../../inbox/README.md). Agents: [the decision](../../knowledge/decisions/2026-10-21-project-agents.md).

## Project pages

Every project in `projects/` has a page, `#project/<name>/<tab>`; its type
(`project-types.mjs`) decides the tabs:

| Type | When | Tabs |
|---|---|---|
| `code` | it has a private profile (`<dataDir>/profiles/<name>.json`) | Overview, Tasks, Findings, Changes, Checks, Architecture, Assets, Settings |
| `assets` | it has an asset pipeline (`tools/asset.mjs` or `tools/sprite.mjs` plus `assets/`) | Overview, Assets, Agents, Settings |
| `generic` | anything else | Overview, Agents, Assets, Settings |

A link without a tab, or with a tab the type doesn't have, opens the first tab; the old
`#cockpit/<name>` and `#health/<name>` open Overview and Architecture. Tasks groups the runs by
their root run (`run.parent`); Checks shows every count a check recorded on its own (tests
passed, failed and skipped, new, pre-existing and flaky failures, checks not run; a line from
before the test totals shows only its failures). Settings for a non-code project offers "Create from the example", which
makes it a code project. The tab bar follows the WAI-ARIA tabs pattern: Left, Right, Home and End
move the focus, Enter or Space opens the tab, and every tab is its own history entry.

## Runs

A run is a pipeline (Explain, Review, Check my work, Architecture check, Fix a finding,
Refactor, Debug, New feature) worked through stage by stage: gates the app runs itself, headless
Claude stages (`claude -p` with a fixed permission profile: READ, CHECK or EDIT), and stops where
you decide (approve the plan, allow a file, triage, review, commit). The pipelines and their
stages are data in `runs/catalog.mjs`; the stage prompts are `pipelines/app/<pipeline>/<stage>.md`.

- The run engine is `runs/manager.mjs` (limits, locks, cancel, recovery, shutdown) driving
  `runs/executor.mjs` (the stages and the buttons). `runs/wiring.mjs` builds it with the real
  modules; the app makes it on the first runs request, and the server at startup.
- Editing runs work in the run worktree (a second checkout, for example `C:\dev\example-run`,
  set up once), or on a new branch in your checkout (branch mode). One editing run per project
  at a time, at most 2 Claude stages and 1 check at once.
- The page polls `GET /api/run` and listens to `GET /api/events` for "run X changed" signals.
- At startup the server recovers what a previous app left behind: a stage that was running is
  stopped and its run marked interrupted (Retry or Resume picks it up); locks of runs that wait
  for you are kept. Before any exit (window closed, Ctrl+C, a crash) the engine stops its
  Claude and check processes with their whole process tree and marks those runs interrupted.
- Runs that wait for you don't keep the app open; a running stage or check does.
- For tests and UI work: `$env:WS_APP_TEST = '1'; node tools/workspace-app/server.mjs --fake-claude`
  replays recorded Claude output (`test/fake-claude.mjs`) instead of starting claude.
  `node tools/workspace-app/test/fixtures/runs/install.mjs <folder>` loads one sample run per
  status into a data folder for `--data-dir`.

## Ask

An assistant next to the active work: Ask, in the header of a run page and a review gate and on
every card of a project's Findings tab, opens a side panel (`ui/parts/ask-panel.js`). A question
there starts a read-only Explain run about that run or finding, the answer shows in the panel as
soon as it is there, and a follow-up keeps the thread.

- The page sends only a reference: `POST /api/runs` with `context: { run }` or
  `{ finding: { project, id } }`, plus `after` (the previous question) for a follow-up. Only Explain
  takes a context; a malformed one is a 400, an unknown run or finding a 404, a follow-up while the
  previous question still runs a 409 (`runs/context.mjs`).
- `run.json` records `context` (kind, the reference, a title, `after`, and `thread`: the earlier
  questions' run ids, at most 6) and `parent`: the run asked about (for a finding, its run when it
  has one) or, for a follow-up, the previous question. The Tasks tab groups the questions with it.
- When the stage starts, the server builds the context from its own records: for a run its title,
  status, request, plan summary, gate summary, review, changed files and diff; for a finding its
  record from the findings store; then the thread's earlier questions and answers. It is capped
  (diff 12 KB, thread 8 KB, 24 KB in all, the diff cut first), redacted, written to
  `inputs/context.md` (hashed like every input) and given to Claude as a `<data name="context">` block.
- The panel follows the question with the live updates and polling: queued, running with its time,
  answered (path:line references as code), failed with Retry, capped with Resume. It stops listening
  when it closes (Esc, its close button, or another screen) and keeps each thread and the typed text
  while the page is open; a link opens the full Explain run.

## Gates

The checks are the app's code, not Claude's: G0 (whitespace, format and lint with the project's
own config, secret scan, fences, ratchets, contract and tenant checks) plus the profile's test,
type and lint commands at the run's level (quick, standard, paranoid), compared with a baseline
by test identity, so only new failures count. Gate B runs the new tests on the old code first
(pins must pass, red tests must fail on their assertion). Fences decide which changed files a
run may touch: forbidden and unticked config files always fail; a file outside the plan waits
for your OK. A commit needs your click, green gates and the same tree the gates checked.

## Project settings

A project's rules (Markdown, at most 20,000 characters), default model, effort and permission
mode, pre-approved tools and attached assets are saved by `project-settings.mjs` as numbered
versions in the data folder: `projects/<project>/settings/v<N>.json`, written once and never
changed; the highest is current. A save names the version it was opened at and is refused (409)
when another save came first; invalid values are a 400 that lists every problem; a save that
changes nothing writes nothing, and a field it leaves out keeps its value. The routes are
`GET /api/project-settings?project=<name>` (current, versions, limits),
`GET /api/project-settings/version?project=<name>&v=<n>` and `POST /api/project-settings`
(`{ project, basedOn, rules, defaults, allowedTools, assets }`).

- **Runs:** a run records the current version when it is created (`projectSettings: { version,
  sha256 }` in `run.json`, or null), and every fresh Claude stage gets that version's rules as a
  `<project_instructions source="workspace-rules@v<N>">` block after CLAUDE.md and AGENTS.md. A
  save during the run changes nothing in it; a recorded version that is gone or no longer matches
  its hash stops the stage before Claude starts.
- **Sessions:** every session the app starts in a project (Start Claude here, a skill or a flow
  there, an agent) gets the current version, applied once in `launch.mjs`: the rules as
  `--append-system-prompt`, the defaults where its own launch leaves a value empty (a flow's
  settings win), the pre-approved tools added to its own (20 at most together). Its line in
  `sessions.jsonl` records `projectSettings`. Hub sessions and takeovers (a run's stage, which has
  its run's rules already) get none. A continued or resumed session keeps the system prompt it
  started with until it is compacted (Claude Code 2.1.309, `--system-prompt-snapshot`).

## Data folder

Everything private lives in `%LOCALAPPDATA%\claude-workspace` (`--data-dir` for another
folder), never in this public repo: `profiles/<project>.json` (the project's checks, risk paths
and fences; start from `pipelines/app/profiles/example.json`), `runs/` (one folder per run with
`run.json`, `timeline.jsonl`, `inputs/`, `stages/`, `gates/`, `final/`, plus `index.jsonl` and
the project locks), `baselines/`, `checks/`, `findings/`, `metrics/`, `worktrees/`,
`projects/<project>/settings/` (the project's rules and settings, one `v<N>.json` per version),
`settings.json`, `sessions.jsonl` and `flow-runs.jsonl` (one line per flow launch, with the
flow's version). `pipelines/app/README.md` explains the profile. The asset library is not in
the data folder: it lives in the private inbox, next to the images (below).

## Asset library

Files that project settings, flows and runs can attach: shared assets (any project may attach
them) and a project's own. Images, Markdown/text/JSON and PDF; each upload of new content is a
new, immutable version with its SHA-256. The API is in place; the screens come later.

- Files: `inbox/attachments/_assets/<id>/` (shared) and `inbox/attachments/<project>/_assets/<id>/`
  (the project folder must exist). Each holds `asset.json` and the versions `v1.md`, `v2.md`, ...
  A version file is created once and never overwritten; once `asset.json` lists it, it is never
  renamed or deleted either (archiving only hides the asset). The inbox is gitignored, and these
  folders are never triage items (`tools/lib/inbox.mjs`).
- A ref names an asset everywhere: `shared:<id>` or `<project>:<id>`. The id is kebab-case from
  the title (at most 60 characters, `-2`, `-3` when taken) and stays when the title changes.
- `asset.json` (format 1): `format`, `id`, `scope` (`shared` or `project`), `project`, `title`,
  `kind` (`image`, `text` or `pdf`), `description`, `tags`, `createdAt`, `archived`, and
  `versions` (`n`, `file`, `sha256`, `bytes`, `type`, `addedAt`, `note`, `originalName`). Only
  `asset-library.mjs` writes it, through a temporary file and a rename, one change at a time.
- A new version and a meta change carry `expect`, the number of versions the page saw; another
  count is a 409. The same bytes as the latest version add nothing (`added: false`).

| Route | Does |
|---|---|
| `GET /api/library?project=<name>&archived=1` | Shared assets plus that project's (every project's without `project`); archived ones only with `archived=1` |
| `GET /api/library/asset?ref=<ref>` | One asset with every version |
| `POST /api/library/upload?scope=&project=&title=&kind=&description=&tags=&note=&name=` | The raw file as the body: a new asset. With `ref=` and `expect=` (plus `name`, `note`, `kind`): a new version of that asset |
| `POST /api/library/meta` | `{ ref, title, description, tags, expect }`: the fields given change, the id doesn't |
| `POST /api/library/archive` | `{ ref, archived }`: archive or restore |
| `POST /api/library/resolve` | `{ project, attachments: [{ ref, pin }] }`: the version, hash and file each attachment points to (`pin: null` is the latest); `missing` and `archived` are marked; another project's ref is refused |
| `GET /library-file?ref=<ref>&v=<n>` | One version's file (`&download=1` to save it) |

## Safety

- Listens on `127.0.0.1` only and answers only to `127.0.0.1` or `localhost` with its own port
  in the `Host` header.
- The link it opens carries a sign-in token that is new for every run and valid while that run
  lasts (a second start reuses it). The token becomes an HttpOnly, SameSite=Strict cookie, and
  every request needs that cookie, except `/health` (which only says "this is the workspace
  app" plus a short workspace hash) and the sign-in link itself. The link is also in `app.log`
  and the state file in your own temp folder, so other programs running as you could use it.
  POST requests also need a same-origin `Origin`
  and the `X-Workspace-App` header, so other web pages can't call the API.
- Uploads must really be PNG, JPEG, GIF, WebP or BMP (checked by content, not by name; no SVG;
  BMP is saved as PNG by `bmp.mjs`, since Claude Code's Read tool doesn't show BMP),
  at most 25 MB. They are saved under `inbox/attachments/` only, and existing files are never
  overwritten.
- Images are served only from `inbox/`, with a sandboxing CSP. The page itself has a strict CSP
  and renders every name as text.
- Asset library uploads are checked by content as well: the bytes decide the kind (PNG, JPEG,
  GIF or WebP, a BMP saved as PNG, at most 25 MB; `.md`, `.txt` or `.json` as valid UTF-8 without
  NUL bytes, at most 2 MB, JSON that parses; a PDF starts with `%PDF-`, at most 25 MB). A file
  name or a declared kind that disagrees is refused, and SVG never gets in, not even as text.
- `/library-file` serves only a version that the asset's `asset.json` lists, by its own
  `v<n>.<ext>` name inside the asset's folder (a tampered entry or a linked folder is refused),
  with the type that extension stands for (every text kind as `text/plain; charset=utf-8`),
  `nosniff` and the same sandboxing CSP as `/img`.
- Programs start with argument lists, never through a shell string. PowerShell gets its command
  base64-encoded. Project folders with unusual characters in their name can't be started from
  the app.
- The Library sends only an id and form values. The server builds every prompt and command
  line from `catalog.mjs` and checks each value (known project, listed option, length, date
  format, kebab-case names, a plain `https://` or `git@` clone URL), so the page can't start
  anything that isn't on that list.
- Agent and flow files are found by name in their own folders, never by a path from the page.
  Saves check that the file hasn't changed since it was opened (409 otherwise), and an agent's
  name can't change in the editor (its memory folder is named after it).
- A flow run may read only that flow's image folder (`--settings` with
  `permissions.additionalDirectories`), and the prompt reaches Claude through a temp file that
  is deleted as soon as it is read.
- A project's rules reach a session only as an argument of a Node spawn (`claude-prompt.mjs`,
  `agent-session.mjs`, which read them from that temp file), never inside a PowerShell command,
  whose quoting Windows PowerShell 5.1 would change. A prompt and rules too long together for one
  Windows command line (32,767 characters) are refused before a terminal opens. Settings
  versions are never overwritten. A read refuses a version whose content doesn't match its
  stored hash, and a run one that doesn't match the hash the run recorded.
- Headless Claude stages never get `bypassPermissions` or `dontAsk`; they run `--restricted`
  with a settings file per stage, a scrubbed environment, the prompt on stdin, and caps on
  turns, time and cost. READ stages have no shell; CHECK and EDIT stages may run only
  `tg-check` (a hook refuses every other command). The app never pushes, merges or stashes.
- The runs routes check every run id and project name by pattern first, read run files only
  from a fixed list of names (a gate log only as the gate's own summary names it, a diff file
  only as the diff names it), redact secrets in everything they send, and cut text at 2 MB.
- An Ask question carries only a reference to a run or finding (any other key is refused); the
  context Claude reads is built by the server from its own records, redacted, capped and fenced
  as data.
- Processes are stopped only after their program and start time are checked, so a reused
  process id is never hit. At most 4 live update streams are open at once.

Tests: `node tools/run-tests.mjs workspace-app`. Next to each module is its `*.test.mjs`;
`test/e2e.test.mjs` drives Explain, Review and a Refactor to its commit through the real app
and engine with the fake claude, on a synthetic repo; `test/ask.e2e.test.mjs` asks about a run,
follows up and asks about a finding the same way. A test of a page module (`ui/**/*.js`)
renders it in `test/dom.mjs`, a stand-in DOM with a fake `fetch` (`installDom`, `fakeFetch`).

Screens: `node tools/workspace-app/test/shots.mjs --out <dir> --example --routes project/example/overview,runs --theme both`
saves one PNG per route from headless Edge and lists every console error, CSP violation and
exception the page logged (exit code 1 when there are any). `--example` runs the app on a
temporary workspace with the synthetic project and the sample runs; without it the tool starts
the app on this workspace with a temporary data folder. Dev only; needs Node 22+.

## Extending the app

- **A route:** add `'GET /api/x'` or `'POST /api/x'` to the object a `routes/<area>.mjs` returns from
  `routes(ctx)`, or add a new module to `ROUTE_MODULES` in `app.mjs`. The handler returns the JSON
  body (`{ ok: true, ... }`), or throws `new HttpError(status, message)`; a POST reads its own body
  with `readJson(req)`. Look names up through `lookup.mjs`, never take a path from the page.
- **A view:** add `ui/views/<id>.js` (default export `{ id, label, icon, render(el, ctx) }`, plus
  optional `onShow(ctx)` and `onHide()`, which also run when only the sub-route changes, such as
  another run id) and list it in `VIEWS` in `ui/main.js`. If it belongs in the sidebar, add it to
  `NAV_VIEWS` in `ui/main.js` (which hands the modules to the nav) and give it its place in
  `navItems()` or `footItems()` in `ui/parts/nav.js`. Its styles go in `ui/css/<id>.css`, linked in
  `index.html`.
- **A project tab:** add `ui/views/project/<id>.js` with the default export
  `{ id, label, render(el, ctx), onShow?(ctx), onHide?() }`, where
  `ctx = { state, project /* its /api/state entry */, rest /* the hash after the tab */, go, refresh }`.
  `render` fills the tab panel `el` on every repaint (patch it with `ui/parts/patch.js`, so the
  focus and typed text survive); `onShow` starts loading what the tab shows
  (`use(name, parts)` from `ui/parts/project-data.js`, which keeps those parts fresh) and `onHide`
  releases it. List the module in `ui/views/project/tabs.js` and its id in the `tabs` of the
  types that have it in `project-types.mjs`; styles go in `ui/css/project.css`.
- **A project type:** one entry in `PROJECT_TYPES` in `project-types.mjs`, before `generic`:
  `{ id, label, tabs, matches({ root, dataDir, name }) }`, plus a tab module for every tab no type
  had before. `project-types.test.mjs` checks that every tab named there has its module.
- New files in `ui/` are served after a restart of the app (`.js`, `.css`, `.svg`, `.ico` only).
- Private data that must not go into this public repo goes under `ctx.dataDir`
  (`%LOCALAPPDATA%\claude-workspace`), never in tracked files.

If the window doesn't appear, look in `%TEMP%\claude-workspace\app.log`, or run
`node tools/workspace-app/server.mjs` in a terminal to see its messages.
