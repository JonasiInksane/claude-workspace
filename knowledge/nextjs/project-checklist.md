---
title: Next.js project checklist for CLAUDE.md
tags: [nextjs, claude-md, checklist, env-vars]
updated: 2026-10-20
---

# Next.js project checklist for CLAUDE.md

**TL;DR:** Claude's training data mixes many Next.js versions. A Next.js project's CLAUDE.md
should pin the router, the exact version, the package manager, the server/client rules, the env
var rules and the exact commands that prove a change works.

## What to pin down

| Item | How to find it | Line for CLAUDE.md |
|---|---|---|
| Router | `app/` or `src/app/` = App Router; `pages/` = Pages Router; both can exist | "App Router only. Don't add `pages/` routes." |
| Next.js and React version | `package.json`, or `npm ls next react` | "Next.js 16.x, React 19.x" |
| Package manager | The lockfile (table below) | "Use pnpm. Never run npm install." |
| Node version | `node --version`; `.nvmrc` or `engines` if present | "Node 20.9+" (minimum for Next.js 16) |
| Server/client rules | Search for `"use client"` and `"use server"` | See the rules below |
| Env vars | `.env.example` (names only) | Which names exist; which are `NEXT_PUBLIC_` |
| Verify commands | `scripts` in `package.json` | Exact commands, in order |
| Layout | `components/`, `lib/`, actions, data layer, styling | One line each |

Package manager from the lockfile:

| Lockfile | Manager | Run a script |
|---|---|---|
| `package-lock.json` | npm | `npm run build` |
| `pnpm-lock.yaml` | pnpm | `pnpm build` |
| `yarn.lock` | yarn | `yarn build` |
| `bun.lock` or `bun.lockb` | bun | `bun run build` |

Never let Claude create a second lockfile with a different manager.

## Server and client components (App Router)

- Components are **Server Components** by default. Add `"use client"` only to files that need
  state, effects, event handlers or browser APIs, and keep those files small and low in the tree.
- Never import server-only code (database clients, `fs`, secrets) into a client component.
  The `server-only` package turns that mistake into a build error.
- Server Actions are async functions in a file or function marked `"use server"`.
- Next.js 16: `params`, `searchParams`, `cookies()`, `headers()` and `draftMode()` are
  **async only**: `const { slug } = await params`. The synchronous form from 15 is gone.

## Environment variables

- Secrets go in `.env.local` (gitignored). `.env*` files live in the project root, not in `src/`.
- Only variables prefixed `NEXT_PUBLIC_` reach the browser. Their values are **inlined at build
  time** into the JavaScript bundle, so never put a secret in a `NEXT_PUBLIC_` variable, and
  rebuild after changing one.
- Dynamic lookups such as `process.env[name]` are not inlined.
- Load order: `process.env`, `.env.$(NODE_ENV).local`, `.env.local`, `.env.$(NODE_ENV)`, `.env`.
  `.env.local` is **not** loaded when `NODE_ENV` is `test`.
- Claude should not read the real env files: deny `Read(.env)`, `Read(.env.local)`,
  `Read(.env.*.local)` and `Read(.env.production)` in `.claude/settings.json` (bare names
  match in every folder; `./.env` only covers the folder Claude was started in). Keep the names in `.env.example` (left
  readable) so Claude knows what exists.

## Verification commands

Write the real commands from `package.json`. A typical set:

```powershell
npm run dev            # http://localhost:3000; Claude can run it in the background (Ctrl+B)
npm run build          # Next.js 16 builds with Turbopack by default
npm run lint           # Next.js 16 removed `next lint`; the script must call ESLint (or Biome) directly
npx tsc --noEmit       # type check
npm test               # Vitest or Jest, if present
npx playwright test    # e2e, if present
```

Tell Claude which ones must pass before a task counts as done, and allow them in
`.claude/settings.json` as Bash **and** PowerShell rules (see
[Permissions and settings](../claude-code/permissions-and-settings.md)).

## AGENTS.md in Next.js 16.3+

- `create-next-app` creates agent files, and `next dev` writes a managed block into `AGENTS.md`
  when it detects a coding agent. The block points agents at version-matched docs in
  `node_modules/next/dist/docs/`.
- Claude Code ignores AGENTS.md as soon as a CLAUDE.md exists, so start the project's CLAUDE.md
  with `@AGENTS.md` (see [CLAUDE.md, imports and rules](../claude-code/claude-md-and-rules.md)).
- Commit the block; `next dev` re-adds it if removed. Turn it off with `agentRules: false` in
  `next.config`, or skip it for a new app with `create-next-app --no-agents-md`.

## Skeleton

```markdown
@AGENTS.md

# my-app
Next.js 16 (App Router, `src/app/`), React 19, TypeScript, Tailwind. Package manager: pnpm.

## Commands
- Dev: `pnpm dev` (port 3000; reuse a running server)
- Must pass before done: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm build`

## Rules
- Server Components by default; "use client" only in `src/components/client/`.
- DB access only in `src/server/` (imports `server-only`).
- Secrets only in `.env.local`; names listed in `.env.example`. Never NEXT_PUBLIC_ a secret.
- `params`/`searchParams`/`cookies()` are async: always await them.
```

## Common mistakes

- `"use client"` slapped on a whole page or layout to silence one hook error.
- `Module not found: Can't resolve 'fs'`: server code imported into a client bundle. Move the
  import to the server side instead of adding a resolve fallback.
- Pages Router patterns (`getServerSideProps`, `next/router`) written into an App Router project.
- Synchronous `params.slug` or `cookies().get(...)` on Next.js 16.
- `middleware.ts` on 16: the convention is now `proxy.ts` (edge runtime still needs `middleware`).
- A secret in a `NEXT_PUBLIC_` variable, or expecting a changed `NEXT_PUBLIC_` value without rebuilding.
- `next lint` in scripts or CI on 16.
- Starting a second dev server. On 16, `next dev` detects the running one and prints its URL and PID.
- Mixing package managers, or running installs Claude wasn't asked to run.
- Editing generated output (`.next/`) instead of the source.

For browser checks, see the Playwright and next-devtools entries in [MCP servers](../claude-code/mcp-servers.md).
The project template lives in `templates/nextjs/`.

Sources: https://nextjs.org/docs/app/guides/upgrading/version-16,
https://nextjs.org/docs/app/guides/environment-variables, https://nextjs.org/docs/app/guides/ai-agents
