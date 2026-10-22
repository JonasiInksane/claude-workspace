# Workspace app

A small local app for this workspace, opened in its own Edge window: a dashboard (inbox,
flows, active reports, projects), flows (saved prompts with reference images, run in the hub,
a project or one agent), a Tools view with a button for every skill and workspace tool,
project cards that start Claude, per-project agents (create, edit, archive and restore, start
isolated, view memory), image upload (drag and drop, Ctrl+V, or choose files) into the hub
inbox, a chosen agent's image folder or a flow, and an Assets view for projects with an asset
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
| `server.mjs` | Startup: port 4317 (or a free one), sign-in token, one app per workspace, idle shutdown (never while `isBusy()`), opens the window; `--data-dir` |
| `app.mjs` | `createApp`: access checks, the page's static files, `/img` and `/asset-file` (sandboxed), and the dispatch to `routes/*.mjs` (`ROUTE_MODULES`) |
| `http.mjs` | `HttpError`, `send`/`json`, body readers, cookie and token helpers, `PAGE_CSP`, and the startup scan of `ui/` (`listUiFiles`) |
| `state.mjs` | `buildState`: everything the page shows (`GET /api/state`), async; git runs as child processes, requests during a build share it |
| `lookup.mjs` | Finds the project, agent, flow, image target or asset project a request names (or throws 404/400); `launchableOrThrow` |
| `routes/*.mjs` | The JSON API by area: `state`, `images`, `agents`, `assets`, `launch` (start Claude, open places), `flows`, `tools` (skills, workspace tools), `projects` (new, clone, list repos) |
| `catalog.mjs` | The Tools view's list: skills (with their form fields and how the prompt is built) and workspace tools |
| `uploads.mjs` | Image targets, type check by content, dated folders, no overwrites |
| `launch.mjs` | Builds the commands for terminals, Explorer, the editor and the window; runs workspace tools and collects their output |
| `claude-prompt.mjs` | Runs in the new terminal: starts `claude <prompt>` with the prompt (and readable folders) from a prompt file, `tools/lib/prompt-file.mjs` |
| `../lib/flows.mjs` | Flows: read, check, save, archive and restore `flows/<flow>.md`; build a run's prompt ([flows/README.md](../../flows/README.md)) |
| `../lib/agents.mjs` | Agents, shared with the CLI tools; editing (`saveAgentText`, refuses renames and stale saves), archiving and restoring live here too |
| `start-app.ps1` | Starts the server hidden with `--log` (shows a dialog if Node is missing) |
| `make-shortcut.mjs` | Desktop / Start menu shortcut; never replaces or removes a "Claude Workspace" shortcut that starts something else (another workspace copy included) |
| `make-icon.mjs` | Draws `ui/icon.ico` (16 to 256 px) from the same design as `ui/icon.svg`; its PNG encoder is shared with `bmp.mjs` |
| `bmp.mjs` | BMP to PNG on upload (uncompressed 1, 4, 8, 24 and 32-bit; others are refused with a message) |
| `assets.mjs` | The Assets view: finds projects with `tools/asset.mjs` (3D) or `tools/sprite.mjs` (sprites) and `assets/`, reads each asset's `asset.json` (`"kind": "sprite"` for a sprite), check reports, renders and brief log, and a sprite's sheet (`export/SPR_<Name>.png`, `.json`, `_N` normal map, `_E` emissive); serves only PNG, JPEG, JSON and GLB files from inside `assets/` (sandboxed); writes a verdict (Approve, Revise, Reject) as the `asset.json` status plus a dated line in the brief's log |
| `ui/index.html` | The page shell: sidebar, `<main>`, the dialog; links `app.css` then `css/<view>.css`; loads `main.js` as a module |
| `ui/main.js` | The views registry (`VIEWS`), the nav and one section per view, hash routing (`#flows`, `#flows/<sub>`; Back works), pasted and dropped images, heartbeat, refresh on focus |
| `ui/lib.js` | `h()` (data always as text), `api()`, `act()`, `toast()`, `copy()`, formatting helpers, the "not connected" overlay |
| `ui/store.js` | The shared state (`state`, `view`, `sub`), `setState`, `subscribe`, `refresh`, `go()` and the hash helpers |
| `ui/dialog.js` | `openDialog` (with an unsaved-changes guard), `closeDialog`, `formDialog` |
| `ui/views/*.js` | One file per view: `home`, `flows`, `tools`, `projects`, `assets`, `images`, with their dialogs |
| `ui/app.css`, `ui/css/*.css` | Tokens, layout and shared components; styles for one view in `css/<view>.css` |
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
are refused). Archiving an agent
moves its file to `.claude/agents-archived/`, outside the folder Claude Code loads agents
from; archiving a flow moves it to `flows/_archived/`. Memory and images always stay.
In Projects, the Repositories card reads `projects/repos.json` (`tools/lib/repos.mjs`): Clone
and "Clone a repo…" run `tools/projects.mjs clone` in a terminal (a plain `git clone`; only
listed names or a checked `https://` / `git@` URL, never into an existing folder), and "Add to
list" writes a project folder's origin remote into the file.
The inbox counts come from `tools/lib/inbox.mjs`. Image rules:
[inbox/README.md](../../inbox/README.md). Agents: [the decision](../../knowledge/decisions/2026-10-21-project-agents.md).

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
- Programs start with argument lists, never through a shell string. PowerShell gets its command
  base64-encoded. Project folders with unusual characters in their name can't be started from
  the app.
- The Tools view sends only an id and form values. The server builds every prompt and command
  line from `catalog.mjs` and checks each value (known project, listed option, length, date
  format, kebab-case names, a plain `https://` or `git@` clone URL), so the page can't start
  anything that isn't on that list.
- Agent and flow files are found by name in their own folders, never by a path from the page.
  Saves check that the file hasn't changed since it was opened (409 otherwise), and an agent's
  name can't change in the editor (its memory folder is named after it).
- A flow run may read only that flow's image folder (`--settings` with
  `permissions.additionalDirectories`), and the prompt reaches Claude through a temp file that
  is deleted as soon as it is read.

Tests: `node tools/run-tests.mjs workspace-app` (`app.test.mjs`, `ui.test.mjs`, `sprites.test.mjs`,
`uploads.test.mjs`, `launch.test.mjs`, `server.test.mjs`, `shortcut.test.mjs`, `bmp.test.mjs`).

## Extending the app

- **A route:** add `'GET /api/x'` or `'POST /api/x'` to the object a `routes/<area>.mjs` returns from
  `routes(ctx)`, or add a new module to `ROUTE_MODULES` in `app.mjs`. The handler returns the JSON
  body (`{ ok: true, ... }`), or throws `new HttpError(status, message)`; a POST reads its own body
  with `readJson(req)`. Look names up through `lookup.mjs`, never take a path from the page.
- **A view:** add `ui/views/<id>.js` (default export `{ id, label, icon, render(el, ctx) }`) and
  list it in `VIEWS` in `ui/main.js`. Its styles go in `ui/css/<id>.css`, linked in `index.html`.
- New files in `ui/` are served after a restart of the app (`.js`, `.css`, `.svg`, `.ico` only).
- Private data that must not go into this public repo goes under `ctx.dataDir`
  (`%LOCALAPPDATA%\claude-workspace`), never in tracked files.

If the window doesn't appear, look in `%TEMP%\claude-workspace\app.log`, or run
`node tools/workspace-app/server.mjs` in a terminal to see its messages.
