# Reports

Dated deliverables: status reports, audits, plans, research, playtest write-ups. Each report
lives in its own folder and has one entry in `reports.json`, which the navigator dashboard
reads and the SessionStart hook passes to Claude.

## Layout

```
reports/
├── README.md
├── reports.json                       <- the registry (one entry per folder)
└── 2026-10-20_workspace-setup/        <- folder name = id = YYYY-MM-DD_kebab-slug
    ├── report.md                      <- the first version, always this name
    └── report-v2.md                   <- revisions are added next to it
```

Reports are Markdown (`.md`). A self-contained `.html` file also works as a step.

## Make a report

The easy way, for a project: in a Claude session started in the workspace root, type

```text
/project-report my-app audit
```

That skill investigates `projects/my-app` read-only, writes
`reports/YYYY-MM-DD_my-app-audit/report.md` and registers it.

By hand (or when Claude writes any other deliverable):

1. Create the folder `reports/YYYY-MM-DD_slug/` and write `report.md` in it.
   Start with a short summary (3-5 bullets: where things stand, biggest risk, next step),
   then the details.
2. Register it:

```powershell
node tools/register-report.mjs --folder reports/2026-10-20_my-app-audit --title 'My app audit' --project my-app --type audit --summary 'Three risky areas, two quick wins.'
```

`--title` is required the first time. `--type` is one of status, onboarding, audit, research,
playtest, plan, other (default other). `--status` is one of active, done, archived
(default active). `--project` must be a folder name in `projects/`; leave it out for
workspace-level reports.

## Revise a report

Never create a second report for the same work. Add a new file to the same folder and
register again:

```powershell
node tools/register-report.mjs --folder reports/2026-10-20_my-app-audit
```

The tool recomputes the steps from the `.md` and `.html` files in the folder (`report.md`
first, then the rest by name), bumps `updated`, and keeps `created`. Only the fields you pass
are changed.

## Finish or archive

```powershell
node tools/register-report.mjs --folder reports/2026-10-20_my-app-audit --status done
node tools/register-report.mjs --folder reports/2026-10-20_my-app-audit --status archived
```

Archiving only changes the status. The files stay. Nothing in `reports/` is deleted.

## The registry format

```json
{
  "version": 1,
  "reports": [
    {
      "id": "2026-10-20_workspace-setup",
      "title": "Workspace setup",
      "project": null,
      "type": "status",
      "status": "done",
      "created": "2026-10-20",
      "updated": "2026-10-20",
      "folder": "reports/2026-10-20_workspace-setup",
      "summary": "One-line summary shown on the dashboard.",
      "steps": [{ "name": "Report", "path": "reports/2026-10-20_workspace-setup/report.md" }]
    }
  ]
}
```

- `id` is the folder name. Paths are relative to the workspace root, with forward slashes.
- Step names come from file names: `report` becomes "Report", `report-v2` becomes "Report v2".
- Don't edit `reports.json` by hand; use the tool. `node tools/check-workspace.mjs` validates
  the registry and checks that every step file exists.
