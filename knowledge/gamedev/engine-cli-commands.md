---
title: Engine CLI commands for headless runs and tests
tags: [gamedev, godot, unity, vite, vitest, testing, cli]
updated: 2026-10-20
---

# Engine CLI commands for headless runs and tests

**TL;DR:** Claude can only verify a game through commands that run without a person: Godot
`--headless` with GUT, Unity `-batchmode -runTests` (without `-quit`), and Vitest for web games.
Each command below is marked **verified** (checked against official docs on 2026-10-20) or
**unverified**.

Put the working commands for your project into its CLAUDE.md, and allow them in
`.claude/settings.json` (Bash and PowerShell twins).

## Godot 4

The Windows download is a plain `.exe` (e.g. `Godot_v4.x-stable_win64.exe`). Put its folder on
PATH or call it by full path with `&` in PowerShell. Below, `godot` means that executable.

| Goal | Command | Status |
|---|---|---|
| Run the project (main scene) | `godot --path .` | verified |
| Open the editor | `godot -e --path .` | verified |
| Import resources, then quit | `godot --headless --path . --import` | verified |
| Run a script without a window | `godot --headless --path . -s res://tools/check.gd` (script must extend `SceneTree` or `MainLoop`) | verified |
| Parse a script for errors only | `godot --headless --path . --check-only -s res://tools/check.gd` | verified |
| Smoke test: run N frames, quit | `godot --headless --path . --quit-after 600` | verified flags |
| Export a release build | `godot --headless --path . --export-release "Windows Desktop" build/game.exe` | verified |
| Verbose / debug output | add `--verbose`; `-d` enables the local stdout debugger | verified |

Notes:

- `--headless` = no display and a dummy audio driver. It is required for export on machines
  without a GPU (CI) and stops a window from opening otherwise.
- Export needs an export preset (`export_presets.cfg`, safe to commit) and installed export
  templates. Use an absolute output path or one relative to the project folder; the target
  folder must already exist (`New-Item -ItemType Directory -Force build`).
- `--export-debug` and `--export-pack` imply `--import`.
- **Unverified:** the Windows zip also ships a `*_console.exe` variant that keeps output in the
  terminal. Not covered on the Godot command-line docs page; check your download.

### Running GUT tests (Godot 4, GUT 9.x)

GUT's documented command line (GUT 9.x targets Godot 4.x):

```powershell
godot -d -s --path . addons/gut/gut_cmdln.gd -gdir=res://test -ginclude_subdirs -gexit
godot -s addons/gut/gut_cmdln.gd -d --path . '-gtest=res://test/unit/test_combat.gd' -gexit
```

In Windows PowerShell 5.1, quote any `-gxxx=...` argument that contains a dot (as above): 5.1 can
split `-gjunit_xml_file=results.xml` into two arguments at the dot (tested).

| Option | Meaning |
|---|---|
| `-gdir=res://test` | Folder(s) with test scripts; `-ginclude_subdirs` to recurse |
| `-gtest=res://...gd` | Run one test script |
| `-gselect=name` | Only scripts whose name matches |
| `-gexit` | Quit when done (otherwise the window stays open) |
| `-gjunit_xml_file=<file>` | Write JUnit XML results to that file |
| `-gh` | List every option |

- Exit code: `0` when all tests pass, `1` if any fail (pending tests don't count). **Verified.**
- Options can also live in `res://.gutconfig.json`; command-line options win. **Verified.**
- Adding `--headless` to the GUT command (so no window opens) is a Godot flag documented as
  useful with `--script`, but GUT's own docs don't show the combination. **Unverified**: test it
  once in your project, then put the exact command in CLAUDE.md.

## Unity

Editor path for a Hub install (as shown in Unity's docs): `"C:\Program Files\Unity\Hub\Editor\<version>\Editor\Unity.exe"`.
Close the Editor first; a second Unity instance cannot open the same project.

```powershell
$unity = "C:\Program Files\Unity\Hub\Editor\<version>\Editor\Unity.exe"
# EditMode tests. Do NOT add -quit: it is not supported while tests run.
& $unity -batchmode -projectPath . -runTests -testPlatform EditMode -testResults "$PWD\TestResults\editmode.xml" -logFile -
# PlayMode tests in the Editor
& $unity -batchmode -projectPath . -runTests -testPlatform PlayMode -testResults "$PWD\TestResults\playmode.xml" -logFile -
```

| Argument | Meaning | Status |
|---|---|---|
| `-batchmode` | No UI, no dialogs; needed for unattended test runs | verified |
| `-projectPath <path>` | Project to open (quote paths with spaces) | verified |
| `-runTests` | Run the project's tests (Unity Test Framework) | verified |
| `-testPlatform EditMode\|PlayMode` | Default is EditMode; a BuildTarget value runs PlayMode tests on a player | verified |
| `-testResults <file>` | Where to write the results XML | verified |
| `-testFilter`, `-testCategory`, `-assemblyNames` | Semicolon lists or regex to narrow the run | verified |
| `-logFile -` | Log to stdout (on Windows stdout is not the console by default) | verified |
| `-quit` | Quits after other commands; **not supported with `-runTests`** | verified |
| `-nographics` | Batch mode without a GPU | verified |
| `-executeMethod Ns.Class.Method` | Run a static editor method (builds, data prep); throw or `EditorApplication.Exit(1)` to fail | verified |
| `-buildTarget <target>` | Active build target at launch | verified |

Exit codes: Unity's test docs say there is no common definition for exit codes from the
components under test (**verified**). Have Claude read the results XML (NUnit format; written to
the project root if `-testResults` is omitted) and the log, not just the exit code.

## Web games (Vite + Vitest)

| Goal | Command | Status |
|---|---|---|
| New project | `npm create vite@latest my-game -- --template vanilla-ts` (the `--` is needed with npm 7+) | verified |
| Dev server | `npm run dev` (runs `vite`; default port 5173, next free port if taken) | verified |
| Fixed port, fail if taken | `npx vite --port 5173 --strictPort` | verified |
| Production build | `npx vite build` | verified |
| Preview the build | `npx vite preview` (local preview only, not a production server) | verified |
| Run tests once | `npx vitest run` | verified |
| Tests covering given files | `npx vitest related --run src/core/combat.ts` | verified |
| Watch mode | `npx vitest` (watches in a dev terminal, runs once in CI or non-interactive shells) | verified |

- Always give Claude `vitest run` (or `--run`) so the command exits.
- For visual checks, run the dev server in the background (Ctrl+B) and use the Playwright MCP
  server or `claude --chrome` to open the page and take screenshots
  (see [MCP servers](../claude-code/mcp-servers.md)).

## Sources

- Godot: https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html and
  https://docs.godotengine.org/en/stable/tutorials/export/exporting_projects.html
- GUT: https://gut.readthedocs.io/en/latest/Command-Line.html
- Unity: https://docs.unity3d.com/Manual/test-framework/reference-command-line.html and
  https://docs.unity3d.com/Manual/EditorCommandLineArguments.html
- Vite: https://vite.dev/guide/cli ; Vitest: https://vitest.dev/guide/cli

Related: [Game architecture that Claude can work with](architecture-for-claude.md).
