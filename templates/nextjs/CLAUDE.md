<!--
Fill-in template. Replace every <...>, delete lines that don't apply, and keep the file
under about 120 lines. HTML comments like this one are stripped before Claude reads the file.
Running /onboard-project in this folder fills it in for you.
AGENTS.md: if the repo has one, make the first line of this file an at-sign followed by
AGENTS.md (an import). Once a CLAUDE.md exists, Claude Code stops reading AGENTS.md on its own.
-->
# {{PROJECT_NAME}}

<One paragraph: what this app does, and who uses it.>

## Current focus
Update this whenever the focus changes. Claude uses it to decide what matters and what to skip.
- Goal: <what this project is for right now, e.g. a public beta for 20 testers>
- Milestone: <the next concrete deliverable and roughly when, e.g. sign-in plus dashboard by Nov 15>
- Out of scope for now: <things not to work on or suggest, e.g. payments, mobile layout>

## Stack
- Next.js <16.x> with the <App Router (`src/app/`) | Pages Router>, React <19.x>, TypeScript
- Package manager: <npm | pnpm | yarn | bun> (lockfile `<package-lock.json>`). Use only this one.
- Node <20.x>
- Styling: <Tailwind | CSS modules>. UI kit: <shadcn/ui | none>
- Data: <Prisma + Postgres | Supabase | REST API at ...>
- Auth: <Auth.js | Clerk | none>
- Tests: <Vitest | Jest | Playwright e2e | none yet>

## Commands
Use these exact forms; they match the allow rules in `.claude/settings.json`.
- Dev: `npm run dev` (http://localhost:3000). Run it in the background and reuse a running one.
- Typecheck: `npx tsc --noEmit`
- Lint: `npm run lint`
- Test: `npm run test`
- Build: `npm run build`

Done means: typecheck, lint and tests pass. Run the build too before calling a bigger change finished.

## Architecture
- `<src/app/>`: routes. `(group)` folders are route groups, not URL segments.
- `<src/components/>`: shared UI. <Generated UI kit folder, e.g. `src/components/ui/` (shadcn/ui)>: don't hand-edit.
- `<src/lib/>`: utilities. Server-only modules import `server-only`.
- `<src/server/>`: database access and server actions.
- `<...>`

## Conventions
- Server Components by default. `"use client"` only for interactivity, kept low in the tree.
- Mutations through Server Actions in `<app/**/actions.ts>`; validate input with <zod | valibot>.
- <naming, error handling, form library, date handling>
- More Next.js rules load from `.claude/rules/nextjs.md` when Claude works on app code.

## Environment variables
- Secrets live in `.env.local` (gitignored). The variable names are listed in `.env.example`.
- Only `NEXT_PUBLIC_` variables reach the browser, inlined at build time. Never give a secret that prefix.
- Variables in use: <DATABASE_URL, NEXT_PUBLIC_SITE_URL, ...>

## Do not touch
- `.env*` files. Ask me for variable names instead.
- `.next/`, `node_modules/`, `<generated folders>`
- The lockfile, except through the package manager.

## Known issues
- <baseline failures, flaky tests, slow commands>
