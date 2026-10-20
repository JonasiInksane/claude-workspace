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

## Web (Next.js)
- TODO: Next.js version and router (App Router or Pages Router)
- TODO: package manager (npm or pnpm), styling (e.g. Tailwind), UI library
- TODO: data and auth (database, ORM, auth provider), hosting (e.g. Vercel)
- TODO: tests (e.g. Vitest, Playwright)

## Games
- TODO: engine and version (candidates: Godot, Unity, web with Phaser or Three.js)
- TODO: language (GDScript, C# or TypeScript) and asset tools
