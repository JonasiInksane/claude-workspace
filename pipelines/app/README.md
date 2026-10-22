# App pipelines and project profiles

This folder holds data for the workspace app's run engine (`tools/workspace-app`):

| Path | What it is |
|---|---|
| `profiles/example.json` | The synthetic example profile (project `example`). Tracked. The tests build repos that match it |
| `<pipeline>/<stage>.md` | The stage prompts of each app pipeline (Explain, Review, Refactor and the rest) |

A **profile** tells the app how one project is checked: its workspaces and their test, type and
lint commands, the paths that touch money, tenants or the API contract, the files a run may
never edit, the environment checks run with, and the architecture probes. Without a profile the
app can still start Claude in the project, but it can't run checks or pipelines there.

## The privacy rule

The hub repo is public. A real profile is a map of a project's security-relevant code, so it
never goes into the hub:

- A real profile lives only in the data folder, `%LOCALAPPDATA%\claude-workspace\profiles\<project>.json`.
  Nothing in that folder is tracked by git.
- Only `example.json` lives here, and it describes a made-up project.
- A profile's `privacy.markers` are regexes for names that only that project uses.
  `node tools/check-workspace.mjs` reports an error for any tracked hub file (outside `projects/`)
  that matches one, and a warning for files listed in `privacy.knownExposed`, which are already public.
- Tests and fixtures use the `example` project only. Secret-shaped test strings are built at runtime.
- Run reports for a project whose profile says `privacy.hubPublic: true` are saved in the data
  folder, not in `reports/`.

## Create a profile

1. Open the project's cockpit in the app and choose **Create from the example**. It copies
   `example.json` to `profiles/<project>.json` in the data folder, with `project` and `label` set and
   the run worktree at `C:\dev\<project>-run`. It never overwrites an existing profile.
2. Replace the synthetic values with the project's own (the key list is below). Read the values
   from the project's own files (`package.json` scripts, `.nvmrc`, lint-staged, the dev port list);
   don't guess them.
3. Check it:

   ```powershell
   node tools/workspace-app/profile/profile.mjs --check <project>
   ```

   It prints every error and warning and exits with 1 while there are errors. The cockpit shows
   the same result on its setup line, plus drift warnings (below).

## Copy a profile to another PC

Profiles are per PC and copied by hand, on purpose:

1. Copy `%LOCALAPPDATA%\claude-workspace\profiles\<project>.json` (and `<project>.allowlist.json`
   if it exists) to the same folder on the other PC. Use a private channel such as a USB stick or
   a private folder. Don't email it, and don't commit it anywhere.
2. Fix the paths that differ between the PCs, such as `isolation.worktreePath` and `findings.audit`.
3. Run the `--check` command above on that PC.

Runs, baselines, findings and metrics are not copied. Each PC builds its own.

## What a profile holds

Keys starting with `_` are comments. A missing required key or a wrong type is an error, and an
unknown key is a warning.

| Key | Required | What it is for |
|---|---|---|
| `version`, `project`, `label` | yes | `version` is 1; `project` equals the file name |
| `privacy` | yes | `hubPublic`, `markers` (regexes), `knownExposed` (hub-relative paths) |
| `node` | yes | The pinned Node version and the file that pins it (`.nvmrc`) |
| `git` | yes | Integration branch and remote. Branch prefixes are fixed: `app/` and `archive/app/` |
| `docs` | yes | Files every stage reads first, review rules, where decision records live |
| `isolation` | yes | `worktree` (a separate checkout, the default) or `branch`; the worktree path (short, outside the hub and the main checkout); lockfile and schema files that trigger a reinstall or regenerate |
| `ports` | yes | Dev server ports, local service ports, and the closed endpoint (`127.0.0.1`, port 1) |
| `mainCheckoutGuard` | no | When checks may run in the main checkout even though it has a `.env` |
| `env` | yes | `preset` (variables every check gets), `heapMb`, `neverSet` (names always removed) |
| `workspaces` | yes | Each workspace's folder and its type, lint and test commands; `affectedBy` folder prefixes |
| `commands` | yes | Each command's kind, cwd, argv, file list and timeout |
| `groups`, `levels` | yes | Which commands run at the quick, standard and paranoid levels (G0 is built in) |
| `risk` | yes | Globs for money, tenant and contract paths; they raise the check level and the review effort |
| `fences` | yes | Files a run may never edit, files you must tick at the plan gate, pinned tests, the test file pattern |
| `format` | yes | The format command and its glob, which must equal the lint-staged key |
| `secrets` | yes | Tracked secret files, read-deny globs, and test values the secret scan allows |
| `probes`, `tiles`, `lenses`, `score`, `achievements`, `fun` | no | The architecture scan and the Health view |
| `contract`, `builders`, `assertingBuilders`, `assertPattern` | no | Router and queue names for the contract check; procedure builders for the probes |
| `findings`, `runTg`, `models`, `caps`, `expo` | no | Audit import, dev server buttons, per-stage model overrides, limits, Expo parity map |

### Command lines

`argv[0]` is always `{node}`: the app runs only Node scripts and never a `.cmd` or `.bat` file.
These placeholders are the only ones allowed:

| Placeholder | Becomes |
|---|---|
| `{node}` | The Node that runs the app |
| `{npmCli}` | `npm-cli.js` next to that Node |
| `{tree}` | The checkout the check runs in |
| `{pkg:<path>}` | The first `node_modules/<path>` found from the command's cwd up to the tree root |
| `{files}` | The files to check, relative to the cwd, as one argument each. At most once |
| `{base}` | The base commit |

### The closed endpoint

Checks never reach a real database, cache or API. Every preset name ending in `_URL`, `_HOST` or
`_PORT` (in any case, because Windows env names ignore case) must point at `ports.closed`, a port
nothing listens on, and no preset value may be empty or use a dev or local service port. Some code
falls back to localhost when a value is empty, which is why empty values are refused too. Only a
command with `requiresPorts` (an integration test against containers you started yourself) may
point its own `env` at those ports, and only on loopback.

### Drift warnings

The cockpit compares the profile with the project at the base commit and warns when the format
glob differs from lint-staged, the Node pin differs from `.nvmrc`, a `{pkg:...}` target isn't
installed, or a test root has no matching files. Drift never blocks a run.

## Per-PC settings

`%LOCALAPPDATA%\claude-workspace\settings.json` holds this PC's app settings: single-key shortcuts,
notifications, the celebration and the streak (off by default), the isolation mode per project, and
model overrides per pipeline stage. The app writes it from its settings screen. A hand-edited file
keeps only the values that are valid. The theme is stored in the browser, like the navigator's.
