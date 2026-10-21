---
title: Launching programs from Node on Windows
tags: [windows, node, child-process, powershell, windows-terminal, edge]
updated: 2026-10-21
---

# Launching programs from Node on Windows

TL;DR: Find `wt.exe` with `lstatSync`, not `existsSync` (it is an app execution alias). Never
pass `windowsHide: true` to GUI programs. Don't spawn a console program `detached` and expect a
window: start it through `Start-Process`. Escape typographic quotes in PowerShell strings, and
treat `EACCES` on `listen()` like "port taken".

## Details

| Gotcha | What happens | Do this |
|---|---|---|
| `wt.exe` is an app execution alias (`%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`) | `fs.existsSync` gives `false` and `statSync` throws `EACCES`, but the file is there and spawns fine | Check PATH entries with `fs.lstatSync` (it succeeds on the alias) |
| `spawn(gui, args, { windowsHide: true })` | libuv sets `STARTF_USESHOWWINDOW` + `SW_HIDE`; a cold-started GUI app uses it for its first window, so an `msedge --app=...` window stays invisible | `windowsHide: false` for Edge, editors, Explorer, `wt.exe`; hide only short console helpers |
| `spawn('powershell.exe', [...], { detached: true })` | `detached` means `DETACHED_PROCESS`: no console at all. PowerShell exits at once (code 0) without running `-EncodedCommand` | Run a hidden, non-detached helper: `powershell -NoProfile -NonInteractive -EncodedCommand <Start-Process powershell.exe -WorkingDirectory '...' -ArgumentList '-NoExit','-EncodedCommand','...'>`. `Start-Process` gives the real session its own console |
| PowerShell single-quoted strings | `‘ ’ ‚ ‛` (U+2018 to U+201B) also end a `'...'` literal, so a path such as `Jonas’s PC` breaks the command, or injects one | Double those four characters as well as `'` |
| `explorer.exe` arguments | Splits its command line on commas, so `C:\a, b` opens the wrong folder (unverified; reported in review, not tested) | Pass `"<path>"` with `windowsVerbatimArguments: true` (Windows paths can't contain `"`) |
| `server.listen(port)` on a reserved port | Ports in a Hyper-V/WSL/Docker excluded range fail with `EACCES`, not `EADDRINUSE`. The ranges change at boot | Fall back to port `0` on both codes. List the ranges: `netsh int ipv4 show excludedportrange protocol=tcp` |

Also useful:
- Without `wt.exe`, `wt` options don't apply. With it, escape `;` in its arguments (`\;`): it is
  a command separator even inside quotes. Drop a trailing `\` from `-d <dir>`, otherwise it escapes
  the closing quote (`start.ps1` does the same).
- `-EncodedCommand` takes base64 of UTF-16LE: `Buffer.from(cmd, 'utf16le').toString('base64')`.
  No quoting problems between Node, `wt` and PowerShell.

## Example

```js
// Visible GUI program, independent of the parent:
spawn(edgePath, [`--app=${url}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();

// New PowerShell console that runs a command (no Windows Terminal):
const inner = Buffer.from(`Set-Location -LiteralPath 'C:\\dev'; & 'C:\\tool.exe'`, 'utf16le').toString('base64');
const start = `Start-Process -FilePath 'powershell.exe' -WorkingDirectory 'C:\\dev' -ArgumentList '-NoExit','-EncodedCommand','${inner}'`;
spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(start, 'utf16le').toString('base64')],
  { stdio: 'ignore', windowsHide: true });
```

The working code is `tools/workspace-app/launch.mjs`, and its tests are `tools/workspace-app/launch.test.mjs`.

## Source
- Found while building `tools/workspace-app/` on 2026-10-21 (Windows 11, Node 24.11.1, Windows
  PowerShell 5.1). Verified in that session:
  - the alias `existsSync`/`lstatSync` behaviour
  - `IsWindowVisible` false for an Edge `--app` window spawned with `windowsHide: true`
  - a detached PowerShell exiting without running its command, and the `Start-Process` fix running in a folder whose name has a space and a `’`
  - the PowerShell 5.1 parse error with `’`
  - `EACCES` when listening on a port inside an excluded range

  The Explorer comma behaviour is unverified.
