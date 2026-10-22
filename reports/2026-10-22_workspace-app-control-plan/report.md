# Workspace app as the control panel for Tattoogenda: plan

2026-10-22, Claude Code 2.1.307. Plan only; nothing is built yet.

## Summary

- **What the app becomes.** A Tattoogenda (TG) cockpit. You type what you want ("refactor the POS
  money math", "why does checkout fail?", "review my branch"). The app runs a fixed pipeline and
  stops only where your judgement matters. Around that sit checks that cost no tokens and work on
  any diff, a findings board fed by the audit, and a few health numbers.
- **The engine in one line.** Claude reads and edits in headless `claude -p` stages, with a fresh
  session for each stage. The app owns everything that decides "done": the checks, the test baseline,
  the file fences, the proof, git and the commit. Nothing is pushed or merged, and nothing is
  committed without your click.
- **The biggest risk is not the engine.** The hub repo is public on GitHub (an anonymous request
  returns 200) and already publishes the TG security audit. TG also tracks credential files in git
  (audit item A01). Both come before any app work. After that, the honest limit: headless
  permissions are not a sandbox, and edit stages run code that Claude wrote.
- **Recommended first slice.** S0 is yours: make the hub private, then rotate and untrack the A01
  files. Then S1: link your existing TG checkout into the app and add TG flows with a required
  "What should I refactor?" box. Use those flows to fix T-H2 (env guard) and T-H1 (test clock).
- **Size.** A lean path of 7 slices, about 9-12 days, each useful on its own. The headless edit
  pipelines (Fix, Refactor, Debug, Feature) come later, and only if the read-only runner shows they
  are worth the usage and time.

**About this report.** It refers to TG security work by audit ID only, with no file paths for open
findings. Don't commit or push it while the hub repo is public.

## 1. Vision

You open Tattoogenda in the app and say what you want. The app picks the pipeline, shows in plain
words what it will and won't do, and runs it. Claude does the reading and editing. The app runs the
checks, compares them with a per-commit baseline and writes the proof. You approve the plan, the
result and the commit. Everything is plain files, with no npm dependencies and no build step.

How your request maps onto the plan:

| You asked for | Lean version (S1-S6) | Full version (phase 2, only if measured) |
|---|---|---|
| A button that just asks what to refactor | S1: a TG "Refactor (interactive)" flow with one required box; it opens Claude in TG in plan mode | A Refactor pipeline: one "What?" box, then plan gate, tests first, edit, checks, fresh review, commit gate |
| New features | The existing `/nextjs-feature` skill, startable in TG | Feature pipeline with acceptance tests that must fail first, one slice per surface |
| Debugging | A Debug flow (interactive) | Debug pipeline: hypotheses, a failing repro test, then the fix |
| Reviewing | Review pipeline: read-only, one stage, findings with Fix and Dismiss | Adds a verify stage and a second opinion from `/code-review` |
| Architecture faults | Code probes (free) for tenant guards, cycles, boundaries, i18n, plus health tiles | Adds Claude triage of new probe hits |
| Fun features | Three: a ratchet wins log, the baseline counting down to zero, an end-of-day card | More only after phase 2 |
| Clean layout, good UX | A Today view, a TG cockpit, one intent box, a theme toggle, keyboard and a11y fixes | Live run view, review gate, palette |

## 2. Information architecture

**Answer:** six views plus one cockpit per linked project. TG is linked into the app with a
junction, not moved.

| View | Purpose |
|---|---|
| **Today** (home) | "Waiting for you" first, then running, next up, one health line per project, inbox, recent results. One main box: "What do you want to do?" |
| **Tattoogenda** (pinned) | The project cockpit (section 5). Any project with a profile gets its own sidebar entry |
| **Projects** | All projects. Repositories moves into a collapsed card at the bottom |
| **Runs** | History of every run, filtered by project, pipeline or status |
| **Flows** | Unchanged, plus the TG flows from S1 |
| **Library** | Today's Tools view, plus a read-only list of pipelines saying what each stage may do |
| **Images, Assets** | Unchanged. Assets stays hidden unless a project uses it |

The sidebar's Hub block becomes one "Hub session" split button (Start / Continue). "Start Claude"
appears once per place, not three times.

### Linking TG, which lives outside `projects/`

`projects/repos.json` already lists `tattoogenda`, so the Repositories card shows it as missing and
offers Clone. One wrong click would clone a second copy. S1 puts **Link existing checkout** next to
Clone. `POST /api/projects/link` checks that:

- the folder is absolute, local (no UNC), not a drive root and not inside the hub;
- `git rev-parse --show-toplevel` returns the same folder. Git for Windows prints forward slashes,
  so compare after `path.resolve` and a lowercased drive letter;
- the name matches `LAUNCHABLE` and `git remote get-url origin` matches the `repos.json` URL.

It then creates `projects\tattoogenda` as a junction with `fs.symlinkSync(target, link, 'junction')`
(no admin rights needed). `resolveProject` already accepts junctions and `projects/*` is gitignored,
so flows, agents, skill dropdowns and `register-report` work without touching the dozen hard-coded
`projects/<name>` sites. S1 checks every tool that walks `projects/` so none follows the junction
into TG's source.

**Unlink** removes only the link (`fs.rmdirSync`, never recursive). S1 tests that on a scratch
junction first. A knowledge note warns that `Remove-Item -Recurse` on a junction in PowerShell 5.1
can delete the target's contents.

**Launch from the real path.** Every Claude launch and git call for a linked project uses
`fs.realpathSync(dir)`, the Desktop path. Transcripts are stored by working folder, and trust is
keyed on the git repository root (docs: [sessions](https://code.claude.com/docs/en/sessions),
[permissions](https://code.claude.com/docs/en/permissions)). So app sessions line up with the ones
you start by hand. The hub `CLAUDE.md` does not load there, because TG is not under the hub folder;
TG's own `CLAUDE.md` and `AGENTS.md` do. S1 confirms this with `/memory`.

### First-open checklist (cockpit)

1. **Trust**, needed only for interactive flows and Take over. Headless `-p` runs skip the trust
   dialog (verified in local help). Run `claude` once in the TG folder and accept. Trust covers
   worktrees, since it is keyed on the main checkout's root (docs:
   [permissions](https://code.claude.com/docs/en/permissions)).
2. **Profile** present and valid.
3. **Node for checks:** the version that will run TG's checks (section 3.4).
4. **Main checkout status**, for information only.

### The project profile stays private

The profile holds TG's check commands, the env preset, the risk paths, the tenant allowlist and the
probe rules. Two requirements pull against each other:

- It must live **outside TG**, so a run can't edit its own gates.
- It must not be **public**, because it is a map of TG's security-relevant code.

So it goes in the hub (`pipelines/profiles/tattoogenda.json`, validated by `check-workspace`) only if
the hub becomes private. Otherwise it goes in `%LOCALAPPDATA%\claude-workspace\profiles\`, which is
not versioned. The same rule applies to `findings.json`, metrics and TG reports. S1 also teaches
`check-workspace` to refuse TG security content in tracked hub paths while the hub is public.

## 3. The pipeline engine

**Answer:** each Claude stage is one `claude -p` child that Node spawns with an argument list,
never through PowerShell. Each stage starts a fresh session and passes work on through files. Gates,
git, the env and approvals are app code. Any stage can be handed to a terminal tab and taken back.

### 3.1 Shape, and what was not chosen

Pipelines are server-side JS in `runs/catalog.mjs`, following the `catalog.mjs` pattern: an ordered
list of stages, each of kind `claude`, `gate`, `human` or `git`. The page sends only a pipeline id
and field values, and the server validates each value.

| Not chosen | Why |
|---|---|
| Agent SDK | A new dependency and a second Claude binary; the terms for a subscription login are unclear |
| `--bg` sessions | No structured output; they check trust and can't be combined with `-p` (docs: [agent view](https://code.claude.com/docs/en/agent-view)) |
| `claude -w` | Under `-p` it never cleans up and leaves a worktree lock (docs: [worktrees](https://code.claude.com/docs/en/worktrees)) |
| Stop-hook gates | Hook timeouts against TG's 6 GB type-checks are unmeasured; app gates are simpler to test |

### 3.2 How one Claude stage runs

1. **Prepare.** The server writes `stages/NN-<id>/prompt.md` and `settings.json` from a tested
   template. `-p` silently ignores settings files that fail validation (verified in local help), and
   skips single malformed entries such as one bad permission rule (docs:
   [settings](https://code.claude.com/docs/en/settings)). So rules come only from the template, and
   a unit test checks the template's output.
2. **Spawn** `claude.exe` with `cwd` set to the real path, `windowsHide: true`, stdout to
   `events.jsonl`, stderr to `stderr.log`:

   ```
   -p --output-format stream-json --verbose --session-id <uuid> -n <run>-<stage>
   --restricted --strict-mcp-config
   --permission-mode manual|acceptEdits --permission-prompts none
   --tools Read,Grep,Glob[,Bash,Edit,Write] --settings <stage>\settings.json
   --max-turns 40|60 --max-budget-usd <backstop> --json-schema <small schema>
   --append-system-prompt <data-fence rule> --model <m> --effort <e>
   [--add-dir <run>\inputs]   (read-only stages only)
   ```

   - Every flag is in the local help except `--max-turns`, which is documented
     (docs: [cli-reference](https://code.claude.com/docs/en/cli-reference)) and must be tested.
   - Whether stream-json still needs `--verbose` (unverified: test first).
   - The whole command line must stay under Windows' 32,767 characters, so schemas and the
     appended rule stay short.
3. **Prompt on stdin.** Plain-text stdin as the prompt (unverified: test first). The fallback is
   `--input-format stream-json` with one user line (flag verified in local help; line shape from
   docs). This is for headless stages only: interactive launches keep the prompt in argv, because
   their stdin is the terminal.
4. **Scrubbed env for Claude.** Claude's shell commands inherit its environment, and `echo $VAR` is
   in the built-in read-only set (docs: [permissions](https://code.claude.com/docs/en/permissions)).
   So Claude gets only what it needs (PATH, PATHEXT, SystemRoot, windir, ComSpec, USERPROFILE,
   HOMEDRIVE, HOMEPATH, APPDATA, LOCALAPPDATA, TEMP, TMP, ProgramData, ProgramFiles, the Git Bash
   path) plus `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` (docs:
   [headless](https://code.claude.com/docs/en/headless)). That the subscription login still works
   with this env (unverified: test first).
5. **Init check.** The first `system/init` event (docs:
   [agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript)) is compared with
   the request, after normalizing:
   - `manual` is reported as `default`;
   - `model` is the resolved ID, so compare by family (`opus`, `sonnet`);
   - `tools` must contain every requested tool and nothing else except the always-present ones
     (EndConversation, and StructuredOutput with a schema; exact names come from the spike fixture);
   - `cwd` must equal the real path.

   On a mismatch the stage is killed before it does anything. The init event carries no permission
   rules, so it can't prove the settings took effect. The spike adds a canary instead: a stage that
   tries one denied command must produce a denial.
6. **End.** A stage ends when the process exits, using the last `result` line. Background work can
   keep a `-p` run open and add later results (docs: [headless](https://code.claude.com/docs/en/headless)).
   `structured_output` is checked by a small validator for the schema subset we use and
   length-capped. If it is missing, the stage fails cleanly. `permission_denials` from the result
   (the authoritative record, per docs) are shown as "Claude was denied 3 commands".

### 3.3 Permission profiles (headless only)

**Answer:** read-only stages get no shell at all. The app supplies git output as input files.
Interactive launches keep today's `checkLaunch`, which refuses `dontAsk` and `bypassPermissions`. A
new `checkHeadless()` allows only `manual` and `acceptEdits`, always with `--restricted` and
`--permission-prompts none`.

| Profile | Mode | Tools | Shell allow rules | Used by |
|---|---|---|---|---|
| **READ** | manual | Read, Grep, Glob | none | Explain, Review, Scope, triage |
| **CHECK** | manual | READ + Bash | `Bash(tg-check *)` | Debug investigate (phase 2) |
| **EDIT** | acceptEdits | READ + Bash, Edit, Write | `Bash(tg-check *)` | Prove, Implement (phase 2) |

What these settings do, from the local help:

- `--permission-prompts none` denies anything that would prompt; "the permission mode still decides
  everything else" (verified in local help).
- `--restricted` drops code-running tools unless `--tools` names them. It ignores user, project and
  local settings files (`--settings` still applies), confines the file tools to the working folders
  and refuses `bypassPermissions` (verified in local help). Edit stages use it too.
- Under `--restricted`, only a person can approve writes to "settings, git and tool-configuration
  files" (verified in local help). Which files count is (unverified: test first). Per the docs'
  protected-paths list it is probably `.git`, `.claude`, `.husky` and similar, not `package.json` or
  `tsconfig*.json` (docs: [permission-modes](https://code.claude.com/docs/en/permission-modes)).
- `--strict-mcp-config` stops MCP servers from loading (verified in local help).
- TG's own deny rules don't load under `--restricted`, so every stage `settings.json` repeats them.
- Whether `CLAUDE.md` and `AGENTS.md` still load under `--restricted` (unverified: test first). If
  not, prompts tell Claude to read them.

What every stage `settings.json` carries:

- `autoMemoryEnabled: false`. All worktrees of a repo share one auto memory folder, so headless
  stages would otherwise write into the same TG memory as your manual sessions (docs:
  [memory](https://code.claude.com/docs/en/memory)).
- `permissions.blockReadsOutsideWorkingDirectories: true` (docs:
  [settings](https://code.claude.com/docs/en/settings)).
- Absolute deny rules in the documented Windows form, since relative rules anchor at the working
  folder or at the settings file's own folder: `Read(//**/.env*)`, the credential files named in the
  private profile, and `Edit(//c/Users/jonas/AppData/Local/claude-workspace/**)` (docs:
  [permissions](https://code.claude.com/docs/en/permissions)).
- Bash denies for git writes (`push`, `commit`, `stash`, `reset`, `checkout`, `switch`, `rebase`,
  `merge`), `npm`, `npx`, `uv`, `eas` and `curl`.
- A **guard hook** (PreToolUse, exec form `node guard.mjs`) for Bash calls. It allows only the
  `tg-check` shim, and refuses any command that names a credential file, `.env`, the run folder, the
  main checkout or the hub. Whether a hook from `--settings` fires under `--restricted -p`
  (unverified: test first).

PowerShell is left out of headless tools on purpose. That halves the rules, avoids PS 5.1's `&&`
problem, and sidesteps a documented trap: on Windows, any Bash deny rule turns the PowerShell tool
off unless a scoped PowerShell rule exists (docs: [tools-reference](https://code.claude.com/docs/en/tools-reference)).

**What this is not.** It is not a sandbox, and the safety model (section 9) says so:

- In every mode, a built-in set of read-only commands (`cat`, `grep`, `ls`, read-only git and more)
  runs without an allow rule (docs: [permissions](https://code.claude.com/docs/en/permissions)).
  That is why READ has no Bash.
- `acceptEdits` auto-approves `mkdir`, `rm`, `mv`, `cp` and `sed` inside the working folders,
  including any `--add-dir` folder (docs: [permission-modes](https://code.claude.com/docs/en/permission-modes)).
  So edit stages get no `--add-dir`; their inputs go into the prompt text.
- Deny rules don't cover subprocesses: a test file Claude writes can read any file your user can.
- Native Windows has no Bash sandbox.

### 3.4 The check runner (`tg-check`)

**Answer:** one Node script, `gates/check.mjs`, runs every TG check: for you ("Check my work"), for
the gate stages, and for Claude (through a `tg-check` shim on a run-only PATH folder, so one fixed
token is allowlisted instead of every path spelling). It reads the profile and refuses anything the
profile doesn't list. That enforces the never-run list: dev servers, `db:push`, seeds, migrations,
`format`, `eas` and py-api pytest.

**Commands, one per workspace.** Root `npm test` chains workspaces with `&&`, so the first red
workspace (the server, with 61 known failures) hides web, access, utils and ink-help. The profile
therefore lists one command per workspace, and the runner runs all of them even when one fails.

- Tests: `node --import tsx --test --test-reporter=tap <files>`, with the runner expanding the file
  list itself. That also covers Expo's 35 test files (no npm script) and `packages/mail` (whose
  script relies on a glob and `npx --yes`). The slice that builds this copies whatever flags TG's
  `scripts/run-tsx-tests.mjs` adds (unverified: read it first).
- Type-checks and lint: `node <nodeDir>\node_modules\npm\bin\npm-cli.js run ...` from the right
  working folder (web from `apps/web`). Node 20.12+ refuses to spawn `.cmd` files without a shell.
- Each command gets a timeout and a tree kill.

**Node version.** This PC runs Node **v24.11.1** (checked with `node -v`). There is no nvm, so
`context/stack.md` is stale. TG and its CI pin 20.15.1. From Node 23 the default test reporter on a
non-TTY stdout is `spec`, not TAP, so the runner always passes `--test-reporter=tap`. Running gates on
24 can still diverge from CI. Open decision 3: install a portable Node 20.15.1 under
`%LOCALAPPDATA%` for the runner only (an install, so your call), or accept the gap. The Node version
goes into the baseline key either way.

**Environment for checks.** Each check starts from a scrubbed env (the system variables Windows
needs) plus the profile's preset:

- `IS_TEST_ENVIRONMENT=true`, a dummy `DATABASE_URL`, a test-only Stripe key.
- **Connection settings point at a closed endpoint** (for example `127.0.0.1` port 1), never an
  empty string. Some TG code falls back to `localhost` when a value is empty, and this PC runs local
  Postgres and Redis containers that restart on boot. A test Claude wrote could otherwise enqueue
  real jobs that a later dev worker sends. A profile test asserts that no preset resolves to a
  default port, and the cockpit shows a warning chip while those ports listen.
- `NODE_OPTIONS=--max-old-space-size=6144` on type-check commands only.

**Where checks run.** TG's server `env.ts` loads dotenv from `cwd/.env` and `../../.env` without
`override`, so any name the preset misses comes from the real `.env` (audit T-H2). Your main checkout
has a real `.env`. So the runner refuses the main checkout until the T-H2 guard is on the base
commit (a profile-defined check), and that is why T-H2 is fixed in S2, before the runner exists.
In phase 2, the run worktree (section 3.6) has no `.env` at all.

**Output.** TAP is parsed into `summary.json`: tests by identity (file plus full name), pass or
fail, failure kind. Baselines are keyed by base SHA, level, tree mode (main or run worktree) and Node
version.

### 3.5 Gates in code

**Answer:** the app, not Claude, decides whether a change passes. The level comes from "How
careful?", but the changed paths can only raise it.

| Level | Checks | Review |
|---|---|---|
| Quick | G0, plus G1 and G2 on the affected workspaces | opus/high |
| Standard | Quick, plus G3 when `apps/server` changed | opus/high |
| Paranoid (later) | Standard, plus G4 (Docker integration) and a verify stage | opus/xhigh |

**Risk tier.** Money, tenant and contract paths force at least Standard and an opus/xhigh review.
The tenant list includes the shared plumbing, not only feature folders: the tRPC procedure builders,
`modules/access`, `modules/auth`, `src/http`, `db/selects`, the response redactor,
`prisma/schema.prisma` and `prisma/migrations` (new files too). The model's own report never lowers
the bar.

**G0 static** (seconds):

- `git diff --check`, ESLint on changed files, and Prettier run with **lint-staged's exact
  config**, so the pre-commit hook has nothing left to change (section 3.7).
- **Secret scan** over the diff *and* over Claude's outputs (`events.jsonl`, results, report text),
  with matches redacted before display. Patterns cover Stripe, AWS, private keys, `.env` paths, npm
  `_authToken=`, Sentry `sntrys_`, Mollie, Brevo `xkeysib-`, OpenAI `sk-`, Google `AIza`, and a
  high-entropy assignment heuristic.
- **Fences:**
  - *scope:* only files from the approved plan, new test files, the record and the records README;
  - *existing tests:* changes allowed only if the plan lists the file. Every `*.contract.test.ts` the
    plan doesn't list is byte-pinned. The review gate shows "existing test changed" in red;
  - *always forbidden:* existing migrations, `patches/`, `ios/`, `apps/expo/{ios,android}`,
    `mailI18n.generated.json`, `.env*`, `.npmrc`, `.claude/`;
  - *must-tick at the plan gate:* `package.json`, `package-lock.json`, `turbo.json`, `tsconfig*`,
    lint and format configs, `*.config.*`, `.husky/`, `.github/`, `scripts/run-tsx-tests.mjs`,
    `apps/server/src/test/**`, `.nvmrc`, and the risk plumbing above.
- **Ratchets:** no test file loses tests; no new `.skip`, `.only` or `todo`; the set of non-shop
  procedures matches the allowlist; cycle and deep-import counts don't go up.
- **Contract compatibility:** procedure names, the legacy mobile router and queue names unchanged.
- **Tenant and response-secret probes** on the changed server files, on every server change.

**The allowlist comes from a fresh scan.** A scout counted 358 shop, 34 public and 12 protected
router keys (404 in all), about 46 non-shop entries, plus custom procedure builders. A 25-entry
list would fail on day one. S4 rebuilds it and labels each metric with what it measures.

**In-stage checks run fences first.** When Claude calls `tg-check` mid-stage, the runner refuses
while any must-tick file differs from base, and accepts only test paths that exist at base or are in
the plan. It still runs test code Claude just wrote. Section 9 treats edit stages as code execution.

**Baseline per base SHA.** Preflight runs the level's checks on the base commit before Claude
touches anything, cached per key. A failure not in the baseline gets one rerun of its file: failing
twice is **new** (red), passing on retry is **flaky** (yellow, logged). A known failure that now
passes shows "baseline can shrink". The saved baseline changes only when you click "Accept new
baseline". Once T-H1 lands the baseline should be 0, and most of this machinery goes quiet.

**Stage gates:**

- **Pins (Refactor):** characterization tests pass on unchanged source, appear in TAP as executed,
  and stay byte-identical and green after the edit.
- **Red test (Fix, Debug, Feature):** fails on base with an assertion failure (not a crash or import
  error), isn't in the baseline, passes after the edit.
- **Denial test (tenant paths):** a changed test with a denial case and a no-side-effect check.

**Proof block**, built by code: base SHA, branch, each check with command, result and duration, the
baseline comparison, pins before and after, scope ("4/4 files in plan"), the tree hash, the Node and
Claude Code versions. Claude adds only `notProven[]`.

### 3.6 Isolation (phase 2): an app-owned run worktree

**Answer:** a second checkout, `tg-run`, that only the app touches. Created once, reused for every
editing run. The spike measures it before you decide (open decision 4).

**Setup, once:** `git worktree add --detach` at a short path outside the hub (for example
`C:\dev\tg-run`), one `npm ci` and `db:generate`. The app passes `-c core.longpaths=true` on its own
git calls rather than changing the shared `.git/config`. No separate trust step: `-p` skips the
dialog, and trust on the main checkout covers worktrees.

**What ends up in it:** no `.env` (the spike confirms it is gitignored). But tracked files come
along, including the A01 credential files, until S0 rotates and untracks them. Because those files
are tracked, `npm ci` there works today; after A01 the token moves to your user-level npm config and
`tg-run` inherits it.

**Each editing run:**

1. Check `tg-run` is clean and on a detached HEAD.
2. `git checkout --detach <baseSha>`; rerun `npm ci` only if the lockfile hash changed, and
   `db:generate` only if the schema changed.
3. Claude works on the detached HEAD. The branch `app/<mmdd>-<slug>` is created **only at the commit
   gate**. After the commit, `tg-run` detaches again, so you can check the branch out in your main
   checkout (git refuses a branch that another worktree has checked out).
4. On Stop or Cancel, the diff goes to `final/stopped.patch`, then `tg-run` is reset to a clean
   detached HEAD (`git restore`, `git clean -fd`, never `-x`, which would delete `node_modules`).
   "Resume later" reapplies the patch.

**What it buys:** your work in progress stays put, no branch switches under your editor, dev servers
keep running, no Prisma DLL lock clash. **What it costs:** disk for a second `node_modules`, and
reinstall time when the lockfile changes.

**Fallback, branch in place:** only with a clean main tree, refused while any TG dev port from the
profile listens, and never with a stash.

**Locks:** `runs/<project>.lock` holds run id, pid and process start time. It is stale if the pid
is dead or its start time differs. The cockpit shows the lock's age, and **Park run** saves the
patch and releases it. Read-only pipelines need no lock.

### 3.7 Human approvals

Every editing run has three gates. An approval is always a click, never parsed from model text.

1. **Plan gate.** Slices, file list (you can remove files), Claude's questions, risk tags, and
   must-tick files to approve. Approve passes your answers on as data; Revise resumes the scope
   session with your notes.
2. **Review gate.** Diff, gates, proof, findings. Choices: **Fix selected** (resumes implement with
   the findings you pick, at most 2 rounds), **Commit...**, **Take over**, **Stop, keep patch**.
3. **Commit gate.** Editable message, exact file list, "tree hash ok", and a note that TG's
   pre-commit hook will run. On your click: `git switch -c app/...`, `git add -- <files>`,
   `git commit -F`. Then the app compares the committed tree with the gated tree. If the hook changed
   files, it shows them as "hook changed files". No `--no-verify`, and no push or merge button.
   lint-staged makes a temporary backup stash and normally drops it (unverified: test first), so
   "the app never stashes" means the app itself.

### 3.8 Budgets and caps

Under a subscription, cost is a share of your usage limit, not dollars.

- **Turns:** `--max-turns 40` for read stages and `60` for edit stages (docs; not in local help:
  test first). The app also counts unique assistant message ids as a backstop and reads `num_turns`
  from the result.
- **Wall clock:** 15 minutes per read stage, 30 per edit stage, with gate time counted separately.
  It reuses `server.mjs`'s sleep-gap detection, so waking the PC doesn't kill a stage.
- **Budget backstop:** `--max-budget-usd` (verified in local help). It is checked against the
  client-side estimate whatever the login, and can overshoot by about one response (docs:
  [cli-reference](https://code.claude.com/docs/en/cli-reference)).
- **Fix rounds:** at most 2 automatic and 2 that you start.
- **Concurrency:** one editing run per project, at most 2 Claude processes at once.

The run header leads with "turns 23/60 · 11 min". The estimate shows as muted "≈$1.80 API-equiv."
with a tooltip. A usage limit sets `paused-limit` with "Resume later". The S6 runner measures real
usage per stage before any edit pipeline is built.

### 3.9 Run folder and history

Runs live in `%LOCALAPPDATA%\claude-workspace\runs\<project>\<runId>\`, outside the hub, so
`check-workspace` and `build-index` never walk them and nothing reaches the public repo.

```
run.json      pipeline, values, cwd, isolation, base {branch, sha}, status, plan (authoritative),
              pins hashes, stages [{id, status, sessionId, model, mode, turns, subtype, ccVersion}]
inputs/       request.md, diff.patch, log.txt, gate summaries   (read stages only, via --add-dir)
stages/NN-x/  prompt.md, settings.json, events.jsonl, stderr.log, result.json
gates/NN-x/   <check>.log, summary.json
final/        diff.patch, proof.md, review.json, commit-msg.txt, stopped.patch
```

- The authoritative plan, pin hashes and baseline live in `run.json`, which no stage can reach.
  Before each gate, the app checks `inputs/` against its recorded hashes.
- `run.json` is written as a temp file plus rename, retried with a short backoff on `EPERM` or
  `EBUSY` (antivirus and the indexer hold files on Windows).
- `runs/index.jsonl` gets a line on every status change and drives the Runs view.
- Statuses: `running`, `waiting`, `in-terminal`, `passed`, `failed`, `gates-red` (still red after the
  last fix round), `capped` (turn or time cap), `parked`, `cancelled`, `interrupted`,
  `paused-limit`, `committed`.
- **Save as report** goes through `register-report.mjs` into hub `reports/` only if the hub is
  private. Otherwise TG reports go to TG's own `docs/ai/`. A slice also writes its TG record.

### 3.10 Cancel, resume, take over

- **Cancel.** Before killing a saved pid, check that its image is `claude.exe` or `node.exe` and
  that its start time matches the one stored at spawn (Windows reuses pids quickly). Then
  `taskkill /T /F /PID`. The runner writes its own pid files, and an orphan scan uses
  `Get-CimInstance Win32_Process` filtered on the working folder (`wmic` is gone on this Windows
  build). Changes so far go to `final/stopped.patch`.
- **App exit.** The Claude child is not detached, so `claude.exe` should die with the app. Its own
  children (Git Bash, the check runner, `tsc`) may survive: libuv's job object allows silent
  breakaway (from the libuv source, unverified: test first). Startup recovery tree-kills leftovers
  after the image and start-time check and marks the run `interrupted`. The idle-exit tick skips
  exit while a Claude stage or gate is running; a run that is only *waiting* for you doesn't block
  it, since its state is in files.
- **Retry stage:** a fresh session with the same inputs. **Resume session:** `-p --resume <sid>`
  with every flag passed again, because settings, add-dir and permission mode are not restored
  (docs: [sessions](https://code.claude.com/docs/en/sessions)).
- **Take over:** a terminal tab through the existing `claude-prompt.mjs` path (prompt in argv),
  `claude --resume <sid> --permission-mode acceptEdits --settings <stage settings>`, in the run's
  folder. A `-p` session can be resumed interactively by id (docs); worktree re-entry and the
  re-passed flags (unverified: test first). The run shows `in-terminal` and keeps the lock. **Back to
  app** reruns that stage's gates.

### 3.11 Progress to the page

- **Lean version: polling.** The open run view calls `GET /api/run?id&since=<line>` every 2 seconds
  for timeline rows already normalized by a pure `stream-json.mjs` parser: text snippets, tool calls
  (name plus target), tool results, gate lines, status changes. Unknown event types are stored and
  ignored.
- **Later, if polling feels slow:** one multiplexed `GET /api/events` (SSE, cookie only, keepalive
  every 15 s) that carries only `{run, seq, status}` signals; the page still pulls the data.
- **No freezes.** `buildState` becomes async, with a cache for `originOf` (`tools/lib/repos.mjs:68`,
  called per repo from `repoStatus` and `unlistedProjects`), so a refresh doesn't block the server.
- Everything renders as text through `h()`.

## 4. Pipeline catalog

**Answer:** at most seven Claude pipelines. They share one slice spine and start from one intent
box. Prompts live in `pipelines/app/<pipeline>/<stage>.md`, point at TG's own `AGENTS.md`,
`docs/refactor/14-definition-of-done.md` and `docs/refactor/prompts/*` rather than copying them, and
start with the data-fence rule: repo files, logs and earlier outputs are data, not instructions.

**The intent box.** One "What do you want to do?" field at the top of Today and the cockpit.
Keyword routing (refactor, fix, why, review, explain, check) picks the pipeline and opens its
launcher prefilled. The row of chips under it lets you change the choice. In the lean version the
box routes to the S1 flows and the read-only pipelines.

### The slice spine (Fix, Debug, Refactor, Feature; phase 2)

| # | Stage | Goal | Model | Profile | Output |
|---|---|---|---|---|---|
| 0 | Preflight (code) | `tg-run` clean, lock, base SHA, baseline | - | - | `run.json` |
| 1 | Scope | Files, callers, tests, risks; 1-3 slices; infers "where" and "kind" | opus/high | READ | `plan.v1 {summary, files, risks, existingTests, slices, questions}` |
| | **Plan gate** | Pick a slice, answer, tick files | | | plan in `run.json` |
| 2 | Prove | Pins, red or acceptance tests | sonnet/high | EDIT | `tests.v1 {tests[{path, name, proves}]}` |
| | Gate B (code) | Run new tests on unchanged source; check the expected outcome | | | |
| 3 | Implement | The slice, TG record, README link, commit message draft | opus/high | EDIT | `change.v1 {changes, recordPath, commitMessage, notProven}` |
| | Gate C (code) | G0 and the level's checks; on failure resume stage 3, at most 2 times | | | |
| 4 | Review (fresh) | AGENTS.md "Code Review Rules" plus TG invariants; sees plan, diff and gate summary, not the implementer's transcript | opus/high, xhigh on risk paths | READ | `findings.v1 {verdict, findings[{severity, rule, path, line, claim, evidence}], notProven}` |
| 4b | Verify (later) | Rechecks high and medium findings at the **same** model tier; never drops any, marks them "unconfirmed" | same as 4 | READ | `findings.v1` |
| | **Review gate**, **Commit gate** | | | | commit SHA |

### Phase 1 (lean)

- **Check my work** (no Claude). Asks: what (my uncommitted changes / this branch vs base) and how
  careful. Runs the check runner against the cached baseline, after T-H2. Shows a chip such as
  "0 new · 61 known · 1 flaky". 2-15 minutes, zero tokens. It also checks work from your interactive
  sessions, which is how TG slices ship today.
- **Architecture scan** (no Claude). Code probes: procedures outside the allowlist, shop procedures
  with no capability assert, unscoped `id: input.X` lookups, raw procedure builders, public routes
  taking a shop id, money fields not built on `moneyAmount`, provider calls inside transactions,
  `madge` cycles and deep imports, `public.ts` adoption, locale key parity. Writes `metrics.json`.
  1-3 minutes.
- **Explain** (one READ stage, sonnet/high). Asks: "What do you want to understand?" and an optional
  path. Output: `answer.v1 {answer, sources[path:line], openQuestions}`. 2-5 minutes, no lock.
- **Review** (read-only). Asks: what to review (uncommitted / branch vs base / last N commits) and
  focus (preselected from the changed paths). Stages: collect (code: diff, stats, risk paths, G0),
  then one READ review stage. Each finding gets **Fix** (opens the matching flow, or later the Fix
  pipeline, prefilled) and **Dismiss** with a reason. 5-15 minutes.
- **Refactor, Fix, Debug as interactive flows** (S1). Each opens Claude in TG in plan mode with your
  answer to one required question. The check runner then checks the result.

### Phase 2 (only after measuring)

- **Fix a finding** (first editing pipeline). Pick a finding card, add notes. Prove writes a
  contract test that must fail on base on its assertion; tenant paths need a denial test; review
  always at opus/xhigh. The card moves Open, In run, On branch, Done.
- **Refactor.** Only "What do you want to refactor?" is visible; Where, Kind, How careful and Keep
  the same sit under **Options**, because Scope infers the first two and the risk tier sets the
  third. Characterization tests first; Gate C adds the contract diff, the ratchets and pins.
- **Debug.** Asks what's wrong, where you see it, how to reproduce, error text (up to 20 KB, saved
  as a data file), what you expected. Investigate runs in CHECK and returns hypotheses; you pick one
  at the plan gate; Prove writes the failing repro. Bugs no test can pin (pure UI) stop with the
  diagnosis and offer Take over. No runtime logs, Sentry or browser yet.
- **New feature.** Asks what users should be able to do, who, which surfaces, done-when bullets,
  and whether it touches money or more than one shop (unsure counts as yes). Slices run server,
  then web, then Expo. A schema change produces a migration plan for you; the app never migrates.

**Importing findings.** The audit's `report-v2.md` is already stale: commits since the audit closed
several findings, each with a record. So the import reads report-v2, the records in
`docs/refactor/records/` and `git log` since the audit baseline, then shows proposed statuses for
your approval. "Done" comes from `git branch --merged`, not a manual flag. `findings.json` lives in
the private location (section 2).

## 5. Project cockpit for TG

**Answer:** one screen that shows TG's state and starts everything for it.

- **Header:** name and real path; current branch, clean or N changed, ahead/behind; the live stash
  count from `git stash list` (a scout counted 20, 3 on the current branch; the app never touches
  them); trusted; lock state; later the `tg-run` status.
- **Intent box** and a short start row: Check my work, Review, Explain, Architecture scan, and the
  three interactive flows.
- **Waiting / Running:** TG runs only, each with Open.
- **Findings board:** Open / In run / On branch / Done, with severity as text on each card, a phase
  bar, and **Next up**: the highest-severity open finding with the smallest blast radius that isn't
  waiting on an owner decision.
- **Health tiles**, few and labeled with what they measure: the known-failure count (61 today), the
  cycle count and the size of the largest module cycle (not the same metric), deep imports,
  `public.ts` adoption, non-shop procedures vs the allowlist, missing i18n keys per locale. Each tile
  has a text summary ("41, down 3 this week").
- **Checks:** last result per level, its age and duration.
- **Run TG card:** dev:web, dev:no-expo, Expo and kill-ports, each a click that opens a terminal
  tab, with the CLAUDE.md warning that dev starts real workers.
- **Git card,** read-only: branches, ahead/behind, unmerged `app/*` branches with Review and
  Archive (renames to `archive/app/...`). A warning shows when unmerged run branches exist, because
  the next run won't include them.
- **Not covered yet:** the Python agents (py-api, py-agents) and EAS builds. The cockpit says so.

## 6. Fun features

**Answer:** three now, all computed from files and git, costing no tokens.

1. **Ratchet wins log.** "Deep imports 163 → 158 via app/1022-pos-cents", with a short toast after a
   commit.
2. **Baseline to zero.** The 61-failure chip shrinks as T-H1 lands. At 0, G3 goes strict and you get
   a badge.
3. **End-of-day card.** "2 slices · 1 finding closed · health +3 · 0 new failures", with a **Write
   handoff?** button that feeds `/day-recap`.

Later, only if the core works: a phase bar that empties as high findings close, run replay,
achievements tied to real wins, a weekly ship log. A streak stays off by default: rewarding daily
commits on a payments codebase pulls against "one small reviewed slice at a time".

## 7. UI layout and visual design

**Answer:** keep the warm palette and the text-only rendering; add a clear status colour system,
one primary action per screen, a theme toggle and the missing accessibility basics. There is a
[mockup](mockup.html) of the main screens; it is a static mockup, not the app.

**Home**

```
+-------------+---------------------------------------------------------------+
| Workspace   | Today - Thu 22 Oct                                            |
| > Today     | [ What do you want to do?                          Ctrl+K ]   |
|   Tattoogen.| WAITING FOR YOU (1)                                           |
|   Projects  |  Review my branch     findings ready   2 med, 1 low  [Open]   |
|   Runs   1  | RUNNING  Architecture scan   2m                               |
|   Flows  8  | NEXT UP               HEALTH                 INBOX            |
|   Library   | T-H1 test clock       61 known, 0 new        4 items          |
|   Images    | about half a day      cycles 10 (was 10)     [Triage]         |
|             | [Start fix flow]                                              |
| [Hub sess v]| RECENT  ok  Check my work  quick  0 new   12 min ago          |
| theme       |                                                               |
+-------------+---------------------------------------------------------------+
```

**TG cockpit**

```
Tattoogenda  C:\Users\jonas\Desktop\...\tattoogenda                         [...]
rebuild-mascot  2 changed  =origin  stashes 20 (untouched)  trusted  no lock
[ What do you want to do?                                                  ]
Check my work   Review   Explain   Architecture   Refactor*  Fix*  Debug*   (* interactive)
+- Findings ---------------------------------+ +- Health ----------------------+
| Open 11 | In run 0 | On branch 1 | Done 9  | | known failures 61   ####----  |
| [high T-H2 env] [high T-H1 clock] [med ..] | | deep imports 163 (=)          |
| Phase 0  ######.....  6 left               | | public.ts 2/34  procs: ok     |
+--------------------------------------------+ +-------------------------------+
+- Checks -------------------+ +- Run TG ------------+ +- Git ------------------+
| Quick ok 2h  Standard - -  | | [dev:web] [Expo]    | | app/1022-th1  [Review] |
+----------------------------+ +---------------------+ +------------------------+
```

**Launcher (phase 2 Refactor; S1 flows look the same with fewer lines)**

```
+-- Refactor - Tattoogenda ------------------------------------------- x --+
| What do you want to refactor?                                           |
| [ Move SaleTab money math into a tested module                        ] |
| > Options (where, kind, how careful, keep the same)                     |
| ----------------------------------------------------------------------- |
| This run will: read the repo -> you approve a plan -> write tests ->    |
| edit in tg-run -> run checks -> fresh review -> you commit.             |
| It cannot push, run dev servers, touch .env or the database, or change  |
| package.json or tsconfig unless you tick them in the plan.              |
| Risk paths: money (raises the level to Standard)                        |
| Caps 60 turns and 30 min per stage, 2 fix rounds        ~40-90 min      |
| > Exact prompt (live preview)            [Cancel] [Start run Ctrl+Enter]|
+-------------------------------------------------------------------------+
```

**Live run and review gate (phase 2)**

```
< Runs  Refactor SaleTab cents   running              [Take over] [Cancel]
base d47b21a  tg-run  turns 23/60  11 min  (~$1.8 API-equiv.)
+- Stages ----------+ +- Timeline: 3 Implement (opus/high, edit) ---------+
| ok 0 Preflight    | | 10:42 Read 9 files in features/payments/pos       |
| ok 1 Scope   3m   | | 10:44 Edit pos/money.ts (+48)                     |
| ok   Plan  (you)  | | 10:45 tg-check test pos/money.test.ts  ok 7/7     |
| ok 2 Prove +2 pins| | 10:47 Denied: npm run lint (use tg-check lint)    |
| >> 3 Implement r1 | |                                     [follow on]   |
| .. C Checks       | +---------------------------------------------------+
| .. 4 Review       |  Review gate: proof | findings (text severity) | diff
+-------------------+  [Fix selected] [Take over] [Stop, keep patch] [Commit...]
```

**Status colours, always with a text label:** running blue, waiting amber (new `--amber` token),
passed green, failed red (a new red badge), flaky or noted muted yellow, cancelled muted. The accent
orange is used only for primary actions. Today `warn` badges share the accent colour, so "rejected"
and a primary button look alike.

**Tokens and type:** six type sizes (12, 13, 14, 16, 20, 26) instead of ten, and a 4/8/12/16/24/32
spacing scale. A theme toggle with `data-theme` and the `ws-theme` key, matching the navigator.

**CSP rules for new parts:** the page CSP is `style-src 'self'`, and `h()` sets props through
`setAttribute`, so a `style` attribute is blocked. Bars, sparklines and the phase bar use CSSOM
(`el.style.width = ...`), SVG geometry attributes or classes.

**Keyboard and accessibility:**

- Ctrl+K opens a palette over views, projects, pipelines, runs, flows and tools. `g t`, `g p`,
  `g r` jump between views; ignored while typing.
- Single-key shortcuts in the run and review views (F fix, T take over, C commit, j/k findings)
  work only while focus is in that panel, and a setting turns them off. Single-character shortcuts
  clash with screen-reader keys (WCAG 2.1.4).
- `aria-current` on the active nav item, `aria-pressed` on toggles, `aria-labelledby` on dialogs,
  counts announced separately from labels, and the reason a button is disabled shown as visible text.
- Updates re-render only the changed panel and keep focus by `data-key`. A polite live region
  announces only "waiting for you" changes.
- When a run needs you: a "(1)" badge in the window title and a Web Notification (whether that
  works in the Edge app window: unverified, test first).

**CSS fixes:** `.checks {display:flex}` also matches `table.checks` (`app.css:197` and `:264`);
rename one. There is only one `.form-error` rule, so no duplicate to fix.

**Empty and error states:**

| Situation | What the page shows |
|---|---|
| No runs yet | "Try Explain: 3 minutes, read-only." |
| TG not linked | "Link your existing checkout" next to Clone |
| Not trusted | Needed only for flows and Take over; shows the exact command |
| T-H2 not on base | Check my work disabled: "Checks would load your real .env. Fix T-H2 first." |
| Init mismatch | "Stopped before any work: asked for opus, got sonnet." |
| Capped | "Turn cap reached" with Resume (+20 turns), Take over, Stop |
| Gates red after the last round | `gates-red` with Take over and Stop, keep patch |
| Lock held for days | "Plan gate waiting 3 days" with Park run |
| Base moved | "rebuild-mascot moved 4 commits since this run started" |
| Unmerged run branches | "2 unmerged app branches; this run won't include them" |
| Claude not logged in or expired | "Claude login needed: run claude in a terminal" |
| `npm ci` failed in `tg-run` | The log, with Retry and "use branch mode" |
| Usage limit | "Paused: usage limit" with Resume later |
| Interrupted | Retry stage, Resume session |

## 8. Changes to the app code

**Answer:** small additions per slice; split big files only when a slice touches them.

| Area | Change | Slice |
|---|---|---|
| `lib/projects.mjs` | Link, unlink, realpath, origin check | S1 |
| Flows | An optional `ask` field (label, required) shown in the run dialog | S1 |
| `catalog.mjs`, `launch.mjs` | Launch settings (mode, model, effort) for skills; `sessionId` and `resume <id>` | S1 |
| Repositories card | Link existing checkout next to Clone | S1 |
| `gates/check.mjs` + `tg-check` shim | Profile, scrubbed env, per-workspace commands, TAP parser, baseline | S3 |
| `gates/{fences,secrets,ratchets,contract,envpreset}.mjs` | G0 parts, each a pure module with tests | S3 |
| `probes/*.mjs` | Architecture scan, `metrics.json` | S4 |
| Cockpit view | Header, checks, health tiles, Run TG and Git cards | S4 |
| `findings.mjs` | Import, reconcile, statuses | S5 |
| `runs/{manager,store,argv,stream-json,schema-check,catalog}.mjs` | Minimal runner, `checkHeadless()`, init check | S6 |
| `state.mjs` | Async `buildState` with the git cache | S6 |
| `runs/worktree.mjs`, `git.mjs` | `tg-run`, async git with argument lists | phase 2 |
| `events.mjs` | SSE signals | phase 2, if needed |

**Routes:** `POST /api/run` is renamed `/api/command`. New: `POST /api/projects/{link,unlink}`,
`GET /api/project`, `POST /api/checks`, `POST /api/baseline/accept`, `GET /api/findings`,
`POST /api/findings/status`, `GET /api/runs`, `GET /api/run?id&since`, `GET /api/run-file?id&name`
(name from a whitelist), `POST /api/runs` and its actions (`approve`, `revise`, `cancel`, `retry`,
`resume`, `takeover`, `commit`, `stop`, `park`). Run ids match `^[0-9a-z-]+$`.

**Static files:** new UI modules are added to the `STATIC` allowlist one by one, with the
`app.test.mjs` check updated, or `STATIC` becomes a startup scan of `ui/` (only `.js`, `.css`,
`.svg`, no dotfiles, no `..`) with a test that asserts the list.

**Tests** (`node tools/run-tests.mjs workspace-app`):

- `test/fake-claude.mjs` replays stream-json fixtures recorded in the S6 spike: success, missing
  `structured_output`, init mismatch, a hang (for cancel) and denials.
- Unit tests for the TAP parser, baseline comparison, fences, ratchets, secret scan, env preset (no
  default ports) and the argv builder (never `bypassPermissions`, never `dontAsk`, always
  `--restricted` and `--permission-prompts none`).
- The check runner is tested against a temporary git repo with fake checks.
- A real Claude is never started.

**Dependencies:** none. Node built-ins cover spawn, junctions, hashing and the schema subset.

## 9. Safety model

**Answer:** four layers. None of them is a sandbox, and the plan says so wherever it matters.

1. **What is reachable.**
   - The hub becomes private, or TG security data stays out of it (S0, section 2).
   - The A01 credential files are rotated and untracked (S0). Until then, read-only commands and
     tracked-file reads can print them, whatever the Read deny rules say.
   - Claude and the checks each get a scrubbed env. Checks point connection settings at a closed
     endpoint.
   - Phase 2 edits happen in `tg-run`, which has no `.env`.
2. **What Claude is allowed to do.**
   - Headless stages: `--restricted`, `--strict-mcp-config`, `manual` or `acceptEdits` only, always
     with `--permission-prompts none`.
   - READ has no shell. CHECK and EDIT have Bash limited to `tg-check`, behind the guard hook and
     absolute deny rules.
   - Auto memory is off, and reads outside the working folders are blocked.
   - Interactive launches are unchanged, and `dontAsk` and `bypassPermissions` stay refused.
3. **What the app checks.**
   - Every gate is app code, and the profile lives outside TG.
   - Fences run before any in-stage check.
   - Existing tests are pinned unless the plan lists them, and test counts are ratcheted.
   - The baseline changes only on your click, and the secret scan covers diffs and outputs.
   - The init check catches the wrong mode, model, tools or folder.
4. **What you decide.**
   - Plan, review and commit are clicks. Commits stage only the listed files after the tree-hash
     check and are compared with the gated tree afterwards.
   - There is no push or merge.
   - Stop keeps the patch, and Archive renames a branch.

**The gaps, said plainly:**

- Built-in read-only commands run without allow rules wherever Bash is present.
- `acceptEdits` auto-approves file commands inside the working folders.
- Tests and `tg-check` run code Claude wrote, with your user's file access, and deny rules don't
  cover subprocesses.
- `IS_TEST_ENVIRONMENT` doesn't block network calls.
- Shell pattern matching (allow rules, the guard hook) is a filter, not a boundary.

That is why the reachable layer comes first, and why money and tenant changes always get your eyes
on the diff, a denial test and `notProven[]` next to every green result.

**Prompt injection:** repo files, pasted logs, images, gate output and earlier stage outputs go in
as fenced data under a fixed preamble and the `--append-system-prompt` rule. Outputs are
schema-checked and capped. Paths in Claude's output are checked to exist inside the repo before the
app acts on them. The reviewer never sees the implementer's reasoning. Everything renders as text.

**Local server:** the Host check, token cookie, and Origin plus header check stay. Any future HTTP
hook route gets a per-run token.

## 10. Roadmap

**Answer:** a lean path of seven slices that each pay off, then a checkpoint, then phase 2 only if
the numbers support it.

| Slice | Work | Done when | Size |
|---|---|---|---|
| **S0** (you) | Make the hub repo private, or remove the TG audit and rewrite history; assume it has been read either way. Rotate and untrack the A01 credential files in TG (token to user-level npm config). Decide Node for checks. | The anonymous request returns 404; A01 is closed in TG | 1-2 hours |
| **S1** | Link TG (junction, origin check, realpath launches, Link next to Clone, unlink test on a scratch junction). Flows get a required `ask` field. TG flows: Refactor, Fix a finding, Debug, Review (interactive, plan mode). Launch settings for skills. `check-workspace` guard for TG content in tracked paths. | TG shows in Projects and flow targets; "Refactor (interactive)" asks one question and opens a terminal at the Desktop path in plan mode; `/memory` there shows no hub CLAUDE.md; tests green | 1-2 days |
| **S2** | Through the S1 flows, interactively, in TG: T-H2 (dotenv skipped under test) and T-H1 (a test clock). You commit in TG. | Server tests pass with 0 known failures, or the rest are listed; records written | about 1 day |
| **S3** | Check runner: private profile, scrubbed env with closed endpoints, per-workspace commands with TAP, per-SHA baseline, G0 fences and secret scan. Check my work in the app, opening a terminal tab or the commands dialog. | Planted failures: a new failure shows as new, a planted `.skip` fails the ratchet, a planted fake key fails the secret scan | 2 days |
| **Checkpoint** | Use S1-S3 for a week of real slices. Stop here if interactive sessions plus the check runner are enough. | | |
| **S4** | Probes as a CLI writing `metrics.json`; rebuild the allowlist from a fresh scan; cockpit v1 (header, checks, health tiles, Run TG and Git cards). | Counts reproduce the scouts' numbers apart from explained drift | 1-2 days |
| **S5** | Findings board: import and reconcile with records and git log, statuses for your approval. | The board matches the records; Done comes from merged branches | 1 day |
| **S6** | Headless spike plus minimal runner: Explain and Review (READ, one stage), run store, polling, cancel, the normalized init check, fixtures, usage measured per stage. | Explain and a Review of the audit commits stream, save their schema results, cancel cleanly and recover after an app restart | 2-3 days |

The S6 spike settles every "(unverified: test first)" in this plan: stdin prompt, `--verbose`,
init fields, `--max-turns`, `CLAUDE.md` under `--restricted`, which files restricted treats as
config, Grep and Glob honouring Read denies, the guard hook under `-p`, the scrubbed env with your
login, child processes on app exit, interactive resume of a `-p` session. It also measures `tg-run`:
`npm ci` time and disk, long paths, workspace links, Prisma. Results go to
`knowledge/claude-code/headless-runs.md` with `claude_code_version`.

**Phase 2, only if S6 shows it is worth it:**

| Slice | Work |
|---|---|
| P1 | `tg-run` (or branch mode), lock and park, in-stage fences, the three human gates, fix loop, tree hash, commit gate with the hook check |
| P2 | Fix a finding |
| P3 | Refactor |
| P4 | Debug and Feature |
| P5 | Take over / Back to app with the session lock; optional HTTP hooks for terminal sessions |
| P6 | SSE, the palette, the rest of the fun layer, UI file split |

**Stop rules.** S1, S3, S4 and S5 each pay off alone. Reassess after S3 and again after S6. Stop if
the app takes more time than TG.

## 11. Open decisions for you

1. **The public hub repo.** Make it private (recommended: simplest, and the profile, findings and
   reports can then live in the hub), or remove the TG audit and rewrite history and keep TG data in
   `%LOCALAPPDATA%` or TG's own `docs/ai/`. Either way, assume the audit has been read, and weigh the
   open findings with that in mind.
2. **A01.** Rotate the tracked credentials and untrack the files now. This is also the precondition
   for safe headless reads.
3. **Node for checks.** Install a portable Node 20.15.1 used only by the check runner (matches CI;
   an install, so your OK), or run checks on 24.11.1 and accept the gap. Either way
   `context/stack.md` needs updating; it still says 20.15.1 through nvm.
4. **Isolation (phase 2).** The `tg-run` worktree (recommended, decided after S6 measures it) or a
   branch in your checkout.
5. **Commit button (phase 2).** The app runs `git commit` on your click (recommended), or only copies
   the message for GitKraken.
6. **Models.** Opus for scope, implement and review; Sonnet for prove, explain and triage
   (recommended), or Opus everywhere, which uses more of your limit. Which plan are you on?
7. **Guardrails in TG itself.** Deny rules and a hook blocking dev servers and `db:push` in TG's
   own `.claude/settings.json`, so manual sessions are protected too. That is a TG commit.
8. **Where probes live long term.** The profile for now; later perhaps `scripts/checks/*.mjs` in TG,
   so CI runs them.

## 12. Risks

| Risk | Mitigation |
|---|---|
| The public hub has already exposed the TG audit | S0 first; treat as read; keep TG security data private from now on |
| Claude Code auto-updates and drifts | Version recorded per stage, unknown events ignored, spike fixtures as regression tests, abort on init mismatch |
| Unverified CLI behaviour | S6 decides each item before anything depends on it; fallbacks listed in section 3 |
| Edit stages run code Claude wrote | Phase 2 only, in `tg-run` without `.env`, after A01; fences first; your review of risk-path diffs |
| Checks on Node 24 differ from CI on 20.15.1 | Decision 3; Node version in the baseline key and the proof |
| Gate tests reaching local Postgres or Redis | Closed-endpoint preset, a test for it, a warning chip |
| Heavy checks on this PC (6 GB type-checks, full server suite) | One at a time, durations shown, G3 only when the server changed, baselines cached per SHA |
| Orphaned processes and file locks after a kill | Image and start-time check before kills, pid files, CIM orphan scan, `stopped.patch` |
| The pre-commit hook changes the commit | Lint-staged's formatter as a gate; compare the committed tree with the gated tree |
| Junction footgun in PowerShell 5.1 | Unlink only through the app; a knowledge note |
| False confidence from probes and reviews | Probes are heuristics; findings are never dropped; `notProven[]`, denial tests and your eyes stay mandatory |
| Usage limits and cost | Measured in S6 before phase 2; `paused-limit`; turn caps |
| The app eats the time meant for TG | Lean path, checkpoint after S3, stop rules |

## What was checked and what wasn't

- **Read by the scouts (read-only):** the workspace app code (`tools/workspace-app`, `tools/lib`),
  the UI files, the local Claude Code 2.1.307 help, the code.claude.com docs (headless,
  cli-reference, permissions, permission-modes, settings, sessions, worktrees, memory, hooks,
  tools-reference, agent-sdk/typescript), the TG repo through git and grep (no `.env`, `.npmrc` or
  `.sentryclirc` opened), and the workspace pipelines, skills, flows and decisions. Two critique
  passes fact-checked the first design; every high and medium point is applied above.
- **Checked in this step:** `node -v` returns v24.11.1. The hub's origin is
  `github.com/JonasiInksane/claude-workspace`, and anonymous requests to its page and API return 200.
  `reports/2026-10-20_tattoogenda-audit/` is tracked and in `origin/main` history. The local help
  text for `--restricted`, `--permission-prompts`, `--permission-mode`, `--setting-sources`,
  `--strict-mcp-config`, `--json-schema`, `--max-budget-usd`, `--input-format`, `--session-id`,
  `--tools`, and the `-p` notes on trust and invalid settings. `--max-turns` is not in the local help.
  `originOf` is at `tools/lib/repos.mjs:68`.
- **Not done:** nothing was built or run. No tests, no builds, no `claude -p`, no TG commands except
  the scouts' git and grep. Counts from TG (procedures, stashes, failures) are as the scouts reported
  them on 2026-10-22.
- **Unverified (test first, mostly in S6):**
  - the prompt as plain-text stdin; whether stream-json needs `--verbose`;
  - `--max-turns` with `-p` on 2.1.307; turn counting from stream events;
  - the exact `system/init` fields, including the always-present tool names;
  - whether `CLAUDE.md` and `AGENTS.md` load under `--restricted`, and which files it treats as
    configuration;
  - whether Grep and Glob honour Read deny rules, and whether Bash `cat` of a denied file is caught;
  - whether a PreToolUse hook from `--settings` fires under `--restricted -p`;
  - `blockReadsOutsideWorkingDirectories` with Bash read-only commands;
  - the scrubbed env with your subscription login;
  - `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` semantics;
  - child processes surviving the app on Windows (libuv job breakaway), and orphans after
    `taskkill`;
  - interactive `--resume` of a `-p` session: worktree re-entry and re-passed flags;
  - stream-json events beyond init, assistant, user and result (task, tool progress, denials);
  - `--json-schema` together with a `--tools` allowlist;
  - that TG's `.env` is gitignored in a worktree, and `npm ci` time and disk in `tg-run`;
  - that direct `node --test` calls match what `scripts/run-tsx-tests.mjs` does;
  - lint-staged's backup stash behaviour in TG;
  - Web Notifications in the Edge app window.
