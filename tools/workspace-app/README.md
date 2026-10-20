# Workspace app

A small local app for this workspace, opened in its own Edge window: a dashboard (inbox,
active reports, projects), project cards that start Claude, per-project agents (create,
start isolated, view memory) and image upload (drag and drop, Ctrl+V, or choose files) into
the hub inbox or a chosen agent's image folder.

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
| `server.mjs` | Startup: port 4317 (or a free one), sign-in token, one app per workspace, idle shutdown, opens the window |
| `app.mjs` | Routes, access checks and the JSON API |
| `uploads.mjs` | Image targets, type check by content, dated folders, no overwrites |
| `launch.mjs` | Builds the commands for terminals, Explorer, the editor and the window |
| `start-app.ps1` | Starts the server hidden with `--log` (shows a dialog if Node is missing) |
| `make-shortcut.mjs` | Desktop / Start menu shortcut; never replaces or removes a "Claude Workspace" shortcut that starts something else (another workspace copy included) |
| `make-icon.mjs` | Draws `ui/icon.ico` (16 to 256 px) from the same design as `ui/icon.svg` |
| `ui/` | The page: `index.html`, `app.js`, `app.css`, `icon.svg` (plus `icon.ico` for the shortcut). Plain JS, no build step |

The app does what the command-line tools do and nothing more. "Start" on an agent runs
`tools/agent-session.mjs` in a Windows Terminal tab, and "New agent" runs `tools/new-agent.mjs`.
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
- Uploads must really be PNG, JPEG, GIF, WebP or BMP (checked by content, not by name; no SVG),
  at most 25 MB. They are saved under `inbox/attachments/` only, and existing files are never
  overwritten.
- Images are served only from `inbox/`, with a sandboxing CSP. The page itself has a strict CSP
  and renders every name as text.
- Programs start with argument lists, never through a shell string. PowerShell gets its command
  base64-encoded. Project folders with unusual characters in their name can't be started from
  the app.

Tests: `node --test "tools/**/*.test.mjs"` (`app.test.mjs`, `uploads.test.mjs`, `launch.test.mjs`,
`server.test.mjs`, `shortcut.test.mjs`).

If the window doesn't appear, look in `%TEMP%\claude-workspace\app.log`, or run
`node tools/workspace-app/server.mjs` in a terminal to see its messages.
