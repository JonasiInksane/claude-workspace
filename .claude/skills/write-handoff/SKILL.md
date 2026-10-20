---
name: write-handoff
description: Writes a handoff note for the current session to inbox/handoffs/YYYY-MM-DD-<slug>.md so a fresh session can pick up the work, and changes nothing else. Use when the user says "write a handoff", "hand this off", "wrap up for a new session", or before clearing a long session.
argument-hint: "[short topic for the file name]"
disable-model-invocation: true
---

# Write handoff

Capture where this session stands in one note, so a fresh session can continue without the chat history.

Topic: `$ARGUMENTS` (if empty, use the main task of this session).

## Step 1: Name the file
- Slug: the topic in kebab-case, at most 5 words (for example `auth-redirect-fix`).
- Path: `inbox/handoffs/<today>-<slug>.md` under the WORKSPACE ROOT, with today's local date, for example `inbox/handoffs/2026-10-20-auth-redirect-fix.md`.
- If this session runs inside `projects/<name>/`, the folder is `../../inbox/handoffs/` and the slug starts with the project name (`2026-10-20-my-app-auth-redirect-fix.md`), so tomorrow's session can find the right one.
- If that file exists, add `-2`, `-3`. Never overwrite an earlier handoff.

## Step 2: Gather the facts
- From the conversation: the goal, what is done, what was decided and why, what is still broken, what comes next.
- Files touched: the paths you created or edited in this session. If the work was in a git repo, `git status --short` (read-only) helps you list them.
- Exact commands, URLs, IDs, branch names and ports that the next session needs.
- Only include what actually happened. Mark anything you didn't verify as "unverified".

## Step 3: Write the note
Use exactly this structure (aim for under 80 lines):

```markdown
# Handoff: <goal in a few words>

Date: 2026-10-20
Where: <folder the work happened in, e.g. projects/my-game or the workspace root>
Branch: <git branch, or n/a>

## Goal
One or two sentences: what we are trying to achieve and why.

## Current state
- What works now (verified how).
- What is half done.

## Decisions (and why)
- <decision> - <reason>

## Files touched
- `path/to/file` - what changed

## Open problems
- <problem> - what was tried, what happened

## Next steps
1. The exact next action, small enough to start immediately.
2. ...

## Commands and paths
    <commands to run, URLs, IDs, ports>
```

## Step 4: Reply
Reply with exactly:

```markdown
Handoff saved: inbox/handoffs/<file>.md

To continue in a fresh session, paste:
Read inbox/handoffs/<file>.md, state the next step in one sentence, then continue.
```

## What not to do
- **Don't change any other file.** No commits, fixes, cleanups or index rebuilds.
- **Don't put secrets** (tokens, passwords, `.env` values) in the note.
- **Don't write vague next steps** like "continue the work". Each step must be concrete.
- **Don't paste long code or logs.** Point to files and lines instead.
- **Don't claim something works** unless it was checked in this session.

## After
Suggest at most 3 next steps, for example:
- `/capture-lesson` for anything reusable before you clear the session.
- `/clear`, then paste the resume line above.
- When the handoff is done with, `/inbox-triage` archives it to `inbox/_processed/`.
