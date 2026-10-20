# 03 · Game dev

**Shortcut:** `/game-feature <mechanic or system>` in a project session.

Games are harder for Claude than web apps for one reason: **it can't feel the game.**
So this pipeline is mostly about making the game *checkable*.

Go deeper:
- [Engine CLI commands](../knowledge/gamedev/engine-cli-commands.md): headless runs, tests and builds per engine
- [Architecture for Claude](../knowledge/gamedev/architecture-for-claude.md): structuring a game so Claude can test it

## Choose an engine with Claude in mind

| Engine            | How well Claude handles it | Notes |
|-------------------|------------------|-------|
| Web (Phaser, Three.js, Canvas, PixiJS) | Very well | Everything is code. Claude can run it in a browser and take screenshots. |
| Godot             | Well | GDScript and `.tscn` scenes are plain text that Claude can read and edit. |
| Unity             | Partly | C# scripts are fine. Scenes and prefabs are huge YAML files, so do that work in the editor. |
| Unreal            | Partly | C++ is fine. Blueprints are binary, so Claude can't edit them. |

Record the choice as a decision note (`knowledge/decisions/YYYY-MM-DD-engine.md`).

## Set up once per project

`/new-project <name> game` copies these from `templates/game/` (existing files are kept):

| File | What it does |
|---|---|
| `CLAUDE.md` | Fill-in template: engine, commands, folder map, what not to touch |
| `.claude/settings.json` | Allows `npm run dev/build/test` and `npm test` (Bash and PowerShell twins); denies reading `.env` files. Add your engine's test command the same way |
| `.claude/rules/game-core.md` | Pure-logic rules that load only when Claude touches `src/core/` |
| `.mcp.json` | Empty. Add a server only when you need one (for a web game, the Playwright entry from `templates/nextjs/.mcp.json`) |
| `.gitattributes` | Git LFS lines for common binary assets, commented out until you enable LFS |
| `docs/design/_template.md` | The feature spec template |

### Git LFS for binary assets
Art, audio and video bloat a normal git repo fast. Git LFS stores them separately.
```powershell
git lfs version          # Git for Windows usually includes Git LFS
git lfs install          # once per machine
```
Then uncomment the lines in `.gitattributes` for the file types you use and commit
`.gitattributes` **before** the first commit that adds those assets. Check with
`git lfs ls-files`. Everyone who clones the repo needs Git LFS too.
Tell Claude in `CLAUDE.md` not to edit binary assets.

## Architecture that helps a lot

1. **Separate logic from rendering.** Keep the rules (movement, combat math, inventory,
   AI decisions) in plain functions or classes with no engine calls, in `src/core/`. These can
   be unit-tested, and tests are how Claude verifies its work.
2. **Data-driven content.** Put enemies, items and levels in JSON or resource files. Claude
   edits data more safely than code.
3. **Deterministic simulation.** A seeded RNG and a fixed timestep make bugs reproducible
   ("seed 42, frame 300, the player clips through the wall").
4. **Debug hooks.** A debug overlay, a key to skip to a level, and a console command to spawn X.
   These make it quick to check a feature by hand.

## Feature pipeline

### 1. Design (you own this)
```powershell
Copy-Item docs\design\_template.md docs\design\dash.md
```
Fill in the player goal, rules, tunable numbers, edge cases and what "fun" should feel like.
Claude implements specs well but invents designs poorly. `/game-feature` drafts a spec if
none exists, but it waits for your approval.

### 2. Explore
How do similar systems work now? Where do the game loop, input and state live?

### 3. Plan
`/plan <feature>`. Split it into **logic** (testable) and **presentation** (needs eyes).
Wait for your OK.

### 4. Implement
1. Data and tunables first
2. Logic + unit tests
3. Hook into the game loop
4. Visuals, sound, feedback ("juice")

### 5. Verify
- **Automated:** unit tests for the logic in `src/core/`.
- **Command line:** Godot runs scripts with `--headless` and tests with GUT; Unity runs tests
  with `-batchmode -runTests`; web games typically use Vitest (`npx vitest run`, never watch
  mode, which doesn't exit). The exact commands are in
  [engine-cli-commands.md](../knowledge/gamedev/engine-cli-commands.md). Test them once, then
  put the ones your project uses in its `CLAUDE.md` and allow them in `.claude/settings.json`
  (Bash and PowerShell twins).
- **Web games:** ask Claude to start the dev server in the background (or `! npm run dev`,
  then Ctrl+B), then open the game with the Playwright MCP or `/run`, read the console and
  take screenshots.
- **You playtest.** See the loop below.

### 6. Playtest loop

```
 play (one focus) ──► notes: did → happened → expected
      ▲                          │
      │                          ▼
      │               playtester agent ──► tuning table
      │                                         │
      │                                         ▼
 commit if better ◄── Claude edits data/ ◄── you pick 1-2 changes
```

1. **Play with one focus** ("the dash", not "everything").
2. **Write notes** as *what you did → what happened → what you expected*, with numbers when
   you can: "Dashed into a wall at full speed → went through it → should stop at the wall".
   Paste them into the chat, or keep them in a file such as `docs/playtests/YYYY-MM-DD.md`.
   For a screenshot: Win+Shift+S, then **Alt+V** in Claude Code.
3. **Ask the agent:** "Use the playtester agent on these notes." It returns a table:
   complaint | variable | file:line | current | proposed | why. It doesn't edit anything.
4. **Pick one or two changes** per complaint. Claude edits the data files, not the logic.
5. **Play again.** Commit each round that feels better.
6. **Record it (optional):** in a hub session, `/project-report <game> playtest`.

## Folder layout that works well

```
game/
├── CLAUDE.md
├── .claude/rules/game-core.md   ← loads when Claude touches src/core/
├── docs/
│   ├── design/                  ← _template.md + one spec per feature
│   └── playtests/               ← dated playtest notes (optional)
├── src/
│   ├── core/                    ← pure logic (no engine imports) + tests
│   ├── systems/                 ← engine-facing glue
│   └── scenes/
├── data/                        ← JSON / resources: enemies, items, levels
└── assets/                      ← art & audio in Git LFS (tell Claude not to edit these)
```
