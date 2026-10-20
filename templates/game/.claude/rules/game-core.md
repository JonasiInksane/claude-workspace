---
paths:
  - "src/core/**"
---

# Pure game logic (src/core/)

Code in `src/core/` is the game's rules: movement math, combat, inventory, AI decisions,
progression, save data. It must run and be tested without the engine.

## No engine, no side effects
- No engine imports or engine objects. Web: nothing from `phaser`, `three`, `pixi.js`, the DOM
  or `window`. Godot: plain classes (`RefCounted`), not `Node`; no `get_tree()`, `Input` or
  scene access. Unity: plain C# classes, not `MonoBehaviour`; keep `UnityEngine` calls out.
- No rendering, audio, input reading, file or network access, logging to the console, or
  timers. The engine layer (`src/systems/`) passes input in and applies results.
- No global mutable state or singletons. Pass state in, return the new state (or mutate only
  the object you were given, if the project prefers that; be consistent).

## Deterministic
- Randomness only through a seeded RNG that is passed in. Never `Math.random()`, `randf()`,
  `randi()` or `UnityEngine.Random` here.
- Time only through a `dt` or tick count passed in, from a fixed timestep. Never read the clock.
- Same state + same input + same seed = same result. Tests rely on this.

## Data-driven
- No magic numbers. Speeds, timings, damage, cooldowns and spawn rates come from data
  (`data/` files or a config object passed in), with units in the name or a comment
  (`dashSpeedPxPerSec`, `cooldownSec`).
- Defaults in code are allowed only as the fallback that matches the data file.

## Tested
- Every public function or rule gets unit tests, next to the code or in the project's test
  folder. Cover the edge cases and acceptance checks from `docs/design/<feature>.md`.
- Test names say the rule: `dash stops at walls`, `cooldown blocks a second dash`.
- Run the tests after each change, with the command from CLAUDE.md (never watch mode).

## Shape
- Small, pure functions and plain data types. State must be serializable (save games, replays).
- If a change needs an engine call, put a small interface in `src/core/` and the engine
  implementation in `src/systems/`.
