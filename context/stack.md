# Stack

Machine facts, last checked 2026-10-20. Update this file when something changes
(`node -v`, `claude --version`).

## Machine
- OS: Windows 11
- Shells: Windows PowerShell 5.1 (no PowerShell 7, so no `&&`, `||`, `??` or ternary in .ps1)
  and Git Bash (Git for Windows)
- Node: v20.15.1, managed with nvm; `C:\Program Files\nodejs` is on PATH
- Python: 3.13 (not needed by the workspace tools)
- Editors: VS Code, Cursor
- Git client: GitKraken (plus the git CLI)
- Claude Code: 2.1.304, native install at `%USERPROFILE%\.local\bin\claude.exe`

## Workspace tooling
- Tools are Node ESM scripts (`node tools/<name>.mjs`) with no npm dependencies.
- No Python or jq is required.

## Web (Next.js): the Tattoogenda web app (`apps/web`)
- Framework: Next.js 16.3 with the App Router (no Pages Router), React 19.2, TypeScript 5.6.
- Repo: npm workspaces + Turbo 1 monorepo (`package-lock.json`, never pnpm/yarn), Node 20.15.1.
  The same repo holds the Expo 52 mobile app, the backend (`apps/server`) and Python agents.
- UI: Tailwind CSS 4 and Ant Design, Heroicons, Bryntum calendar. Forms with React Hook Form +
  Zod. i18n with next-intl (`apps/web/messages`). Dates with dayjs.
- Data: tRPC 11 + TanStack Query, proxied to the Hono/tRPC backend. Prisma 6 + PostgreSQL;
  Redis + BullMQ for background jobs.
- Auth: the backend's own session (cookie for web, bearer token for mobile), checked in
  `apps/server/src/trpc/context.ts`. Not NextAuth/Clerk.
- Hosting: Render according to `docs/operations/render-memory.md` (not verified in config).
  Mobile ships through Expo EAS.
- Tests: Node's built-in test runner via tsx (`*.test.ts`), plus opt-in `*.integration.ts`
  tests against disposable PostgreSQL/Redis. No Vitest, Jest or Playwright.

## Games
- TODO: engine and version (candidates: Godot, Unity, web with Phaser or Three.js)
- TODO: language (GDScript, C# or TypeScript) and asset tools
