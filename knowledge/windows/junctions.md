---
title: Junctions for linked project folders
tags: [windows, junction, symlink, powershell, node, workspace-app]
updated: 2026-10-22
claude_code_version: 2.1.307
---

# Junctions for linked project folders

TL;DR: The workspace app links a checkout that lives elsewhere (for example on the Desktop) as
`projects/<name>` with a directory junction: no admin rights, nothing moved. Remove a junction
only with the app's **Unlink** or `cmd /c rmdir projects\<name>` (no `/s`). Don't use
`Remove-Item` on it in Windows PowerShell 5.1: some builds delete the target's contents.

## How a junction behaves

| Fact | Detail |
|---|---|
| What it is | A directory reparse point that redirects to an absolute folder on a local volume. `dir` shows `<JUNCTION>` |
| Rights | No admin rights or developer mode needed (unlike a directory symlink) |
| Target | Absolute, local drive only. No network paths |
| Node | `fs.symlinkSync(target, link, 'junction')` makes one. `lstatSync(link).isSymbolicLink()` and `Dirent.isSymbolicLink()` are `true`; `statSync` follows it; `realpathSync.native` gives the target's real path |
| Removing | `fs.rmdirSync(link)` (non-recursive) removes the junction itself; the target is untouched |
| Tools that walk folders | Anything that follows links walks into the target. The hub's tools skip `projects/` or only read a project's top files |

## Deleting a junction safely

Tested on Windows 11 with Windows PowerShell 5.1.26100 on a scratch junction to a folder with
files in a subfolder:

| Command on the junction | Result here |
|---|---|
| `cmd /c rmdir <link>` | Removed only the link. Target intact |
| Node `fs.rmdirSync(<link>)` (the app's Unlink) | Removed only the link. Target intact |
| `Remove-Item <link> -Recurse [-Force]` | Removed only the link on this build. Target intact |
| `Remove-Item <link>` (no `-Recurse`) | Asks to confirm deleting the "children", which are the target's files |

Older Windows PowerShell 5.1 builds are reported to delete the target's contents with
`Remove-Item -Recurse`, and PowerShell 7 to remove only the link (neither tested here). Never
run `Remove-Item` on a junction: use one of the first two rows.

## How the app links and unlinks

`tools/lib/projects.mjs`:

- **Link** (`POST /api/projects/link`, "Link existing checkout" in Projects): refuses a name not
  in `projects/repos.json`, an existing `projects/<name>`, a relative, network or drive-root
  path, a folder inside the hub (or one that contains it), a folder that is not the top of its
  git checkout (`git rev-parse --show-toplevel`), and an `origin` that doesn't match the
  repos.json URL (`git@host:o/r` equals `https://host/o/r`). Then it creates the junction and
  checks that it leads to that folder.
- **Unlink** (`POST /api/projects/unlink`): refuses anything that is not a link, then
  `fs.rmdirSync(link)` only. Never recursive, never `rm`.
- **Launches** (Claude, flows, skills, agents, the editor) use `realProjectDir()`: the checkout's
  real path. Claude Code stores sessions by working folder
  ([docs](https://code.claude.com/docs/en/sessions)), so app sessions line up with the ones you
  start in the checkout by hand, and the hub's `CLAUDE.md` should not load there because the
  checkout is not under the hub (unverified until checked with `/memory` in such a session).
