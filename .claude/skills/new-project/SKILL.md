---
name: new-project
description: Creates a project folder under projects/ from the Next.js or game template, optionally cloning a git URL first, by running tools/new-project.mjs, then explains the next steps. Use when the user says "new project", "start a new Next.js app", "start a new game", "clone <url> into projects", or "set up a project from the template".
argument-hint: "<name> <nextjs|game> [git-url]"
---

# New project

Scaffold `projects/<name>` with the workspace script and tell the user how to start working in it.

Arguments: `$ARGUMENTS`. Expected: a name, a type (`nextjs` or `game`), and optionally a git URL to clone.

## Step 1: Check the inputs
- **Name**: kebab-case only (lowercase letters, digits, hyphens, e.g. `space-miner`). If it isn't, suggest a kebab-case version and ask.
- **Type**: `nextjs` or `game`. If it's missing, ask. The game template is engine-neutral (Godot, Unity or a web engine all fit).
- **Git URL**: optional. Use it exactly as given; HTTPS URLs work without SSH keys.
- If the name, type or URL was guessed from the conversation rather than given, confirm them in one line before running anything.
- List `projects/`. If `projects/<name>` already exists and isn't empty, stop and tell the user (the script refuses too).
  Exception: re-running with the same `[git-url]` on a folder that is that clone is allowed; it only adds missing template files.

## Step 2: Run the script
Without a URL:

```powershell
node tools/new-project.mjs <name> --type <nextjs|game>
```

With a URL:

```powershell
node tools/new-project.mjs <name> --type <nextjs|game> --from <git-url>
```

- The script clones (with `--from`) or creates the folder and runs `git init`, then copies `templates/<type>/` into it. It never overwrites a file: each one is reported as `added` or `kept (exists)`.
- If it exits with an error, show the message and stop. Don't create the folder or copy templates by hand.

## Step 3: Reply
Use exactly this format, filled in from the script output:

```markdown
Created projects/<name> (<type>), <N> template files added, <M> kept.

Next steps (PowerShell):
    cd projects/<name>
    claude

Then, in that new session:
    /onboard-project
```

Add one line depending on the case:
- New project without `--from`: "There's no app code yet. In the new session, ask Claude to scaffold the app or engine project first, then run /onboard-project."
- Cloned project: "/onboard-project will map the existing code and fill in CLAUDE.md."
- If `/onboard-project` doesn't show up in the new session: "Run `node tools/install-library.mjs` in the workspace root once to install the global skills."

## What not to do
- **Don't run `npm install`, `create-next-app` or any other network command** from this skill. The only network call is the `git clone` inside the script.
- **Don't create folders or copy template files by hand.** Use `tools/new-project.mjs`.
- **Don't overwrite or "fix" files the script kept.** Existing files win.
- **Don't change the git URL** (for example HTTPS to SSH).
- **Don't start building the project from the hub session.** Each project gets its own session in its own folder.

## After
Suggest at most 3 next steps, for example:
- `cd projects/<name>; claude`, then `/onboard-project`.
- Later, from the workspace root: `/project-report <name> onboarding`.
- `node tools/build-index.mjs` to see the new project on the navigator dashboard.
