# Preferences

Sensible defaults. Edit freely. A project's own `CLAUDE.md` wins when it says otherwise.

## Communication
- Language: English.
- Be concise. Lead with the answer, then the details that matter.
- When there is a real choice, explain the trade-offs briefly (one or two lines each).
- Show commands for Windows PowerShell 5.1 unless I ask for something else.
- Say what you checked and what you did not. Don't claim something works without running it.

## Working style
- Plan before big changes (many files, new structure, refactors). Show the plan and wait for OK.
- Work in small steps that are easy to review.
- Small, focused commits with clear messages. Commit only when I ask.
- Ask before installing dependencies, deleting files, or anything hard to undo
  (push, publish, database changes).
- Archive instead of delete when possible.
- If the same fix fails twice, stop and explain what you know instead of trying random changes.

## Code
- Match the existing style and structure of the project.
- Prefer the project's own scripts (`npm run ...`) over ad-hoc commands.
- Keep game logic testable and separate from rendering.
