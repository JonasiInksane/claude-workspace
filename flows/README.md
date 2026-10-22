# Flows

A flow is a prompt you have tuned plus the reference images that go with it, saved so you can
start the same work again with one click. Make and run them in the workspace app (**Flows**).

| Part | Where | In git |
|---|---|---|
| The flow: title, description, target and the prompt | `flows/<flow>.md` | yes |
| Its reference images, plus `captions.json` (what each one shows) | `inbox/attachments/_flows/<flow>/` | no (the inbox is private) |
| Archived flows | `flows/_archived/<flow>.md` | yes |

A flow runs in one of three places (its `target`):

- `hub`: Claude in the workspace root.
- `project`: Claude in `projects/<project>`.
- `agent`: one project agent, isolated, with its own memory and image folders
  (`tools/agent-session.mjs`). It needs `memory: project` in its agent file.

A run starts Claude in a new terminal. Its first prompt is, in this order:

1. The images, labeled `Image 1`, `Image 2` ... (oldest first, the order the editor shows), each
   with its full path and caption. Anthropic's vision guidance puts images before the question
   and labels them, so the prompt below can say "compare Image 1 with Image 2".
2. The flow's prompt.
3. The notes you typed for that run, if any: under the flow's question (`ask`) when it has one,
   otherwise under "Notes for this run:".

The session may read the image folder without asking. Uploaded BMPs are saved as PNG, because
Claude Code's Read tool shows only PNG, JPEG, GIF and WebP as images; a BMP copied into the
folder by hand is not passed (the editor says so).

## How the session starts

Optional, per flow ("How the session starts" in the editor). Empty means your own defaults.

| Field | Values | Becomes |
|---|---|---|
| `permissionMode` | `plan`, `acceptEdits`, `manual`, `auto` | `--permission-mode` |
| `model` | an alias (`opus`, `sonnet`, `haiku`, `fable`) or a full model name | `--model` |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` | `--effort` |
| `allowedTools` | permission rules such as `Read, Grep, Bash(npm test:*)` | `permissions.allow` in the session's settings file |

`bypassPermissions` and `dontAsk` are not offered. Plan suits flows that should explore and
propose before changing anything; effort is the first control for how hard Claude thinks
([research report](../reports/2026-10-21_prompt-pipeline-practices/report.md)). Flag values
as of Claude Code 2.1.307 (`claude --help`). Every session the app starts gets its own id
(`--session-id`), recorded in `%LOCALAPPDATA%\claude-workspace\sessions.jsonl`.

## A question for each run

Optional, per flow ("Ask" and "Required" in the editor).

| Field | Values | Effect |
|---|---|---|
| `ask` | a question, at most 120 characters | The run dialog's text box gets this label, and your answer goes into the prompt under it |
| `askRequired` | `true` or `false` (default) | With `true` the run doesn't start until the box has an answer |

`askRequired: true` needs an `ask`. The Tattoogenda flows (`tattoogenda-*.md`) each ask one
required question, for example "What do you want to refactor?", and start in plan mode.

## Writing the prompt

Write a brief, not a list of commands: the goal, why it matters, the scope, what "done" looks
like (ideally a check Claude can run) and the output you want. Say each thing once; current
models follow instructions literally and over-react to CRITICAL / MUST. Refer to images by
their label. More in the research report above.

## File format

```markdown
---
title: "Hero sprite: walk cycle"
description: "Turns a rough sketch into a sprite sheet."
target: agent
project: "my-game"
agent: "artist"
effort: "high"
allowedTools: "Read, Bash(npm run sprites:*)"
ask: "Which frames need the most care?"
askRequired: true
---

Make a 4-frame walk cycle sprite sheet from the sketch in Image 1, in the palette of Image 2.
It is for the player character, so it must read clearly at 32x32.
Done when `npm run sprites` builds without warnings and the sheet is in assets/player/.
```

Values are JSON strings (valid YAML), so quotes, colons and `#` are safe. You can edit the file
by hand; the app checks the target when it lists the flow and refuses to run one whose project
or agent is gone. Archiving moves the file to `_archived/` and keeps the images, so Restore
brings the flow back whole.

Code: `tools/lib/flows.mjs`. Why it works this way:
[the decision](../knowledge/decisions/2026-10-21-flows.md).
