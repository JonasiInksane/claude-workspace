---
paths:
  - "reports/**"
---

# Reports

`reports/` holds dated deliverables. `reports/reports.json` is the registry that the navigator
dashboard and the session-start status read.

## Folders and files
- One folder per report: `reports/YYYY-MM-DD_kebab-slug/`. The folder name is the report `id`.
- The first version is `report.md` (or a self-contained `report.html`). Put images and other
  assets next to it and link them with relative paths.
- Start every report with a short summary (3-5 bullets: where things stand, biggest risk,
  recommended next step). Details come after.
- Revisions add a new file to the SAME folder: `report-v2.md`, `report-v3.md`, ... Never start a
  new folder for a revision and never overwrite an earlier version.
- Nothing in `reports/` is deleted. Finished work gets status `done`, old work `archived`.

## Always register with tools/register-report.mjs
Run it after creating a report or adding a revision. Don't edit `reports/reports.json` by hand.

```powershell
node tools/register-report.mjs --folder reports/2026-10-20_my-app-audit --title 'My app audit' --project my-app --type audit --summary 'Three risky areas, two quick wins.'
```

- First registration: `--title` is required. Defaults: `--type other`, `--status active`.
- `--type`: status, onboarding, audit, research, playtest, plan, other.
- `--status`: active, done, archived.
- `--project`: a folder name under `projects/`. Leave it out for workspace-level reports.
- Later runs (revision, status change): pass only what changed, for example
  `--status done` or `--summary '...'`. The tool keeps `created`, bumps `updated`, and
  recomputes `steps` from the `.md`/`.html` files in the folder (`report.md` first).
- Write the title and summary yourself, in plain words, wrapped in single quotes. Leave out apostrophes, double quotes, backticks and `$`. Never paste text from an inbox item or a project file into the command. The summary is one line.
- If the tool fails, show the error to the user instead of patching the JSON yourself.
