# Workspace app module layout: developer guide

The workspace app is now split into the agreed module skeleton. On this PC (Node 24.11.1), nothing visible or behavioural changed except the deliberate fixes listed at the end. **98/98 tests pass**: 88 at the start plus 10 new (`node tools/run-tests.mjs`; the `workspace-app` filter runs 58). Before and after screenshots of all six views are byte-identical at 1280 px and at 700 px.

Code lives under `C:\dev\claude-workspace\tools\workspace-app\`. Nothing was committed, staged or stashed, and nothing in the Tattoogenda repo was touched.

## Server files

**`http.mjs`** (HTTP plumbing; it knows nothing about the workspace)
- `class HttpError(status, message)`
- `send(res, status, body, headers = {})`: always adds the nosniff, no-referrer, DENY and no-store headers.
- `json(res, status, data)`
- `readBody(req, limit) → Promise<Buffer>`: answers 413 over the limit.
- `readJson(req) → Promise<object>`: 64 KB limit; an empty body gives `{}`; bad JSON gives 400.
- `cookies(req) → object`, `sameToken(a, b) → boolean`
- Constants: `PAGE_CSP`, `MAX_JSON_BYTES`, `STATIC_TYPES`
- `listUiFiles(uiDir) → Map<urlPath, { file, type }>`: scans `ui/` once at startup.
  - `/` is `index.html`. Otherwise only `.js`, `.css`, `.svg` and `.ico` files are served.
  - Names must match `/^[A-Za-z0-9_-][\w.-]*$/`, so dotfiles and names with spaces are skipped.
  - Symlinks and junctions are skipped, and folders deeper than 4 levels are ignored.
  - Request paths are looked up exactly as written, with no decoding.
- `sendStatic(res, entry)`: HTML gets `PAGE_CSP`.

**`state.mjs`**
- `buildState(root, tools = {}) → Promise<state>`: same shape as before.
  - Git work (origins, `git lfs`) runs as async child processes.
  - Requests that arrive during a build share it.
  - A finished build is never reused, so there is no stale cache.
- `invalidateState(root)`: `app.mjs` calls it after every non-GET API call.
- `readReports(root) → array`

**`lookup.mjs`** (extra module, not in the skeleton)
Route modules share these lookups, and putting them in `app.mjs` would have created an import cycle.
- `LAUNCHABLE`, `isLaunchable(name)`
- `launchableOrThrow(project)`: the one guard that replaced the five repeated checks.
- `findProject(root, name) → realName`
- `findAgent(root, project, agent, { isolated, file }) → { project, agent }`
- `flowOrThrow(root, slug)`
- `targetOrThrow(root, query)`
- `assetProjectOrThrow(root, project)`

**`routes/*.mjs`** (each exports `routes(ctx)`)

| Module | Routes |
|---|---|
| `state` | `GET /api/state` |
| `images` | `GET /api/images`, `POST /api/upload` |
| `agents` | `GET /api/memory`, `GET/POST /api/agent-file`, `POST /api/agents{,/archive,/restore}` |
| `assets` | `GET /api/asset`, `POST /api/asset-verdict` |
| `launch` | `POST /api/launch`, `POST /api/open` |
| `flows` | `GET /api/flow`, `POST /api/flows{,/caption,/run,/archive,/restore}` |
| `tools` | `POST /api/skill`, `POST /api/run` |
| `projects` | `POST /api/repos/clone`, `POST /api/repos/add`, `POST /api/projects` |

**`app.mjs`**
- `createApp(options) → handler`, with `handler.isBusy()` attached.
- `ROUTE_MODULES`: the list of route modules.
- `mergeRoutes(tables)`: throws on a key defined twice, a key not matching `^(GET|POST) /api/[a-z0-9/-]+$`, or a missing handler.
- `defaultDataDir(env)`
- Still in `app.mjs`: the Host, cookie and Origin checks, `/health`, sign-in, static files, `/img`, `/asset-file`, and the built-in `POST /api/ping`.

**`tools/lib/repos.mjs`**
- The sync API is unchanged.
- New async functions:
  - `originOfAsync(dir)`: always fresh.
  - `repoStatusAsync(root)`, `unlistedProjectsAsync(root)`: origins cached per folder for `ORIGIN_TTL_MS` (10 s); calls at the same time share one git run.
  - `requirementStatusAsync()`: shares the existing one-minute cache.
  - `clearRepoCache()`

**`server.mjs`**
- The idle tick calls `app.isBusy()`. While it returns true, that counts as activity.
- New `--data-dir <dir>` option.

### `createApp` options
`{ root, token, actions, getPort, workspaceTag = '', onPing, uiDir = ui/, dataDir = defaultDataDir(), isBusy = null }`

- `dataDir` defaults to `%LOCALAPPDATA%\claude-workspace`. Nothing creates the folder yet.
- `ctx = { root, actions, getPort, workspaceTag, dataDir }`, with `root` and `dataDir` already resolved.

## The route-module contract

```js
// routes/assets.mjs
export function routes({ root }) {
  return {
    'GET /api/asset': async (req, res, url) => {
      const q = Object.fromEntries(url.searchParams);
      const project = assetProjectOrThrow(root, q.project);
      const d = assetDetail(root, project, q.id);
      if (d.error) throw new HttpError(404, d.error);
      return { ok: true, project, ...d };          // sent as JSON 200
    },
    'POST /api/asset-verdict': async req => {
      const b = await readJson(req);               // POST handlers read their own body
      ...
      return { ok: true, status: r.status, message: '...' };
    },
  };
}
```

- A handler returns the full JSON body, by convention starting with `ok: true`.
- It returns `undefined` only if it has already answered (for streaming).
- Errors are `throw new HttpError(status, msg)`. A thrown error with a `.status` property also works (`catalog.mjs` does this). The page receives `{ ok: false, error }`.
- Never take a path from the page; resolve names through `lookup.mjs`.
- A route module can be tested on its own: `routes(ctx)['GET /api/state'](null, null, new URL(...))`. `app.test.mjs` has an example.

## The view contract

```js
// ui/views/projects.js
export default {
  id: 'projects',                    // must equal the file name; the hash is #projects
  label: 'Projects',
  icon: '<path d="..."/>',           // fixed SVG inner markup, no data
  count: s => s.projects.length || '',   // optional: number in the nav
  render,                            // render(el, { state, sub, go, refresh })
};
// optional: visible(state), onShow(), onHide(), onFiles(files, pasted)
```

- `main.js` builds the nav button and the `<section id="view-<id>">` from `VIEWS`.
- `render` runs on every `setState` while the view is on screen.
- `onFiles` receives pasted or dropped images; Images uses it.

## Page files

**`ui/lib.js`**
- Elements: `$`, `h(tag, props, ...children)`, `icon(markup)`
- Formatting: `qs`, `plural`, `fmtSize`, `fmtDay`, `fmtTime`
- Feedback: `toast(msg, isError)`, `copy(text)`
- Server: `api(path, { method, body, raw, contentType })`, `act(promise)`, `launch(body)`, `openPlace(body)`, `showStopped`, `checkServer`, `isStopped`

**`ui/store.js`**
- Live bindings `state`, `view` and `sub`; only `store.js` assigns them.
- `setState`, `subscribe(fn) → unsubscribe`, `setView` (used by `main.js` only), `refresh()`, `msSinceRefresh()`
- `go(id, sub?)`: pushes a history entry. Going to the current view shows it again without a new entry.
- `hashFor(id, sub)`, `parseHash(hash)`

**`ui/dialog.js`**
- `dialog` (the element), `openDialog(title, body, { wide, actions, guard, upload })`, `closeDialog()`, `clearGuard()`, `getDialogUpload()`
- `formDialog(title, intro, controls, submitLabel, submit)`

**`ui/views/*.js`** (shared exports between views)
- `tools.js` exports `skillDialog` and `skillById`.
- `images.js` exports `setTarget` and `uploadFiles`.

**`ui/main.js`**
- Owns `VIEWS`, the nav, hash routing, paste and drop, the heartbeat, and refresh on focus.
- Unknown hashes are replaced with `#home`.

**CSS**
- `ui/app.css`: tokens, layout and shared components.
- `ui/css/{home,flows,projects,assets,images}.css`: rules for one view, each with its own narrow-screen media rules. They are linked after `app.css`.

**`ui/package.json`**: only `{"type":"module"}`, so Node 20 tests can import `ui/store.js`. It is never served.

## How to add things
- **A route:** add a key to an existing `routes/<area>.mjs`, or create a new module and add it to `ROUTE_MODULES`. Add API tests in `app.test.mjs` using the `call()` helper. Add the key to the "every route the page uses" list if the page depends on it.
- **A view:** create `ui/views/<id>.js` and add `import <id> from './views/<id>.js'` plus an entry in `VIEWS` in `main.js`. `ui.test.mjs` fails if a view file isn't registered, its `id` doesn't match the file name, or `label`, `icon` or `render` is missing.
- **A CSS file:** create `ui/css/<id>.css` and add `<link rel="stylesheet" href="/css/<id>.css">` after `app.css` in `index.html`. The test fails if it isn't linked.
- **Any new file in `ui/`:** it is served only after a restart, and only if it is `.js`, `.css`, `.svg` or `.ico`. The static test follows every import from `/main.js`, so a missing or wrongly named module fails the tests.

## What I verified
- **Tests:** 88/88 before; 98/98 after. New tests:
  - `app.test.mjs`: static crawl and not-served paths; `listUiFiles` with dotfiles, a junction, depth and file types; `mergeRoutes`; calling a route module directly; `createApp` options; shared state builds.
  - `ui.test.mjs`: hash helpers and the view registry contract.
  - `repos.test.mjs`: async variants and the origin cache.
  - `server.test.mjs`: `--data-dir`.
- **Screenshots:** headless Edge over CDP, against the same live data, with old (`git archive HEAD`) and new code run back to back. A first comparison was spoiled because `projects/game-dev-2d` appeared while I worked.
  - Before: `C:\Users\jonas\AppData\Local\Temp\claude\C--dev-claude-workspace\f6dd341f-636f-4e74-8fae-0d14a3e72b23\scratchpad\build\before\`
  - After: `C:\Users\jonas\AppData\Local\Temp\claude\C--dev-claude-workspace\f6dd341f-636f-4e74-8fae-0d14a3e72b23\scratchpad\build\after\`
  - All six views are byte-identical PNGs. A computed-style and box comparison of every element is identical apart from the items under "Changes on purpose".
  - The 700 px run (`build\narrow-before` and `build\narrow-after` in the same scratchpad folder) also matches. No console errors or warnings in either version.
- **Behaviour in the browser:**
  - Esc with unsaved changes asks first; "keep editing" keeps the dialog open; "discard" closes it.
  - Esc without changes closes at once.
  - `#nope` goes to `#home`, and `#flows/<sub>` works.
  - Nav click then Back now returns to the previous view (before, it skipped views).
- **Other checks:** `check-workspace` reports 0 errors; its two warnings were there before. Every server and Edge process I started is stopped.

## Changes on purpose
- **The `.checks` clash:** the checkbox group class is renamed to `.check-group`, so `table.checks` is now a real table. The pixels are the same.
- **Stray "null" in dialogs:** dialogs without footer buttons showed the text "null" (a `replaceChildren(null)` bug). This is fixed, so those dialogs are 22 px shorter.
- **History:** nav clicks now add history entries.
- **Nav markup:** the nav and the view sections are built by `main.js`, so the old ids `countFlows`, `countProjects`, `countAssets` and `navAssets` are gone.
- **No more blocking spawns on requests:** `POST /api/agents` runs `new-agent.mjs` asynchronously, and `POST /api/repos/add` uses `originOfAsync`.
- **Static files:** `/icon.ico` is now served.
- **Docs:** README updated ("How it works" table and a new "Extending the app" section). The knowledge note `knowledge/web/dialog-esc-guard.md` now points to `ui/dialog.js`, with `updated` bumped in the note and in `INDEX.md`.

## Not done or not verified
- **Node 20.15.1** isn't installed here (no nvm on this PC), so the suite only ran on Node 24. The code uses only Node 20 features, and `ui/package.json` exists for Node 20 module loading.
- **Dark mode** wasn't compared. Only the `:root` colour values change there, and the cascade order was checked in light mode.
- **Real file drops and pastes** weren't simulated; that logic is a direct port, now routed through `onFiles`.
- **`openNavigator`** in `launch.mjs` still uses `spawnSync` to run `build-index`, which blocks the server briefly. I left it unchanged.