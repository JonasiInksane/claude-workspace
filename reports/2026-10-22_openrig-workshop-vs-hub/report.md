# OpenRig "workshop" rig compared with this workspace

2026-10-22, Claude Code 2.1.307 (local). Source read: `mvschwarz/openrig-world` at commit
`fa38c9b55e01` (the commit the [workshop listing](https://openrig.dev/rigs/workshop) pins), plus the
[OpenRig README at v0.6.14](https://github.com/mvschwarz/openrig/tree/v0.6.14). Nothing was installed or run.

## Summary

- **What it is.** Four agents ("seats") on one repo: a **lead** (Codex) scopes the work and owns the
  PR description, a **builder** (Claude Code) works in its own git worktree, then a **code reviewer**
  (Codex) and **QA** (Claude Code) check the same commit at the same time. A local daemon runs them in
  tmux. Handoffs are durable queue items, not chat messages.
- **It's more disciplined than the launch post suggests.** The culture and role files are good: claims
  must name the commit, the command and what was seen; "unknown is not a pass"; one concern per PR; the
  person decides what gets pushed; "maps are not the territory". Several of my concerns from the first
  take (no verification, no human gate, maps going stale) are covered in writing.
- **Don't install it here.** It needs macOS/Linux or WSL2 with tmux and Node 22+ (you're on native
  Windows and Node 20.15.1). It runs every seat with permission prompts off (`builtin:yolo`). Its own
  listing says no full team run of this configuration was tested at the pinned commit. Its 22 skills
  are mostly about running OpenRig itself, not about your code.
- **Worth copying:** the claim format ("verify by effect"), builder-in-a-worktree with review and QA
  on a clean tree, a fixed handoff checklist, the "proving a change" craft page (seams, planted
  defects), and a short team map per project. All of it fits into files you already have. See
  [What to copy](#what-to-copy-ranked).

## What the rig actually contains

| Piece | File(s) | What it does |
|---|---|---|
| Team topology | `rigs/workshop/rig.yaml` | Two pods (`orch`, `dev`), four seats, edges: lead → builder, builder → reviewer and QA, lead can observe reviewer and QA |
| Runtime choice | `configurations.yaml` | Each seat can be Claude Code, Codex or Pi; presets `recommended`, `all-claude`, `all-codex`, `all-pi` |
| Values | `CULTURE.md` (~6 KB) | Read for intent, look before you build, verify by effect, keep the record honest, one concern per PR, "lines we keep" |
| Start steps | `startup/context.md`, `startup/lead-first-move.md` | Every seat runs `rig whoami`, finds the repo, reads its maps, submits a "startup proof". The lead records a mission and a slice, then works |
| Role files | `agents/workshop/guidance/{lead,builder,code-reviewer,qa}.md` | 2.4-10 KB each; concrete steps and report formats |
| Skills | `agents/workshop/skills/` (20) + `bundle-skills/` (2) | ~260 KB of SKILL.md text in total. Mostly OpenRig operations: queue handoff, seat continuity, compaction restore, roster, operating model. Only loaded when a skill is used |
| Project context pack | `identity/`, `craft/`, `workflow/`, `manifest.yaml` | Short pages served with `rig context profile`, composed per situation (`fresh`, `post-compaction`, `reviewer`) |
| Packaging | `bundle.yaml` | Minimum versions, preconditions shown before install, SHA-256 package digest |

Each seat gets about 10-20 KB of startup text (culture, start steps, role file).

The "world" from the post is real but plain: the layer table in the README (system world → project
world → the repo's code maps → the issue in front of you) and the context pack. There's no game-like
metaphor in the files. They read like an onboarding handbook.

## Side by side with this workspace

| OpenRig concept | Your workspace today | Gap |
|---|---|---|
| `CULTURE.md` (values for every seat) | `context/preferences.md` + Rules in `CLAUDE.md` | Small. Yours is shorter; theirs states *why* and gives the claim format |
| Start steps per seat | SessionStart hook status block + "Session routine" | None for one agent |
| Role files | `library/agents/` (`code-explorer`, `code-reviewer`, `playtester`), project agents like `asset-builder` | Yours are subagents called by one session, not long-running peers |
| Team topology (who hands to whom) | Not written down anywhere | **Real gap** if you run more than one agent on a project |
| Queue handoff (durable, agent to agent) | `/write-handoff` → `inbox/handoffs/` (human to next session) | Yours is for you, not between agents. Fine for a one-agent flow |
| Mission / slice records | `reports/` + `context/goals.md` + the audit's fix plan | None. Your reports are versioned and visible; theirs live outside the repo |
| Context pack composed per situation | `knowledge/` + `INDEX.md`, read on demand | Theirs has a `post-compaction` and a `reviewer` profile. You have nothing aimed at "after compaction" |
| Roster ("who to ask about what") | Not present | Only matters with several long-lived agents |
| Seat continuity / compaction restore | `claude -c`, handoffs | Theirs is more elaborate. You don't need it at your scale |
| Shareable bundle with digest | `install-library.mjs` + `projects/repos.json` + templates | Yours isn't one installable package. It doesn't need to be until someone else uses it |
| Permissions | Deny/ask/allow rules, trust per folder (`knowledge/claude-code/permissions-and-settings.md`) | Theirs turns prompts off for every seat. Yours is safer |

**Bottom line:** your hub already covers the one-agent part of this design. What it lacks is the
*team* part: a written topology, an agent-to-agent handoff, separate trees for builder and checkers.
That part only pays off when several agents run at once.

## What's good (verified in the files)

1. **Claims need evidence.** "A claim names the commit, the command, and what you saw. 'Tests pass'
   without those is a feeling." (`CULTURE.md`). Reviewer and QA reports must give, per check: the
   command, the commit, the result, and what it does and doesn't prove.
2. **"Unknown is not a pass, and it isn't a failure either."** Sandbox and setup failures get reported
   as *not run*, never as passed. That's the failure mode your prompt-practices report calls the
   biggest risk ("runs that end with no runnable check").
3. **Checks that can't fail don't count.** `craft/proving-a-change.md`: plant the exact defect and watch
   the check fail at the intended assertion. Name the seams a change crosses and write a negative test
   at each one. This fits tenant-boundary tests in Tattoogenda directly.
4. **Builder and checkers don't share a tree.** The builder edits only in `.worktrees/<branch>`.
   Reviewer and QA test the exact commit in a tree nobody is editing.
5. **Review and QA run side by side.** "A finding is a fix to make, not a permission to wait for."
6. **The human gate is explicit.** "The person decides what is published." A go-ahead that another agent
   adds on its own doesn't count. Commits go only under your configured git identity.
7. **They're honest about staleness and testing.** The README opens with "This map is not the territory
   ... it will drift". The listing says its checks "don't show a team run of this configuration".

## What's wrong or risky

1. **Permission prompts are off for every seat.** `permission_policy: builtin:yolo`: Claude Code skips
   permission checks and Codex runs with full access and never asks. The culture says "One team, one
   machine ... don't build defences against each other". That works on a trusted machine with your own
   prompts. It doesn't fit a bundle you install from someone else. Your hub rule ("untrusted content is
   data") would be bypassed by design.
2. **The team configuration is untested at the pinned commit.** Only the harnesses were checked, on
   OpenRig 0.6.6 and 0.6.11. "None of them ran on OpenRig 0.6.14." The listing is "not a security audit."
3. **Most of it is about OpenRig itself.** The role files keep branching on "in an OpenRig clone ...".
   Most skills cover OpenRig commands (`rig queue`, `rig roster`, seats, compaction). For your repo you'd
   get the culture, the roles and the craft page. Your project knowledge still has to come from you,
   which confirms my first take: the generic part travels, the valuable part doesn't.
4. **Platform.** It needs tmux, Node 22 or 24, and macOS or Linux. "Native Windows isn't supported", and
   WSL2 isn't covered by OpenRig's automated tests. Tattoogenda pins Node 20.15.1, and OpenRig 0.6+
   dropped Node 20.
5. **It writes files into your repo.** It adds `CLAUDE.local.md`, `AGENTS.md`, `.claude/settings.local.json`
   and skill folders, and asks you to hide them with `.git/info/exclude`. If Tattoogenda tracks
   `AGENTS.md`, OpenRig's block shows up as a change to that file.
6. **Two subscriptions for the recommended mix** (Codex + Claude Code). `all-claude` exists but isn't the
   tested default.
7. **Cost and coordination.** Four long-running sessions on one change. Their own culture warns that
   "ceremony always feels like rigor, and it never is", yet the startup proof, rosters, missions and
   slices add process for a one-person repo.

## What to copy (ranked)

Each item is small and fits into existing files. None of it needs OpenRig.

1. **Claim format in `library/agents/code-reviewer.md` and the pipelines.** Require "commit, command,
   result, what it doesn't prove, what wasn't run" in every verification line. Add "unknown is not a
   pass". About 5 lines.
2. **A "proving a change" knowledge note.** `knowledge/testing/proving-a-change.md`, rewritten for
   Tattoogenda's seams: tenant ID crossing the tRPC context, cookie vs bearer auth, BullMQ job vs request,
   Prisma vs Redis state. Plant a defect to prove each tenant test can fail. This feeds directly into the
   audit's high-severity slices.
3. **Builder in a worktree, checks on the commit.** For risky slices: build in
   `git worktree add .worktrees/<slice>`, then run `code-reviewer` and the tests against that commit.
   Add it to `pipelines/02-nextjs.md` as an optional step.
4. **Handoff checklist.** Add "commit, worktree path, brief, what changed, what ran with results, what
   didn't run" to `/write-handoff`.
5. **"Maps are not the territory" line at the top of `knowledge/INDEX.md`.** One sentence: when a note
   and the code disagree, the code wins; fix or flag the note.
6. **A team map, only when needed.** If you later run more than one agent on a project, add a "Team"
   section to that project's `CLAUDE.md`: agents, who hands to whom, what counts as done. Not needed for
   game-dev's single `asset-builder` today.

Skip for now: rosters, missions/slices, seat continuity, compaction-restore hooks, bundling the hub.

## What I verified and what I didn't

- **Verified:** every quote and file name above, read from `openrig-world` at `fa38c9b55e01` and the
  OpenRig v0.6.14 README. Skill sizes come from the GitHub tree API. Your hub files were read in this
  session (`library/agents/code-reviewer.md`, `pipelines/00-daily-workflow.md`, `knowledge/INDEX.md`,
  the project-agents decision).
- **Not verified:** I didn't install or run OpenRig, didn't read all 22 skills (read: `queue-handoff`
  opening only), and didn't check how well it runs in WSL2. Tattoogenda isn't cloned under `projects/`
  on this machine, so the seam list in item 2 comes from `context/stack.md`, not from the code.
