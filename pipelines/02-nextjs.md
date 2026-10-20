# 02 · Next.js

**Shortcut:** `/nextjs-feature <what you want>` in a project session.

## Set up once per project

`/new-project <name> nextjs` copies these from `templates/nextjs/` (existing files are kept):

| File | What it does |
|---|---|
| `CLAUDE.md` | Fill-in template: commands, router, data, styling, env var names |
| `.claude/settings.json` | Allows `npm run dev/build/lint/test`, `npm test` and `npx tsc --noEmit` as Bash **and** PowerShell rules; denies reading `.env`, `.env.local`, `.env.*.local`, `.env.production`, `.env.development`, `.env.test` in any folder; runs the format hook |
| `.claude/hooks/format-file.mjs` | Runs Prettier on the one file Claude just edited, only if the project uses Prettier |
| `.claude/rules/nextjs.md` | Next.js rules that load only when Claude touches `app/`, `src/` or `components/` |
| `.mcp.json` | The Playwright MCP server, so Claude can drive a real browser |
| `.worktreeinclude` | Copies `.env.local` into `claude -w` worktrees |

### New app from scratch
`/new-project my-app nextjs` without a URL creates a folder with only the Claude files: no
`package.json`, no app. `create-next-app` refuses a folder that already has files, so scaffold
next to it and move the app in:
```powershell
cd projects
npx create-next-app@latest my-app-tmp --disable-git
Get-ChildItem -Force my-app-tmp | Where-Object { -not (Test-Path (Join-Path my-app $_.Name)) } | Move-Item -Destination my-app
Get-ChildItem -Force my-app-tmp   # anything left duplicates a template file; compare, then delete
Remove-Item -Recurse my-app-tmp
cd my-app; claude                 # then /onboard-project
```
Or ask Claude in the project session to do exactly these steps. If `create-next-app` wrote an
`AGENTS.md`, `/onboard-project` adds the `@AGENTS.md` line to `CLAUDE.md`.

### Package manager: read it from the lockfile

| Lockfile | Package manager |
|---|---|
| `package-lock.json` | npm |
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` | yarn |
| `bun.lock` or `bun.lockb` | bun |

Mixing them leaves two conflicting lockfiles. If it isn't npm, update **both twins** of every rule in
`.claude/settings.json`, e.g. `"Bash(pnpm run build *)"` and `"PowerShell(pnpm run build *)"`
([templates/nextjs/README.md](../templates/nextjs/README.md) lists the rules per package manager).
On Windows Claude Code can run commands through Bash or PowerShell, and a Bash rule doesn't
cover PowerShell. Write the package manager into `CLAUDE.md` too.

### Things to pin down in `CLAUDE.md`

Claude will guess these wrong if you don't write them down (the full list, with how to find
each one, is in [project-checklist.md](../knowledge/nextjs/project-checklist.md)):

- **Router:** App Router (`app/`) or Pages Router (`pages/`)? Mixed?
- **Next.js version.** Behavior around caching, `params` and middleware changes
  between major versions.
- **Server vs client:** default to Server Components. `"use client"` only where needed.
- **Data:** where fetching happens (server components, route handlers, server actions,
  tRPC, React Query...).
- **Styling:** Tailwind / CSS modules / styled-components, and the UI kit (shadcn, MUI...).
- **Env vars:** names only, never values. Anything prefixed `NEXT_PUBLIC_` ends up in browser
  code, so it must never hold a secret.

### Rules that load only where they matter
Put framework conventions in `.claude/rules/nextjs.md` instead of a growing `CLAUDE.md`.
Its `paths:` frontmatter makes it load only when Claude reads or edits a matching file.
Adjust the globs if your code lives elsewhere (e.g. `apps/web/**` in a monorepo).

### Playwright MCP: let Claude use a browser
The template's `.mcp.json`:
```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
  }
}
```
- The first session asks you to approve the server. `/mcp` shows whether it connected.
- Then Claude can open pages, click through flows, read the console and take screenshots.
- If it fails to start on Windows, change it to
  `"command": "cmd", "args": ["/c", "npx", "-y", "@playwright/mcp@latest"]`.

## Feature pipeline

### 1. Explore
- Find a **similar existing feature** and copy its patterns. This matters more than anything else.
- Trace the route: page → layout → components → data source.

### 2. Plan
- `/plan <feature>` (the `/nextjs-feature` skill also stops for a plan).
- List files to create or change, and say for each one whether it's server or client.
- Data shape plus loading, error and empty states.
- Wait for your OK.

### 3. Implement in slices
1. Data layer (types, fetch, action)
2. Server component / route
3. Client interactivity
4. Styling and states

### 4. Verify, from cheapest to slowest
```powershell
npx tsc --noEmit        # types
npm run lint            # lint (whatever script the project defines)
npm test                # if tests exist
npm run build           # catches server/client boundary + static generation errors
```
Then **look at it**:
- **Dev server in the background.** Ask: "Start `npm run dev` in the background and check
  its output for errors." Or start it yourself with `! npm run dev` and press **Ctrl+B** to
  send it to the background. `/tasks` lists what's running. Claude can read the server output,
  so you don't need a second terminal. Background commands stop when Claude Code exits.
- **`/run`** is a built-in skill that launches the app and drives it to see the change working.
- **Playwright MCP:** "Open /settings, change the display name, and screenshot the result."
- **Claude desktop app:** ask Claude to preview the page. It can start the dev server and open
  it in the app's built-in browser (it keeps that setup in `.claude/launch.json`).

### 5. Review
- **`/code-review`** reviews the current diff (built-in; `/review` is an alias). Add a level
  (`/code-review high`) for a deeper pass, or `--fix` to apply the findings.
- Or ask the `code-reviewer` agent to review the diff.

### 6. Commit
"Commit this with a clear message." One feature, one branch.

## Two features at once: worktrees

Each parallel session needs its own copy of the code. `claude -w` makes one:
```powershell
cd projects\my-app
claude -w settings-page
```
- This creates `.claude\worktrees\settings-page` on a new branch `worktree-settings-page`
  and starts Claude there.
- `.worktreeinclude` copies `.env.local` in. Dependencies are not copied: run `npm install`
  in the new session first.
- Run the second dev server on another port: `npm run dev -- -p 3001`.
- On exit, a clean worktree is removed; one with changes asks whether to keep it.
- Add `.claude/worktrees/` to `.gitignore`.

More in [04 · Claude Code in the terminal](04-claude-cli.md#parallel-sessions).

## Common Next.js mistakes to guard against

- Using hooks or browser APIs in a Server Component, or adding `"use client"` too high up the tree
- Importing server-only code (DB clients, secrets) into client components
- Putting a secret in a `NEXT_PUBLIC_` variable
- Forgetting `loading.tsx` / `error.tsx` / `not-found.tsx`
- Running `npm install` in a pnpm/yarn repo
- Editing generated files (`.next/`, generated API clients)
