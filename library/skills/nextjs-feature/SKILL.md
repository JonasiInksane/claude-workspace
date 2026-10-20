---
name: nextjs-feature
description: Build or change a feature in a Next.js project with explore, plan (wait for approval), implement, verify and wrap up. Use when adding or changing pages, routes, layouts, components, server actions, route handlers or data fetching in a Next.js app.
argument-hint: "[feature description]"
---

# Next.js feature

Ship one Next.js feature the way this project already works, and prove it works.

The request: $ARGUMENTS

If that is empty, use the user's latest request. If it is still unclear, ask one short
question before exploring.

## 1. Explore (read only)
- CLAUDE.md is already loaded; follow it. Also read `.claude/rules/` files that apply.
- Package manager, from the lockfile. Use only this one for every command:

  | Lockfile | Manager | Script | Local binary |
  |---|---|---|---|
  | `package-lock.json` | npm | `npm run <script>` | `npx <bin>` |
  | `pnpm-lock.yaml` | pnpm | `pnpm run <script>` | `pnpm exec <bin>` |
  | `yarn.lock` | yarn | `yarn run <script>` | `yarn <bin>` |
  | `bun.lock` or `bun.lockb` | bun | `bun run <script>` | `bunx <bin>` |

- Next.js and React versions (package.json; `node_modules/next/package.json` for the exact
  one). Write code for that version, not from memory of another one. If
  `node_modules/next/dist/docs/` exists, it holds docs for the installed version.
- Router: `app/` or `src/app/` = App Router, `pages/` = Pages Router. Don't mix their patterns.
- Styling, UI kit, data layer, auth, and the test setup (`scripts` in package.json).
- Find the most similar existing feature and read it fully. Reuse its patterns.
- For a large or unfamiliar area, delegate the mapping to the `code-explorer` agent if it exists.

## 2. Plan, then WAIT
Present the plan in this shape and stop until the user approves or changes it:

```markdown
## Plan: <feature>
| File | New/Change | Server or client | Purpose |
|---|---|---|---|
- Data flow and types: ...
- States: loading / error / empty / success
- New dependencies: none (or: name, why, ask first)
- Env vars: names only; any NEXT_PUBLIC_ ones and why they are safe to expose
- Verify with: <exact commands> + <page to check in the browser>
```

## 3. Implement
In this order, typechecking after each step:
1. Types and data layer (fetchers, server actions, route handlers).
2. Server components and route segments.
3. Client components: `"use client"` only where state, effects, event handlers or browser
   APIs are needed, as low in the tree as possible.
4. Styling and states (`loading.tsx`, `error.tsx`, `not-found.tsx` where they fit).

Stay inside the approved plan. If it has to change, say so and wait again.

## 4. Verify
Use the commands CLAUDE.md lists. Otherwise run what exists, cheapest first, with the
detected package manager:
1. Typecheck: `npx tsc --noEmit` (or `pnpm exec`, `yarn`, `bunx` equivalent).
2. Lint: `<pm> run lint`.
3. Tests: `<pm> run test` (non-watch mode).
4. Build: `<pm> run build`, for anything beyond a small change.

Then check the page: reuse a dev server that is already running, or start `<pm> run dev`
in the background. If a browser tool is available (for example the Playwright MCP server),
open the page, check the console for errors and take a screenshot of each state.

Fix failures you caused. Report pre-existing failures without fixing them.

## 5. Wrap up
- Ask the `code-reviewer` agent to review the diff (if it exists). Fix its high findings.
- Don't commit unless the user asks.
- Report:

```markdown
## Done: <feature>
- Changed: `path` - what (one line each)
- Verified: typecheck pass, lint pass, tests 12/12, build pass, page checked at /route
- Not verified: ...
- Follow-ups: ...
```

Offer at most 3 next steps (for example: commit, add a test for X, handle edge case Y).

## What not to do
- **Don't import server-only code** (database clients, `fs`, secrets) into a client component.
- **Don't put a secret in a `NEXT_PUBLIC_` variable.** Their values are inlined into browser code.
- **Don't read `.env` files.** Ask for variable names, or read `.env.example`.
- **Don't switch package managers** or create a second lockfile.
- **Don't add dependencies without asking.**
- **Don't edit generated files** (`.next/`, generated UI kit folders noted in CLAUDE.md).
- **Don't add `"use client"` to a whole page or layout** to silence one hook error.
- **Don't start a second dev server** when one is already running.
