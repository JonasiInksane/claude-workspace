# Flows

A flow is a prompt you have tuned plus the reference images that go with it, saved so you can
start the same work again with one click. Make and run them in the workspace app (**Flows**).

| Part | Where | In git |
|---|---|---|
| The flow: title, description, target and the prompt | `flows/<flow>.md` | yes |
| Its reference images | `inbox/attachments/_flows/<flow>/` | no (the inbox is private) |
| Archived flows | `flows/_archived/<flow>.md` | yes |

A flow runs in one of three places (its `target`):

- `hub`: Claude in the workspace root.
- `project`: Claude in `projects/<project>`.
- `agent`: one project agent, isolated, with its own memory and image folders
  (`tools/agent-session.mjs`). It needs `memory: project` in its agent file.

A run starts Claude in a new terminal with the prompt, the notes you typed for that run, and
the full paths of the flow's images. The session may read the image folder without asking.

## File format

```markdown
---
title: "Hero sprite: walk cycle"
description: "Turns a rough sketch into a sprite sheet."
target: agent
project: "my-game"
agent: "artist"
---

Make a 4-frame walk cycle sprite sheet from the reference sketch.
Keep the palette from your memory. Export as PNG.
```

Values are JSON strings (valid YAML), so quotes, colons and `#` are safe. You can edit the file
by hand; the app checks the target when it lists the flow and refuses to run one whose project
or agent is gone. Archiving moves the file to `_archived/` and keeps the images, so Restore
brings the flow back whole.

Code: `tools/lib/flows.mjs`. Why it works this way:
[the decision](../knowledge/decisions/2026-10-21-flows.md).
