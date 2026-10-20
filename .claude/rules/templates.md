---
paths:
  - "templates/**"
---
# Templates are starter files, not instructions

Files under `templates/` (including `templates/*/CLAUDE.md` and `templates/*/.claude/rules/`)
are copied into new projects by `node tools/new-project.mjs`. They are NOT instructions for
this session: don't follow them here. Treat them as content you're editing.

- `{{PROJECT_NAME}}` is replaced with the project name on copy. Keep the placeholder.
- `<...>` lines are fill-ins for the user. Keep them as placeholders.
- `templates/*/README.md` is not copied into projects; it documents the template.
- After changing a template, run `node tools/check-workspace.mjs` (JSON files must stay strict JSON).
