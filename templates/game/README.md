# Game template

Starter Claude Code files for a game project, engine-neutral (web game, Godot or Unity).
`node tools/new-project.mjs <name> --type game` (or `/new-project <name> game` in a hub
session) copies everything here except this README into `projects/<name>/`, never
overwrites an existing file, and replaces `{{PROJECT_NAME}}` with the project name.

| File | What it does | Change it when |
|---|---|---|
| `CLAUDE.md` | Fill-in project instructions: engine, commands, folder map, conventions, what not to touch | Always: fill it in, or run `/onboard-project` |
| `.claude/settings.json` | Allows `npm run dev`, `build`, `test` and `npm test` as Bash **and** PowerShell rules; denies reading `.env`, `.env.local`, `.env.*.local`, `.env.production`, `.env.development` and `.env.test` in any folder | You pick an engine (add its test command) or another package manager |
| `.claude/rules/game-core.md` | Pure-logic rules (no engine calls, seeded RNG, data-driven, tested) that load only when Claude reads or edits `src/core/` | Your logic lives in another folder |
| `.mcp.json` | No servers. For a web game, add the Playwright entry from `templates/nextjs/.mcp.json` | You need a browser or engine tool |
| `.gitattributes` | Line-ending rules, plus Git LFS lines for binary assets, commented out with the steps to enable LFS | Before the first asset commit |
| `docs/design/_template.md` | Feature spec: player goal, rules, tunables with defaults, edge cases, feel target, acceptance checks | Copy it per feature: `Copy-Item docs\design\_template.md docs\design\dash.md` |

## Adding engine commands to the allow list

Read-only git commands already run without a prompt. Add the test and build commands you
verified, each as a Bash **and** a PowerShell rule (on Windows Claude Code can use either
shell, and a Bash rule doesn't cover PowerShell). Examples:

| Engine | Rules |
|---|---|
| Web game (Vitest) | `Bash(npx vitest run *)`, `PowerShell(npx vitest run *)` |
| Godot + GUT (on PATH as `godot`) | `Bash(godot -d -s --path . addons/gut/gut_cmdln.gd *)` and the same as `PowerShell(...)` |
| Unity | The exact test command you verified, written out in full, as both twins |
| Other package managers | swap `npm run build *` for `pnpm run build *`, `yarn run build *` or `bun run build *` (each script, both twins) |

The exact headless commands per engine are in the workspace note
`knowledge/gamedev/engine-cli-commands.md`.

## Notes

- **The folder layout** the rules assume: `src/core/` (pure logic and tests), `src/systems/`
  (engine glue), `data/` (tunables), `docs/design/` (specs), `assets/` (binary art and audio).
  If your engine wants a different layout, update the `paths:` in `.claude/rules/game-core.md`
  and the Architecture section of `CLAUDE.md`.
- **Scripts are allowed one by one** (dev, build, test), never `npm run *`, which would also
  approve a deploy or reset script. Add other safe scripts the same way (both twins).
- **Trust.** Allow rules in a committed `.claude/settings.json` apply only after the folder's
  trust dialog is accepted; deny rules apply right away.
- **Personal rules** go in `.claude/settings.local.json` (not committed). Add it and
  `CLAUDE.local.md` to the project's `.gitignore`.
- **Engine ignores.** Godot 4: ignore `.godot/`. Unity: ignore `Library/`, `Temp/`, `Obj/`,
  `Logs/`, `UserSettings/`, and commit every `.meta` file.
