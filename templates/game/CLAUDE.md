<!--
Fill-in template. Replace every <...>, delete lines that don't apply, and keep the file
under about 120 lines. HTML comments like this one are stripped before Claude reads the file.
Running /onboard-project in this folder fills it in for you.
AGENTS.md: if the repo has one, make the first line of this file an at-sign followed by
AGENTS.md (an import). Once a CLAUDE.md exists, Claude Code stops reading AGENTS.md on its own.
-->
# {{PROJECT_NAME}}

<One paragraph: genre, core loop, target feel, target platform.>

## Stack
- Engine: <Phaser 3 | Three.js | Godot 4.x | Unity 6 | ...>
- Language: <TypeScript | GDScript | C#>
- Tests: <Vitest | GUT | Unity Test Framework>
- Package manager (web games): <npm | pnpm | yarn | bun>. Use only this one.

## Commands
<!--
Examples (check each one once, then keep only the ones that work here):
Web game:  npm run dev   |   npx vitest run   |   npm run build
Godot:     godot --path .   |   godot -d -s --path . addons/gut/gut_cmdln.gd -gdir=res://test -gexit
Unity:     Unity.exe -batchmode -projectPath . -runTests -testPlatform EditMode -testResults TestResults/editmode.xml -logFile -
           (no -quit with -runTests; close the Editor first; read the results file)
Add each command to .claude/settings.json as a Bash and a PowerShell allow rule.
-->
- Run: `<...>`
- Test: `<...>` (must exit on its own; never a watch mode)
- Build: `<...>`

Done means: the tests pass and you gave me a playtest checklist. I check the feel myself.

## Architecture
- `src/core/`: pure game logic, no engine imports, all unit-testable. Rules in `.claude/rules/game-core.md`.
- `src/systems/`: engine-facing code (rendering, input, physics glue).
- `data/`: tunables and content (JSON or engine resources). Change numbers here, not in code.
- `docs/design/`: one spec per feature, from `docs/design/_template.md`. Read the relevant one before implementing.
- `assets/`: art and audio (binary; Git LFS once it is enabled in `.gitattributes`).

## Conventions
- Fixed timestep: <60> ticks per second. Seeded RNG via `<rng module>`; log the seed.
- Units: <pixels | meters> and seconds. Write the unit next to every tunable.
- <scene structure, signals or events, naming>

## Do not touch
- Binary files in `assets/` (images, audio, models, fonts).
- <Godot: `.godot/`, `*.import`, `*.uid`. Unity: `Library/`, `Temp/`, every `.meta` file.>
- <Engine-serialized scenes and prefabs (`*.unity`, `*.prefab`). Ask me to make those changes in the editor. Godot `.tscn`: small edits only.>

## Debug tools
- <F1 = debug overlay, ~ = console, `spawn <enemy>`, level-skip keys, start-in-state flags>
- <Log and screenshot folders, e.g. `user://logs/`>

## Known issues
- <baseline test failures, performance problems>
