# 01 · Onboard an existing project

**Goal:** Claude understands a codebase it has never seen, and that understanding is
saved in `CLAUDE.md` so you never pay for it twice.

**Shortcut:**
1. Hub session: `/new-project my-app nextjs https://github.com/you/my-app.git`
2. `cd projects\my-app; claude`
3. `/onboard-project`

## Stages

### 1. Clone it with the template
In a hub session (Claude started in the workspace root):
```text
/new-project my-app nextjs https://github.com/you/my-app.git
```
Use `game` instead of `nextjs` for a game. Without Claude, run the tool directly:
```powershell
node tools/new-project.mjs my-app --type nextjs --from https://github.com/you/my-app.git
```
This clones the repo into `projects\my-app` and copies the starter files from
`templates/nextjs/` (or `templates/game/`) into it. A file the repo already has is
**kept**, never overwritten; the output lists each file as "added" or "kept (exists)".
See [templates/README.md](../templates/README.md) for what each template contains.

Then install and branch yourself:
```powershell
cd projects\my-app
npm install                      # or pnpm / yarn / bun: whatever the lockfile says
git switch -c claude/onboarding
```

### 2. Start Claude in the project and trust it
```powershell
claude
```
The first time, Claude Code asks whether you trust this folder. Trust only repos you know.
Until you accept, allow rules from the committed `.claude/settings.json` don't apply
(deny rules always do). Servers in the project's `.mcp.json` each ask for your approval.
The hub's `CLAUDE.md` loads here too (it's in a parent folder). Its `@context/...` imports
point outside the project folder, so Claude Code may ask once to approve them. Approve it,
or your `context/` files won't load in project sessions.

### 3. Explore (read-only)
Ask for a map, not a dump:
> Use the code-explorer agent to map this project: entry points, folder roles,
> data flow, how to run/build/test, and anything surprising. Don't edit anything.

Done when you can answer "where would I add a new page/feature/endpoint?"

### 4. Verify the commands
Have Claude actually run the dev, build, test and lint commands it found. Note which ones
fail before any changes. That's your baseline, so later failures aren't blamed on Claude.

### 5. Write `CLAUDE.md`
Three ways, from most to least guided:
- **`/onboard-project`** (library skill): explores, verifies commands, drafts `CLAUDE.md`
  and settings, and waits for your approval before writing.
- **`/init`** (built-in): creates a starter `CLAUDE.md`, or suggests improvements to an existing one.
- **The template:** if the repo had no `CLAUDE.md`, step 1 copied a fill-in template. Fill it in.

Then cut it down. Keep:
- the commands that actually work
- a folder map (one line per important folder)
- the conventions Claude would get wrong without being told
- "don't touch" zones (generated code, vendored libs, migrations)

**If the repo has an `AGENTS.md`** (used by Codex and other tools): make `@AGENTS.md` the
first line of `CLAUDE.md` and put only Claude-specific notes below it. Claude Code reads
`AGENTS.md` on its own only when no `CLAUDE.md` exists in the folder or any folder above it.
Inside `projects/` the hub's `CLAUDE.md` is always above, so without that import a project's
`AGENTS.md` never loads. Don't symlink the two files on Windows.
Check right after step 1: the template may have just added a `CLAUDE.md`.

### 6. Tune `.claude/settings.json`
The template already allows the usual commands and denies reading `.env` files.
- Allow the commands you verified in step 4, one script at a time, for **both** shells:
  `"Bash(npm run build *)"` and `"PowerShell(npm run build *)"`. Avoid `npm run *`: it would
  also approve deploy, migrate or reset scripts.
- If the project doesn't use npm, change the rules to its package manager.
- Personal or experimental rules go in **`.claude/settings.local.json`**. It applies on top of
  the shared file, for you only (permission lists from both files are combined). Add it to the
  project's `.gitignore`: Claude Code only excludes it automatically when it created the file itself.
- Personal notes for Claude go in **`CLAUDE.local.md`** (loads after `CLAUDE.md`). Gitignore it too.

### 7. Do a small first task
Pick a small real bug or tweak and run the full core loop on it. Whatever Claude gets wrong
tells you what's missing from `CLAUDE.md` or `.claude/rules/`.

### 8. Commit the setup
Commit: `CLAUDE.md`, `.claude/settings.json`, `.claude/rules/`, `.claude/hooks/`, `.mcp.json`
and `.worktreeinclude`. Add to `.gitignore`: `.claude/settings.local.json`, `CLAUDE.local.md`,
and `.claude/worktrees/` (used by `claude -w`). Never commit `.env*` files with values.

### 9. Record it (optional)
In a hub session: `/project-report my-app onboarding`. It writes a dated report to `reports/`
and adds it to the dashboard.

## Prompts that work

- "Before answering, read the files involved. Cite file:line for claims."
- "What would break if I changed X? Search for every usage."
- "Explain this module like I'll be maintaining it tomorrow."
