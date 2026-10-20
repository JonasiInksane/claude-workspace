---
name: game-feature
description: Implement a game mechanic or system with explore, spec and plan (wait for approval), implement, verify and wrap up, keeping logic testable and separate from presentation. Use when adding or changing gameplay, systems, AI, UI or content in a game project (web game, Godot, Unity or another engine).
argument-hint: "[mechanic or system]"
---

# Game feature

Build one mechanic so its rules are tested code, its numbers are data the user can tune,
and its feel is checked by the user in a playtest.

The request: $ARGUMENTS

If that is empty, use the user's latest request. If it is still unclear, ask one short
question before exploring.

## 1. Explore (read only)
- CLAUDE.md is already loaded; follow it. Also read `.claude/rules/` files that apply.
- Engine and language: `project.godot` = Godot (GDScript or C#),
  `ProjectSettings/ProjectVersion.txt` = Unity (C#), package.json with `phaser`, `three`,
  `pixi.js`, `kaplay` or `excalibur` = web game.
- Web games: the package manager comes from the lockfile (`package-lock.json` = npm,
  `pnpm-lock.yaml` = pnpm, `yarn.lock` = yarn, `bun.lock`/`bun.lockb` = bun). Use only that one.
- Find the game loop, input handling, state, the data files (`data/`) and the most similar
  existing system. Read it fully and reuse its patterns.
- Find the tests and how they run (CLAUDE.md first, then package.json, `addons/gut/`,
  Unity test assemblies).
- Look for a spec: `docs/design/<feature>.md`.
- For a large or unfamiliar codebase, delegate the mapping to the `code-explorer` agent if it exists.

## 2. Spec and plan, then WAIT
The user owns the design. If no spec exists, draft one in chat using the fields of
`docs/design/_template.md` (or, if that is missing: player goal, rules, tunables with
defaults and units, edge cases, feel target, acceptance checks). Don't invent the design
silently; mark every guess as a guess.

Then present the plan and stop until the user approves both:

```markdown
## Plan: <feature>
- Logic (pure, no engine calls, unit-tested): `src/core/...` - what
- Data (tunables): `data/...` - names and defaults
- Integration: where it hooks into the loop or scene
- Presentation: visuals, animation, audio, UI feedback
- Tests: which cases (from the acceptance checks)
- Verify with: <exact commands>
```

## 3. Implement
After approval, save the spec to `docs/design/<feature>.md` if it was new, then:
1. Data and tunables (with units).
2. Logic with unit tests, in `src/core/` or the project's equivalent.
3. Integration into the game loop or scene.
4. Presentation and feedback.

Rules:
- No magic numbers in logic. Read them from data.
- Randomness goes through a seeded RNG that is passed in. Simulation uses a fixed timestep.
- Stay inside the approved plan. If it has to change, say so and wait again.

## 4. Verify
- Run the unit tests. Use the commands in CLAUDE.md first. Typical forms:
  - Web game: `npx vitest run` (or the `pnpm exec`/`bunx` equivalent; never watch mode).
  - Godot with GUT: `godot -d -s --path . addons/gut/gut_cmdln.gd -gdir=res://test -gexit`.
  - Unity: `Unity.exe -batchmode -projectPath . -runTests -testPlatform EditMode -testResults <file> -logFile -`
    (no `-quit`; read the results file). The Unity Editor must be closed.
- Web games: start the dev server in the background, and if a browser tool is available
  (for example the Playwright MCP server), open the game, check the console and take a screenshot.
- Engine games: say what you could not check, since Claude can't see the editor or feel the game.

## 5. Wrap up
- Ask the `code-reviewer` agent to review the diff (if it exists). Fix its high findings.
- Don't commit unless the user asks.
- Report:

```markdown
## Done: <feature>
| Tunable | File | Default | Unit | What it changes |
|---|---|---|---|---|

Playtest checklist (try these, expect this):
- [ ] <action> -> <expected result>
- [ ] <edge case> -> <expected result>

Verified: unit tests 8/8 pass. Not verified: feel, visuals in the editor.
```

Offer at most 3 next steps, for example: playtest with the checklist, then give the notes to
the `playtester` agent for numeric tuning proposals; commit.

## What not to do
- **Don't design the feature for the user.** Draft, mark guesses, wait for approval.
- **Don't put engine calls in pure logic** (`src/core/`): no nodes, scenes, input, rendering or audio.
- **Don't use unseeded randomness** (`Math.random()`, `randf()` without a seeded generator) in logic.
- **Don't edit binary assets** (images, audio, models, fonts).
- **Don't hand-edit engine-generated files**: Godot `.import`/`.uid` files and `.godot/`,
  Unity `.meta` files, `Library/`, and Unity scenes or prefabs unless the user asks. Keep
  Godot `.tscn` edits small.
- **Don't run watch-mode test commands**; they never exit.
- **Don't claim it feels right.** Only the user's playtest can say that.
