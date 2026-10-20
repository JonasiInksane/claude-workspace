# Next.js template

Starter Claude Code files for a Next.js project. `node tools/new-project.mjs <name> --type nextjs`
(or `/new-project <name> nextjs` in a hub session) copies everything here except this README
into `projects/<name>/`, never overwrites an existing file, and replaces `{{PROJECT_NAME}}`
with the project name.

| File | What it does | Change it when |
|---|---|---|
| `CLAUDE.md` | Fill-in project instructions: stack, commands, folder map, env var names, what not to touch | Always: fill it in, or run `/onboard-project` |
| `.claude/settings.json` | Allows `npm run dev`, `build`, `lint`, `test`, plus `npm test` and `npx tsc --noEmit`, as Bash **and** PowerShell rules; denies reading `.env`, `.env.local`, `.env.*.local`, `.env.production`, `.env.development` and `.env.test` in any folder; runs the format hook | The project uses pnpm, yarn or bun, or names its scripts differently |
| `.claude/hooks/format-file.mjs` | After each Edit or Write, runs Prettier on that one file, only if `package.json` lists `prettier` and it is installed in `node_modules` | Rarely |
| `.claude/rules/nextjs.md` | Next.js rules that load only when Claude reads or edits files under `app/`, `src/` or `components/` | Your code lives elsewhere (e.g. `apps/web/**` in a monorepo) |
| `.mcp.json` | The Playwright MCP server, so Claude can open pages, read the console and take screenshots | You don't want a browser tool |
| `.worktreeinclude` | Copies `.env.local` into worktrees created with `claude -w <name>` | You use other gitignored env files |

## Other package managers

Read the package manager from the lockfile and change **both twins** of every allow rule:

| Lockfile | Rules |
|---|---|
| `package-lock.json` | `Bash(npm run build *)`, `PowerShell(npm run build *)`, ..., `Bash(npx tsc --noEmit)` (as shipped) |
| `pnpm-lock.yaml` | `Bash(pnpm run build *)`, `PowerShell(pnpm run build *)`, ..., `Bash(pnpm exec tsc --noEmit)`, `PowerShell(pnpm exec tsc --noEmit)` |
| `yarn.lock` | `Bash(yarn run build *)`, `PowerShell(yarn run build *)`, ..., `Bash(yarn tsc --noEmit)`, `PowerShell(yarn tsc --noEmit)` |
| `bun.lock` / `bun.lockb` | `Bash(bun run build *)`, `PowerShell(bun run build *)`, ..., `Bash(bunx tsc --noEmit)`, `PowerShell(bunx tsc --noEmit)` |

Update the commands in `CLAUDE.md` to the same forms, so the rules match what Claude runs.

## Notes

- **Twins.** On Windows Claude Code can run a command through Bash or PowerShell, and a Bash
  rule doesn't cover PowerShell. Every allow rule needs both.
- **Scripts are allowed one by one** (dev, build, lint, test), never `npm run *`, which would
  also approve deploy, migrate or reset scripts in a cloned repo. Add the other safe scripts
  your project has the same way. Rules are checked deny first, then ask, then allow.
- **Deny rules use bare names** (`Read(.env)`), which match in every folder, so a monorepo's
  `apps/web/.env.local` is covered too. `Read(./.env)` would only cover the project root.
- **Trust.** Allow rules in a committed `.claude/settings.json` apply only after the folder's
  trust dialog is accepted; deny rules apply right away. The `.mcp.json` server asks for
  approval in the first interactive session.
- **Personal rules** go in `.claude/settings.local.json`, which is not committed. Add
  `.claude/settings.local.json`, `CLAUDE.local.md` and `.claude/worktrees/` to the project's
  `.gitignore` if they aren't there yet.
- **The format hook** is exec form (`node` plus the script path), so it runs the same way
  with or without Git Bash. It never downloads Prettier and always exits 0. Remove the
  `hooks` block from `settings.json` if you don't want it.
- **Playwright MCP on Windows.** If the server fails to start with `"command": "npx"`, try
  `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@playwright/mcp@latest"]`.
- **Worktrees.** `claude -w <name>` creates a git worktree under `.claude/worktrees/`. Run the
  install command again inside it.
