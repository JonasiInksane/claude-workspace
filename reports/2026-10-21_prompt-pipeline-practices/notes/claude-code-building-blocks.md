# Writing Claude Code's reusable building blocks well (CLAUDE.md, memory, skills, commands, subagents, hooks, output styles, plugins) and the recommended workflow

Research date: 2026-10-21. Locally installed version: Claude Code 2.1.306 (`claude --version`, checked read-only). All docs pages below were fetched on 2026-10-21 from code.claude.com/docs (the current docs, which cite feature versions up to about v2.1.302). Version tags in brackets, like [v2.1.283+], are the minimum versions the docs give. The skills and sub-agents frontmatter tables came through the fetch tool's summarizer in condensed form, so field descriptions are close paraphrases, not verbatim text. The other pages came back near-verbatim.

Source key (all official Anthropic unless labelled):
- Memory: https://code.claude.com/docs/en/memory
- Skills: https://code.claude.com/docs/en/skills
- Subagents: https://code.claude.com/docs/en/sub-agents
- Hooks guide: https://code.claude.com/docs/en/hooks-guide
- Hooks reference: https://code.claude.com/docs/en/hooks
- Best practices: https://code.claude.com/docs/en/best-practices
- Extend Claude Code (feature comparison): https://code.claude.com/docs/en/features-overview
- Output styles: https://code.claude.com/docs/en/output-styles
- Plugins overview: https://code.claude.com/docs/en/plugins
- Skill authoring best practices (Claude Platform docs): https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- Engineering blog, "Equipping agents for the real world with Agent Skills": https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- anthropics/skills repo, skill-creator SKILL.md (Anthropic's official example repo, GitHub): https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md

---

## CLAUDE.md and memory: what belongs where, size, imports, rules folders, emphasis, keeping it current, auto memory

### Takeaway
CLAUDE.md holds facts Claude needs in every session that it can't infer from the code: commands, non-default conventions, gotchas and repo etiquette. Keep each file under about 200 lines, phrase rules concretely, and move anything partial or procedural into path-scoped `.claude/rules/` files or skills. It is advisory context, not enforcement, so anything that must always happen belongs in a hook. Auto memory is a separate notes system that Claude writes itself (index loaded up to 200 lines or 25KB), and it can be switched off per project.

### Cited Findings

**What it is, and how Claude treats it**
- Two memory systems load at the start of every conversation: CLAUDE.md (you write it: "Instructions and rules") and auto memory (Claude writes it: "Learnings and patterns"). "Claude treats them as context, not enforced configuration. To block an action regardless of what Claude decides, use a PreToolUse hook instead." — [Memory](https://code.claude.com/docs/en/memory)
- "CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself... there's no guarantee of strict compliance, especially for vague or conflicting instructions." For system-prompt-level instructions, use `--append-system-prompt`, which suits scripts better than interactive use. — [Memory](https://code.claude.com/docs/en/memory)
- Claude Code can read `AGENTS.md` directly [v2.1.277+]. By default it reads AGENTS.md only when no CLAUDE.md or CLAUDE.local.md exists in the working directory or above. You can change this with the **Project instructions** setting in `/config` (`claude-md-or-agents-md` (default), `claude-md-and-agents-md`, `claude-md`, `managed-only`). — [Memory](https://code.claude.com/docs/en/memory)

**When to add something, and what to put in or leave out**
- Add to CLAUDE.md when "Claude makes the same mistake a second time", when a code review catches something Claude should have known, when you type the same correction again, or when a new teammate would need the same context. "Keep it to facts Claude should hold in every session: build commands, conventions, project layout, 'always do X' rules. If an entry is a multi-step procedure or only matters for one part of the codebase, move it to a skill or a path-scoped rule instead." — [Memory](https://code.claude.com/docs/en/memory)
- The official include/exclude table — [Best practices](https://code.claude.com/docs/en/best-practices):
  - Include: Bash commands Claude can't guess; code style rules that differ from defaults; testing instructions and preferred test runners; repository etiquette (branch naming, PR conventions); architectural decisions specific to your project; developer environment quirks (required env vars); common gotchas or behaviors that aren't self-evident.
  - Exclude: anything Claude can figure out by reading code; standard language conventions Claude already knows; detailed API documentation (link to docs instead); information that changes frequently; long explanations or tutorials; file-by-file descriptions of the codebase; self-evident practices like "write clean code".
- The pruning test: "For each line, ask: 'Would removing this cause Claude to make mistakes?' If not, cut it. Bloated CLAUDE.md files cause Claude to ignore your actual instructions!" — [Best practices](https://code.claude.com/docs/en/best-practices)
- Diagnostics: "If Claude keeps doing something you don't want despite having a rule against it, the file is probably too long and the rule is getting lost. If Claude asks you questions that are answered in CLAUDE.md, the phrasing might be ambiguous. Treat CLAUDE.md like code: review it when things go wrong, prune it regularly, and test changes by observing whether Claude's behavior actually shifts." — [Best practices](https://code.claude.com/docs/en/best-practices)
- Failure pattern "The over-specified CLAUDE.md". Fix: "Ruthlessly prune. If Claude already does something correctly without the instruction, delete it or convert it to a hook." — [Best practices](https://code.claude.com/docs/en/best-practices)

**Writing rules: specificity, structure, emphasis**
- Write instructions concrete enough to verify: "Use 2-space indentation" rather than "Format code properly"; "Run `npm test` before committing" rather than "Test your changes"; "API handlers live in `src/api/handlers/`" rather than "Keep files organized". — [Memory](https://code.claude.com/docs/en/memory)
- Structure: "group related instructions under markdown headers and bullets." Consistency: "if two instructions contradict each other, Claude may pick one arbitrarily." — [Memory](https://code.claude.com/docs/en/memory)
- Emphasis: "If Claude keeps skipping one instruction, add emphasis such as 'IMPORTANT' to that line alone. If you emphasize many lines, none of them stands out." — [Best practices](https://code.claude.com/docs/en/best-practices)
- Block-level HTML comments (`<!-- maintainer notes -->`) are stripped before injection, so they cost no context. Comments inside code blocks are kept. — [Memory](https://code.claude.com/docs/en/memory)

**Size**
- "target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence." Claude Code loads a CLAUDE.md of up to 4 MiB in full and skips larger files. A startup and `/status` warning appears when a file is over the recommended length, or when several files together pass a combined limit. Each CLAUDE.md, rules file and `@` import counts as a separate file. — [Memory](https://code.claude.com/docs/en/memory)
- "Rule of thumb: Keep CLAUDE.md under 200 lines. If it's growing, move reference content to skills or split into `.claude/rules/` files." — [Extend Claude Code](https://code.claude.com/docs/en/features-overview)

**Locations and load order**
- Scopes in load order: managed policy (Windows: `C:\Program Files\ClaudeCode\CLAUDE.md`), user (`~/.claude/CLAUDE.md`), project (`./CLAUDE.md` or `./.claude/CLAUDE.md`), local (`./CLAUDE.local.md`, gitignored). The files are concatenated, not overridden. Content runs from the filesystem root down to the working directory, so instructions closer to the launch directory are read last. CLAUDE.local.md comes after CLAUDE.md at each level. CLAUDE.md files in subdirectories load on demand when Claude reads, writes or edits a file in that subdirectory. — [Memory](https://code.claude.com/docs/en/memory)
- `claudeMdExcludes` (a settings array of globs) skips unwanted ancestor CLAUDE.md or rules files in monorepos. Managed CLAUDE.md can't be excluded. — [Memory](https://code.claude.com/docs/en/memory)

**Imports (`@path`)**
- `@path/to/import` expands the file into context at launch. Relative paths resolve relative to the importing file. Imports can recurse up to "a maximum depth of four hops". Escape spaces with a backslash; a quoted path isn't imported. Imports inside code spans or fences are skipped, so writing `` `@README` `` keeps it literal. — [Memory](https://code.claude.com/docs/en/memory)
- "Imports help you organize a long file but don't reduce its context cost, because imported files also load at launch." — [Memory](https://code.claude.com/docs/en/memory)
- External imports (paths outside the working directory) in project-level files trigger a one-time approval dialog. Declining disables them for good. User-scope files load their imports without the dialog, except in Cowork. — [Memory](https://code.claude.com/docs/en/memory)

**Rules folder (`.claude/rules/`)**
- Use one topic per `.md` file (for example `testing.md`, `api-design.md`); files are discovered recursively. Rules without `paths` load at launch with the same priority as `.claude/CLAUDE.md`. — [Memory](https://code.claude.com/docs/en/memory)
- Path-scoped rule format (`paths` is the only frontmatter field read; it takes a YAML list or a comma-separated string). The rule loads when Claude uses Read, Write or Edit on a matching file, or reads one with `cat` or `head`. — [Memory](https://code.claude.com/docs/en/memory)
  ```markdown
  ---
  paths:
    - "src/api/**/*.ts"
  ---
  # API Development Rules
  - All API endpoints must include input validation
  ```
- Brace expansion works (`"src/**/*.{ts,tsx}"`), with a budget of 1,000 expanded patterns per rule. User-level rules in `~/.claude/rules/` apply to every project and load before project rules; when the two conflict, Claude may follow either. Symlinked rules that point outside the project need the external-import approval. — [Memory](https://code.claude.com/docs/en/memory)
- "Rules load into context every session or when matching files are opened. For task-specific instructions that don't need to be in context all the time, use skills instead." — [Memory](https://code.claude.com/docs/en/memory)

**Keeping it current: tools**
- `/init` generates a starter CLAUDE.md, or suggests improvements if one exists. `CLAUDE_CODE_NEW_INIT=1` switches it to an interactive multi-phase flow that can also set up skills and hooks. `/init` also migrates `.cursor/rules`, `.cursorrules` and `.github/copilot-instructions.md`. — [Memory](https://code.claude.com/docs/en/memory)
- `/doctor prompt-audit` [v2.1.283+] checks CLAUDE.md, CLAUDE.local.md, AGENTS.md and the rules, skills, commands, subagents and output styles under `.claude/` and `~/.claude/`. It looks for "instructions written for older models, references to files or commands that don't exist, and files that contradict each other", and changes nothing until you ask. `/doctor` also proposes trims for a checked-in CLAUDE.md: it cuts derivable content (directory layouts, dependency lists, architecture overviews) and keeps pitfalls, rationale and non-default conventions. — [Memory](https://code.claude.com/docs/en/memory)
- `/context` shows which memory files loaded. The `InstructionsLoaded` hook can log which CLAUDE.md and rules files load and why. — [Memory](https://code.claude.com/docs/en/memory)
- Compaction: project-root CLAUDE.md is re-read from disk after `/compact`. Nested CLAUDE.md files and path-scoped rules reload on demand. Instructions given only in conversation are lost. — [Memory](https://code.claude.com/docs/en/memory). You can steer compaction from CLAUDE.md, for example "When compacting, always preserve the full list of modified files and any test commands". — [Best practices](https://code.claude.com/docs/en/best-practices)
- If your CLAUDE.md sets commit or PR rules, turn off Claude Code's built-in ones with `includeGitInstructions` and set `attribution`. — [Memory](https://code.claude.com/docs/en/memory)

**Auto memory**
- Claude saves four note types (`user`, `feedback`, `project`, `reference`) and skips anything derivable from the code or already in CLAUDE.md. Storage: `~/.claude/projects/<project>/memory/`, one per git repo and shared across worktrees, machine-local. It holds a `MEMORY.md` index plus topic files. — [Memory](https://code.claude.com/docs/en/memory)
- The first 200 lines or 25KB of `MEMORY.md` load at session start. Topic files are read on demand. If the index goes over the limit, Claude Code returns an error telling Claude to rewrite it. — [Memory](https://code.claude.com/docs/en/memory)
- To turn it on or off: the `/memory` toggle (saves `autoMemoryEnabled` in `~/.claude/settings.json`), `"autoMemoryEnabled": false` in project settings, or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. `autoMemoryDirectory` relocates it. — [Memory](https://code.claude.com/docs/en/memory)
- Saying "remember that..." goes to auto memory. To write to CLAUDE.md instead, say "add this to CLAUDE.md" or edit it via `/memory`. — [Memory](https://code.claude.com/docs/en/memory)
- Auto memory from the main conversation isn't loaded into subagents, except forks. — [Memory](https://code.claude.com/docs/en/memory)

### Inferences
- Of the information in CLAUDE.md, imports and unscoped rules, only path-scoped rules and subdirectory CLAUDE.md files actually reduce context. Imports and unscoped rules are organizational only. The 200-line target therefore applies to everything that loads at launch, not just the main file.
- The docs' own wording sets the escalation ladder for a rule Claude ignores: (1) make it more specific, (2) check the file isn't too long or contradictory, (3) add "IMPORTANT" to that one line, (4) make it a hook if it must always hold.

### Gaps
- The memory docs page no longer mentions the old `#` quick-add shortcut. I couldn't confirm whether it was removed or just left undocumented.
- The docs give no exact value for the "combined limit" across multiple instruction files.

---

## Skills (SKILL.md): frontmatter, progressive disclosure, descriptions that trigger correctly, arguments, and Anthropic's authoring best practices

### Takeaway
A skill is a folder whose `SKILL.md` has two parts: a short YAML header (the description is the trigger and is always in context) and a body that loads only when the skill is used. The body should stay under 500 lines and point one level deep to reference files and scripts, which load or run only when needed. Anthropic's authoring guidance:
- Be concise and assume Claude is already smart.
- Match the degree of freedom to how fragile the task is.
- Write descriptions in the third person, covering what the skill does and when to use it, with concrete trigger terms.
- Build evaluations before writing much content.
- Test with every model you will use.

### Cited Findings

**What skills are, and how they load (progressive disclosure)**
- "a skill is a directory containing a SKILL.md file", made of "organized folders of instructions, scripts, and resources that agents can discover and load dynamically." Published 2025-10-16. On 2025-12-18 Agent Skills were "published... as an open standard for cross-platform portability." — [Engineering blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- Three levels — [Engineering blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills):
  1. `name` and `description` of every skill are pre-loaded into the system prompt.
  2. The full SKILL.md is read when the skill seems relevant.
  3. Bundled files are read only as needed, so the context a skill can bundle is "effectively unbounded".
- Scripts can run without their source entering context: "Only the script's output consumes tokens." — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- In Claude Code, custom commands have been merged into skills. Skills are "the most flexible extension": a skill can be reference knowledge (an API style guide) or an action (`/deploy`). — [Skills](https://code.claude.com/docs/en/skills); [Extend Claude Code](https://code.claude.com/docs/en/features-overview)

**Frontmatter fields in Claude Code** (all optional; `description` is recommended; unknown fields are ignored silently; frontmatter is read only if `---` is the first line; if the YAML fails to parse, the skill loads with no fields set) — [Skills](https://code.claude.com/docs/en/skills):
- `name`: the `/` menu name. Defaults to the directory name.
- `description`: what the skill does and when to use it. Put the key use case first. Combined with `when_to_use`, it's truncated at 1,536 characters in the skill listing (configurable with `skillListingMaxDescChars`).
- `when_to_use`: extra trigger context, appended to the description and counted toward the same cap.
- `argument-hint`: autocomplete hint, for example `[issue-number]`.
- `arguments`: named positional arguments for `$name` substitution.
- `disable-model-invocation: true`: only the user can invoke the skill. The description is not in context, the skill can't be preloaded into subagents, and scheduled tasks can't run it.
- `user-invocable: false`: hidden from the `/` menu; only Claude invokes it.
- `allowed-tools`: tools usable without prompting during the invoking turn. "The grant clears when you send your next message."
- `disallowed-tools`: tools removed while the skill is active.
- `model`: model for the current turn only (`inherit` keeps the active one). `effort`: `low` to `max`.
- `context: fork` plus `agent: <Explore|Plan|general-purpose|custom>`: run the skill in a forked subagent. `background` (default true) [v2.1.218+]; `background: false` waits for the result.
- `hooks`: hooks registered when the skill is invoked, which stay for the rest of the session.
- `paths`: glob patterns that limit automatic activation to matching files.
- `shell`: `bash` (default) or `powershell` for `` !`command` `` blocks.
- `metadata`, `license`, `compatibility`: spec fields that Claude Code accepts but ignores.
- Portability: outside Claude Code (claude.ai uploads and the Skills API), only `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools` are allowed, and other keys are a hard error, for example `Unexpected key(s) in SKILL.md frontmatter: argument-hint`. — [Skills](https://code.claude.com/docs/en/skills)
- Agent Skills spec constraints (platform docs): `name` is at most 64 characters, lowercase letters, numbers and hyphens only, with no XML tags and no reserved words "anthropic" or "claude". `description` is non-empty, at most 1,024 characters, with no XML tags. — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices). Note: Claude Code's own listing cap is 1,536 characters for description plus when_to_use. Use 1,024 as the portable limit.

**Who can invoke a skill**
- Default: both you and Claude can invoke it; the description is always in context and the full skill loads when invoked. `disable-model-invocation: true`: only you; the description is not in context. `user-invocable: false`: only Claude; the description is always in context. — [Skills](https://code.claude.com/docs/en/skills)
- "Use `disable-model-invocation: true` for workflows with side effects that you want to trigger manually." — [Best practices](https://code.claude.com/docs/en/best-practices). It also "saves context". — [Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- Typing `/deploy staging` at the start of a message runs the skill. Writing the name later in plain text ("go ahead and /deploy") grants permission but doesn't trigger it directly. — [Skills](https://code.claude.com/docs/en/skills)
- Permission rules: `Skill(commit)` (exact), `Skill(review-pr *)` (prefix), `Skill` (all). `skillOverrides` in settings: `"on"`, `"name-only"`, `"user-invocable-only"`, `"off"`. — [Skills](https://code.claude.com/docs/en/skills)

**Arguments and substitutions**
- `$ARGUMENTS` is everything as typed. If no placeholder consumes it, Claude Code appends `ARGUMENTS: <value>`. `$ARGUMENTS[N]` and `$N` are 0-based positional arguments; quote multi-word values. `$name` comes from `arguments`. `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}` and `${CLAUDE_EFFORT}` are also available. `\$1.00` escapes a literal dollar sign. An unmatched `$2` stays literal; an unmatched named placeholder becomes empty. — [Skills](https://code.claude.com/docs/en/skills)
- Dynamic context: `` !`git diff HEAD` `` runs before Claude sees the skill and its output replaces the placeholder (multi-line form: a fence opened with ` ```! `). A non-zero exit aborts the invocation, except exit 1 from search and compare commands. Admins can disable this with `disableSkillShellExecution`. — [Skills](https://code.claude.com/docs/en/skills)
- Including `ultrathink` anywhere in the skill content requests deeper reasoning. — [Skills](https://code.claude.com/docs/en/skills)

**Short examples**
- Reference skill, from [Best practices](https://code.claude.com/docs/en/best-practices):
  ```markdown
  ---
  name: api-conventions
  description: REST API design conventions for our services
  ---
  - Use kebab-case for URL paths
  - Use camelCase for JSON properties
  ```
- Action (command-style) skill, from [Best practices](https://code.claude.com/docs/en/best-practices):
  ```markdown
  ---
  name: fix-issue
  description: Fix a GitHub issue
  disable-model-invocation: true
  ---
  Analyze and fix the GitHub issue: $ARGUMENTS.
  1. Use `gh issue view` to get the issue details
  ...
  5. Write and run tests to verify the fix
  ```
- Forked research skill, from [Skills](https://code.claude.com/docs/en/skills): `context: fork` plus `agent: Explore`, with body "Research $ARGUMENTS thoroughly: ...". The skill body becomes the subagent's task prompt. The subagent doesn't see conversation history, so the prompt must be self-contained. Explore and Plan skip CLAUDE.md. Edits from background forks aren't covered by `/rewind`.

**Locations and precedence**
- Enterprise (managed), personal `~/.claude/skills/<name>/SKILL.md`, project `.claude/skills/<name>/SKILL.md`, nested `<subdir>/.claude/skills/` (loads when working in that subdirectory), `--add-dir`, plugin (`/plugin-name:skill-name`), and claude.ai-synced. Precedence on name clash: enterprise > personal > project. A skill can shadow a built-in command of the same name but not its aliases. Edits apply live; a new top-level skills directory needs `/reload-skills`. — [Skills](https://code.claude.com/docs/en/skills)

**Description listing budget and triggering**
- The listing always includes every skill name, but descriptions are dropped to fit a budget of "1% of the model's context window", least-invoked first. You can raise it with `skillListingBudgetFraction` (for example `0.02`) or `SLASH_COMMAND_TOOL_CHAR_BUDGET`. You can also set low-priority skills to `"name-only"`, or trim descriptions with the key use case first. `/doctor` estimates the listing's cost and `/skill-doctor` [v2.1.252] finds unused skills. — [Skills](https://code.claude.com/docs/en/skills)
- Not triggering: "Check the description includes keywords users would naturally say". Check `What skills are available?`, invoke directly, and validate the frontmatter with `claude plugin validate .claude/skills` [v2.1.233+]. For plugin skills, measure triggering with `claude plugin eval` and a `tool_used: Skill` grader. Triggering too often: make the description more specific, or add `disable-model-invocation: true`. — [Skills](https://code.claude.com/docs/en/skills)
- "Claude matches your task against skill descriptions to decide which are relevant. If descriptions are vague or overlap, Claude may load the wrong skill or miss one that would help." — [Extend Claude Code](https://code.claude.com/docs/en/features-overview)

**Skill content lifecycle (writing implication)**
- Claude Code adds the skill content when it's invoked and "doesn't re-read the file" on later turns. So word guidance to apply to the whole task ("Run the tests after every edit" rather than "Run the tests"). After compaction it "can keep only the start of an invoked skill, so put the most important instructions near the top of SKILL.md". A rule that must hold every time should be a hook, which can live in the skill's `hooks` frontmatter. — [Skills](https://code.claude.com/docs/en/skills)

**Anthropic's authoring best practices**
- Conciseness: "The context window is a public good." "Default assumption: Claude is already very smart. Only add context Claude doesn't already have." Ask "Does this paragraph justify its token cost?" Their example: a 50-token pdfplumber snippet beats a 150-token explanation of what PDFs are. — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- Degrees of freedom: "Match the level of specificity to the task's fragility and variability" — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices):
  - High freedom: text heuristics, for when many approaches are valid (for example code review).
  - Medium freedom: pseudocode or parameterized scripts, for when a preferred pattern exists.
  - Low freedom: an exact script with "Do not modify the command", for fragile operations such as migrations.
  - The analogy: on a "Narrow bridge with cliffs on both sides", give exact guardrails; in an "Open field with no hazards", give general direction.
- Test with multiple models: "What works perfectly for Opus might need more detail for Haiku." Ask of each: Haiku, "Does the Skill provide enough guidance?"; Sonnet, "Is the Skill clear and efficient?"; Opus, "Does the Skill avoid over-explaining?" — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- Naming: prefer the gerund form (`processing-pdfs`); noun phrases (`pdf-processing`) and action names (`process-pdfs`) are acceptable. Avoid vague names (`helper`, `utils`), overly generic ones (`documents`), and reserved words. — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- Descriptions: "Always write in third person. The description is injected into the system prompt, and inconsistent point-of-view can cause discovery problems." Good: "Processes Excel files and generates reports". Avoid: "I can help you..." and "You can use this to...". Include both what the skill does and when to use it, with key terms. Claude picks "from potentially 100+ available Skills". Good example: `description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.` Bad: "Helps with documents", "Processes data". — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- Description triggering, from Anthropic's skill-creator (example repo): the description is "the primary triggering mechanism - include both what the skill does AND specific contexts for when to use it". All "when to use" information belongs in the description, not the body. Claude tends to undertrigger, so make descriptions a little "pushy", for example "Make sure to use this skill whenever the user mentions dashboards, data visualization, internal metrics". List adjacent phrasings, including requests that never name the skill. — [skill-creator SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md)
- Progressive disclosure rules — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices):
  - Keep the SKILL.md body under 500 lines.
  - Keep references one level deep from SKILL.md, because Claude may only partly read (`head -100`) files that are referenced from other references.
  - Give reference files over 100 lines a table of contents.
  - Organize by domain (`reference/finance.md`, `reference/sales.md`).
  - Use descriptive file names and forward slashes even on Windows.
  - The skill-creator says ToC above 300 lines and metadata of about 100 words. — [skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md). The two sources differ on the ToC threshold (100 vs 300 lines).
- Workflows and feedback loops: for complex tasks, give a checklist Claude copies and ticks off, and use "Run validator → fix errors → repeat". The "plan-validate-execute" pattern writes an intermediate `changes.json`, validates it with a script, then applies it; use it for batch, destructive or high-stakes operations. Make validators verbose ("Field 'signature_date' not found. Available fields: ..."). — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- Content rules: no time-sensitive information (put it in a collapsed "Old patterns" section); one term per concept; don't offer many options, give a default with an escape hatch; templates (strict or flexible) and input/output example pairs for style; conditional workflow branches. — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- Scripts: "Solve, don't defer" (handle errors in the script); no "voodoo constants" (justify every value); say whether Claude should execute a script or read it; list dependencies and don't assume they're installed; use fully qualified MCP tool names (`ServerName:tool_name`). — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- Evaluation-driven development: "Create evaluations BEFORE writing extensive documentation." — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
  1. Run Claude without the skill and document its failures.
  2. Build three scenarios that test those gaps.
  3. Measure the baseline.
  4. Write minimal instructions.
  5. Iterate.
  - There is "not currently a built-in way to run these evaluations" on the platform. Claude Code now has `claude plugin eval` for plugin skills. — [Skills](https://code.claude.com/docs/en/skills)
- Claude A / Claude B: one instance (A) helps write and refine the skill, and a fresh instance (B) uses it on real tasks. You watch where B struggles and bring the specifics back to A. Watch for unexpected read order, missed links, overused sections (move them into SKILL.md) and ignored files. — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- Skill-creator testing loop: write 2–3 realistic test prompts in `evals/evals.json`, and run each with the skill and as a baseline in the same turn. For description tuning, use about 20 trigger queries (8–10 should trigger, 8–10 should not, with "near-misses" as the valuable negatives), a 60/40 train/held-out split, three runs per query, and up to five iterations. — [skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md)
- Style: "Prefer using the imperative form in instructions." "explain to the model why things are important in lieu of heavy-handed musty MUSTs." "If you find yourself writing ALWAYS or NEVER in all caps... that's a yellow flag". — [skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md). Mild tension: the platform guide's iteration example suggests Claude A might propose "stronger language such as 'MUST filter' instead of 'always filter'" when a rule is missed. — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- Security: install skills only from trusted sources, and audit bundled files, dependencies and network instructions in others, since malicious skills could exfiltrate data. — [Engineering blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- Final checklist highlights:
  - The description is specific and covers both what and when.
  - The body is under 500 lines and references are one level deep.
  - Terminology is consistent and examples are concrete.
  - There are at least three evaluations.
  - The skill has been tested with Haiku, Sonnet and Opus and in real usage scenarios.
  - Source: [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)

### Inferences
- Two different description limits apply: 1,024 characters (Agent Skills spec, portable) and 1,536 (Claude Code listing cap). The real constraint in a large setup is the shared 1%-of-context budget. Short, front-loaded descriptions are what keep a skill triggerable.
- On emphasis, the guidance converges: explain the reason first, and use a single strong marker only on a rule that is demonstrably skipped. Anything that must never fail goes in a hook, not in capitals.
- The fact that a skill isn't re-read after invocation has a practical consequence. Long multi-step skills should put their invariant rules at the top, and phrase them to apply across the whole task.

### Gaps
- I didn't find an official statement of a word or character target for a good description beyond the hard limits. The skill-creator's "about 100 words" refers to all metadata.
- The full skills page middle sections (for example "characters a skill name can't hold" and "skill content lifecycle" in full) came through only as a summary.

---

## Skills vs. custom slash commands (`.claude/commands/`): how they relate and when a command-style skill is better

### Takeaway
Custom slash commands have been merged into skills. A file at `.claude/commands/deploy.md` and one at `.claude/skills/deploy/SKILL.md` both create `/deploy`, and the skill wins on a name clash. Command files still work but lack supporting files, `name` and `paths`. A "command-style" skill is simply one with `disable-model-invocation: true`. Use it for anything with side effects or that you want to run only on demand.

### Cited Findings
- "Custom commands have been merged into skills. `.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way. Existing command files keep working." Skills add a supporting-files directory, invocation control and automatic loading. When a skill and a command share a name, "the skill wins". Command files don't support `name` or `paths`. — [Skills](https://code.claude.com/docs/en/skills)
- "Use `disable-model-invocation: true` for workflows with side effects that you want to trigger manually." — [Best practices](https://code.claude.com/docs/en/best-practices)
- With `disable-model-invocation: true` the description isn't in context: "For user-only skills (`disable-model-invocation: true`), nothing loads until you invoke them." — [Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- The trigger for creating one: "You keep typing the same prompt to start a task → Save it as a user-invocable skill"; "You paste the same playbook or multi-step procedure into chat for the third time → Capture it as a skill". — [Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- `--disable-slash-commands` ("Disable all skills and commands") exists in the CLI help of the locally installed 2.1.306 — local `claude --help` output, checked 2026-10-21.
- `/doctor prompt-audit` covers commands as well as skills. — [Memory](https://code.claude.com/docs/en/memory)

### Inferences
- For new work, write skills, not `.claude/commands/` files. Keep existing command files only if you don't need supporting files. Migrating one is a move into `<name>/SKILL.md`.
- "Command-style" means: `disable-model-invocation: true` + `argument-hint` + `$ARGUMENTS`, with explicit numbered steps and a verification step.

### Gaps
- I found no official deprecation date for `.claude/commands/`. The docs only say it keeps working.

---

## Subagents (`.claude/agents/*.md`): fields, system prompts, descriptions that get delegated to, tool restriction, condensed results, built-ins, and when they hurt

### Takeaway
A subagent is a Markdown file whose frontmatter configures it and whose body becomes its system prompt. It runs in a fresh context with its own tools and model and returns a summary. Use one to isolate noisy work (search, review, verification) or to enforce tool limits. Give each a narrow job, a description that singles it out (adding "use proactively" encourages automatic delegation), the minimum tools, and a prompt with an explicit procedure and output format. Avoid subagents for tight back-and-forth or when latency matters. They start cold, cost their own tokens, and many detailed results can flood the parent's context.

### Cited Findings

**Frontmatter fields** (only `name` and `description` are required; the body is the system prompt; unknown fields are ignored) — [Subagents](https://code.claude.com/docs/en/sub-agents):
- `name` (at most 256 characters, no `:`) and `description` ("When Claude should delegate to this subagent").
- `tools` (allowlist; inherits all if omitted) and `disallowedTools` (denylist, applied first; an entry like `Bash(git push *)` still removes the whole tool).
- `model`: `sonnet`, `opus`, `haiku`, `fable`, a full ID, or `inherit`.
- `permissionMode`: `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, `manual`. Ignored for plugin agents.
- `maxTurns`, `autoCompactWindow` [v2.1.296+], `effort`, `color`, `background`, `isolation: worktree`, `initialPrompt`, `omitClaudeMd` [v2.1.271+].
- `skills`: preloaded skills, with "The full skill content is injected", up to 32.
- `mcpServers` and `hooks`: both ignored for plugin agents.
- `memory`: `user`, `project` or `local`.
- Example from the docs:
  ```markdown
  ---
  name: code-reviewer
  description: Reviews code for quality and best practices
  tools: Read, Glob, Grep
  model: sonnet
  ---
  You are a code reviewer. When invoked, analyze the code and provide
  specific, actionable feedback on quality, security, and best practices.
  ```

**Locations and priority**
- Managed > `--agents` CLI JSON > project `.claude/agents/` > user `~/.claude/agents/` > plugin `agents/`. Directories are scanned recursively, and identity comes from `name`. A restart is needed when the first file is created in a new agents directory. — [Subagents](https://code.claude.com/docs/en/sub-agents)
- Invocation: natural language ("Use the test-runner subagent..."), `@agent-<name>` mention, `claude --agent <name>` (the whole session runs as that agent), or `"agent"` in settings. `/agents` now prints a reminder to edit the files directly; the interactive wizard existed in v2.1.197 and earlier. — [Subagents](https://code.claude.com/docs/en/sub-agents). `--agent` and `--agents` both appear in the local 2.1.306 `claude --help`.

**Built-in agents**
- Explore: read-only (Write and Edit denied), "A fast, read-only agent optimized for searching and analyzing codebases", with thoroughness quick, medium or very thorough. It uses the main conversation's model. — [Subagents](https://code.claude.com/docs/en/sub-agents)
- Plan: read-only research for plan mode, inheriting the model. — [Subagents](https://code.claude.com/docs/en/sub-agents)
- general-purpose and `claude`: all tools. — [Subagents](https://code.claude.com/docs/en/sub-agents)
- statusline-setup (Sonnet) and claude-code-guide (Haiku). — [Subagents](https://code.claude.com/docs/en/sub-agents)
- Explore and Plan start without CLAUDE.md and git status. — [Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- You can disable them with `permissions.deny: ["Agent(Explore)"]` or `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1`. — [Subagents](https://code.claude.com/docs/en/sub-agents)

**Descriptions and delegation**
- Claude "uses each subagent's description to decide when to delegate tasks". Include phrases like "use proactively" to encourage automatic delegation. Keep descriptions short and put detail in the system prompt, which loads only when the agent runs. A startup warning appears when combined descriptions exceed 15,000 tokens. — [Subagents](https://code.claude.com/docs/en/sub-agents)
- Example descriptions from the docs: "Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code." and "Debugging specialist for errors, test failures, and unexpected behavior. Use proactively when encountering any issues." — [Subagents](https://code.claude.com/docs/en/sub-agents)
- Official best practices: "Design focused subagents: each subagent should excel at one specific task"; "Write descriptions that single out one subagent"; "Limit tool access: grant only necessary permissions for security and focus"; "Check into version control". — [Subagents](https://code.claude.com/docs/en/sub-agents)
- Explicit delegation also works: "Tell Claude to use subagents explicitly: 'Use a subagent to review this code for security issues.'" — [Best practices](https://code.claude.com/docs/en/best-practices)

**Writing the system prompt** (pattern in the official examples) — [Subagents](https://code.claude.com/docs/en/sub-agents):
- A role line ("You are a senior code reviewer...").
- "When invoked:" followed by numbered steps (for example "Run git diff... Focus on modified files... Begin review immediately").
- A checklist of what to look for.
- An explicit output format (for example "Critical issues (must fix) / Warnings (should fix) / Suggestions"), plus "Include specific examples of how to fix issues."
- The debugger example ends with "Focus on fixing the underlying issue, not the symptoms."

**Tool restriction**
- Allowlist: `tools: Read, Grep, Glob, Bash`. Denylist: `disallowedTools: Write, Edit`. Whole MCP server: `disallowedTools: mcp__github` / `tools: mcp__github__*`. `Agent(worker, researcher)` restricts which subagents can be spawned, but only when the agent runs as the main thread via `--agent`. — [Subagents](https://code.claude.com/docs/en/sub-agents)
- For finer control than `tools` allows, use frontmatter hooks. In the docs' read-only DB example, a PreToolUse hook script exits 2 on SQL writes as "a backstop" to the prompt's own refusal instruction. On Windows, write the script in PowerShell and set `shell: powershell`. — [Subagents](https://code.claude.com/docs/en/sub-agents)

**Context, memory, nesting, cost**
- A non-fork subagent receives its own system prompt, the delegation message, CLAUDE.md files, a git status snapshot and preloaded skills. It doesn't receive your conversation history, output style or auto memory. — [Subagents](https://code.claude.com/docs/en/sub-agents)
- Forks inherit the parent conversation and system prompt and reuse the parent's prompt cache ("a fork costs less than a fresh subagent for tasks that need the same context"). A fork can't spawn forks. Fork mode is on by default from v2.1.302 (v2.1.232 in interactive terminal). — [Subagents](https://code.claude.com/docs/en/sub-agents)
- Persistent memory (`memory:`): `user` → `~/.claude/agent-memory/<name>/`, `project` → `.claude/agent-memory/<name>/` (the recommended default, shareable via VCS), `local` → `.claude/agent-memory-local/<name>/`. The first 200 lines or 25KB of its `MEMORY.md` load into the agent, and Read, Write and Edit are auto-enabled. It has no effect if auto memory is off. — [Subagents](https://code.claude.com/docs/en/sub-agents)
- Nesting: subagents can spawn subagents "up to three layers below the main conversation" by default (v2.1.219+; `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, set to 1 to disable). Concurrency defaults to 20 (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`). — [Subagents](https://code.claude.com/docs/en/sub-agents). This contradicts the common older belief that subagents can't spawn subagents.
- Resuming: each invocation is a new instance. Claude can resume one with `SendMessage` to its ID or name, and the resumed agent keeps its full history. Explore and Plan are one-shot. — [Subagents](https://code.claude.com/docs/en/sub-agents)
- When to use the main conversation instead: "frequent back-and-forth, shared context across phases, quick targeted changes, or when latency matters, since a non-fork subagent starts fresh." Use subagents when "the task produces verbose output you don't need, when you want tool restrictions, or when the work is self-contained and can return a summary." — [Subagents](https://code.claude.com/docs/en/sub-agents)
- Cost: subagents "send their own requests, which count toward the same usage limits". Many subagents returning detailed results can consume significant context. Route cheap work to Haiku to "control costs". — [Subagents](https://code.claude.com/docs/en/sub-agents)
- Trigger to add one: "A side task floods your conversation with output you won't reference again → Route it through a subagent". — [Extend Claude Code](https://code.claude.com/docs/en/features-overview)

### Inferences
- Because subagents don't see the conversation, the delegation message is effectively the subagent's whole brief. The calling prompt (or a `context: fork` skill body) must state the goal, the scope, what counts as done and the shape of the return.
- Asking for a condensed result is a prompt-design choice. The docs' examples always specify an output structure, but I found no explicit official sentence like "return under N words".

### Gaps
- I found no official guidance on a word or token budget for subagent return values.
- I couldn't verify from a primary source when Explore stopped defaulting to Haiku. Older docs are commonly remembered as saying Haiku; the current page says it uses the main conversation's model (with an Opus-alias exception for Fable main models).

---

## Hooks: events, what they're good for, exit codes and JSON output, security cautions

### Takeaway
Hooks are the deterministic layer. Claude Code itself runs your command, HTTP call, MCP tool, prompt or agent at a lifecycle event, so they suit guarantees (block a dangerous edit, format after every edit, verify before stopping, re-inject context after compaction) that a CLAUDE.md instruction can only request. Exit 0 means "no objection", exit 2 blocks with stderr as feedback, and exit 0 with JSON gives structured control. Hooks run with your full user permissions, and in `-p` mode a repo's committed hooks run without a trust prompt.

### Cited Findings

**What they're for, compared with prompts**
- Hooks give "deterministic control: certain actions always happen rather than relying on the LLM to choose to run them." — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- "Use hooks for actions that must happen every time with zero exceptions... Unlike CLAUDE.md instructions which are advisory, hooks are deterministic and guarantee the action happens." Claude can write them for you: "Write a hook that runs eslint after every file edit". — [Best practices](https://code.claude.com/docs/en/best-practices)
- "Put guardrails in hooks. An instruction like 'never edit `.env`' in CLAUDE.md or a skill is a request, not a guarantee. A `PreToolUse` hook that blocks the edit is enforcement." Context cost: "Zero unless the hook returns output." — [Extend Claude Code](https://code.claude.com/docs/en/features-overview)

**Events** — [Hooks guide](https://code.claude.com/docs/en/hooks-guide):
- Session and setup: `SessionStart`, `Setup`, `SessionEnd`.
- Prompts: `UserPromptSubmit`, `UserPromptExpansion` (can block a command or skill expansion).
- Tools and permissions: `PreToolUse` (can block), `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`.
- Notifications and display: `Notification`, `MessageDisplay`.
- Subagents and tasks: `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`.
- Stopping: `Stop`, `StopFailure`.
- Agent teams: `TeammateIdle`.
- Instructions and config: `InstructionsLoaded`, `ConfigChange`.
- Directories and files: `CwdChanged`, `DirectoryAdded`, `FileChanged`.
- Worktrees: `WorktreeCreate`, `WorktreeRemove`.
- Compaction: `PreCompact`, `PostCompact`.
- Models: `PreModelSwitch`, `PostModelSwitch` [v2.1.251+].
- MCP: `Elicitation`, `ElicitationResult`.

**Handler types**
- `command` (the most common), `http`, `mcp_tool`, `prompt` (single-turn LLM judgment returning `{"ok": bool, "reason": ...}`), and `agent` (experimental multi-turn verifier with tools, up to 50 turns). "For production workflows, prefer command hooks." — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- Not every event supports every type. `SessionStart` and `Setup` support only `command` and `mcp_tool`. — [Hooks reference](https://code.claude.com/docs/en/hooks)

**Configuration shape** (settings.json; the same format works in skill and agent frontmatter) — [Hooks guide](https://code.claude.com/docs/en/hooks-guide):
```json
{ "hooks": { "PostToolUse": [ { "matcher": "Edit|Write",
  "hooks": [ { "type": "command", "command": "jq -r '.tool_input.file_path' | xargs npx prettier --write" } ] } ] } }
```
- Matchers are case-sensitive and match per event: tool name for tool events; `startup|resume|clear|compact|fork` for SessionStart; `manual|auto` for compaction. `UserPromptSubmit`, `Stop` and some others have no matcher. The handler-level `if` field uses permission-rule syntax (`"Bash(git *)"`) on tool events only, and is best-effort: "use the permission system rather than a hook to enforce a hard allow or deny." — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- Locations: `~/.claude/settings.json`, `.claude/settings.json` (committable), `.claude/settings.local.json`, managed policy, plugin `hooks/hooks.json`, skill frontmatter (active for the rest of the session once invoked), and subagent frontmatter (only while it runs; there, `Stop` becomes `SubagentStop`). Hooks from all sources merge. `/hooks` browses them and `"disableAllHooks": true` turns them off. — [Hooks guide](https://code.claude.com/docs/en/hooks-guide); [Hooks reference](https://code.claude.com/docs/en/hooks); [Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- A skill-frontmatter hook can set `once: true` to remove itself after its first successful run. — [Hooks reference](https://code.claude.com/docs/en/hooks)

**Exit codes and output**
- Input arrives as JSON on stdin (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, ...). — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- Exit 0 means no decision. A PreToolUse exit 0 "doesn't approve it"; the normal permission flow applies. For `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart` and `PostModelSwitch`, plain stdout is added to Claude's context. — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- Exit 2 blocks where the event allows it, with stderr as the reason. Events that can block on exit 2 include PreToolUse, UserPromptSubmit, Stop (forces continuing), SubagentStop, PreCompact, ConfigChange and PostToolBatch. PostToolUse can't block, because the tool already ran; stderr is shown to Claude. SessionStart only shows stderr to the user. — [Hooks reference](https://code.claude.com/docs/en/hooks)
- Other exit codes are non-blocking errors on most events. — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- "Use exit 2 to block with a stderr message, or exit 0 with JSON for structured control. Choose one approach per hook." — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- JSON on PreToolUse: `hookSpecificOutput.permissionDecision` is `allow`, `deny`, `ask` or `defer` (`defer` only in `-p`), plus `permissionDecisionReason`. — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- When several hooks match, the most restrictive answer wins (deny > defer > ask > allow), and every hook runs anyway. — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- PostToolUse, Stop and similar events use top-level `decision: "block"` + `reason`. `additionalContext` must sit inside `hookSpecificOutput`, or it is "silently" ignored. — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- Common fields: `continue: false` (stop processing; overrides everything), `stopReason`, `systemMessage` (a warning to the user), and `suppressOutput` ("Has no effect"). — [Hooks reference](https://code.claude.com/docs/en/hooks)
- A hook "deny" holds in every permission mode, including `bypassPermissions`. A hook "allow" can't override deny rules from settings. — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)

**Proven use cases (official examples)** — [Hooks guide](https://code.claude.com/docs/en/hooks-guide):
- Desktop notification on `Notification` (a Windows PowerShell MessageBox variant is given).
- Prettier on `PostToolUse` `Edit|Write`.
- Blocking edits to `.env`, `package-lock.json` and `.git/` with a `PreToolUse` script that exits 2.
- Re-injecting conventions after compaction with `SessionStart` matcher `compact`.
- Auditing `ConfigChange`.
- direnv reloads on `CwdChanged` and `FileChanged`.
- Auto-approving `ExitPlanMode` via `PermissionRequest`.
- A `Stop` prompt or agent hook that checks tasks or tests are done.
- Turning verification into a "deterministic gate": "a Stop hook runs your check as a script and blocks the turn from ending until it passes." — [Best practices](https://code.claude.com/docs/en/best-practices)

**Gotchas**
- `Edit|Write` matchers miss files changed through Bash or PowerShell. For full coverage, add a `Stop` hook that scans `git status --porcelain`, or use `FileChanged`. — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- Claude Code overrides a Stop hook that blocks 8 times in a row. Check `stop_hook_active` to avoid loops (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises the cap). — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- Shell-profile echo output before the JSON makes it be treated as plain text. — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- Default timeouts: 10 min for command, http and mcp_tool (30 s for UserPromptSubmit); 30 s for prompt; 60 s for agent; SessionEnd shares 1.5 s. — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- Async hooks (`async: true`) can't block, and their output arrives on the next turn. — [Hooks reference](https://code.claude.com/docs/en/hooks)
- Windows: `"shell": "powershell"` on a command hook (it auto-detects `pwsh.exe`, falling back to `powershell.exe` 5.1). Use `${CLAUDE_PROJECT_DIR}` or `$env:CLAUDE_PROJECT_DIR`, never bare `$CLAUDE_PROJECT_DIR`. An error mentioning missing Git Bash means a failed hook blocked the call. The exec form (`"command": "powershell.exe", "args": [...]`) avoids quoting problems. — [Hooks reference](https://code.claude.com/docs/en/hooks); [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- Debugging: `claude --debug` or `--debug-file <path>`, `/debug` mid-session, and `Ctrl+O` for the transcript view. — [Hooks reference](https://code.claude.com/docs/en/hooks)

**Security**
- "Command hooks execute shell commands with your full user permissions. They can modify, delete, or access any files your user account can access. Review and test all hook commands before adding them to your configuration." — [Hooks reference](https://code.claude.com/docs/en/hooks)
- Workspace trust: interactive sessions hold back hooks from every settings file until the trust dialog is accepted. "`-p` or SDK session: Claude Code never shows the dialog and treats the folder as trusted, so hooks committed in a repository's `.claude/settings.json` run in a folder you've never trusted." Before scripting `claude -p` over a repo you didn't write, review `.claude/`, use `--bare`, or pass `--settings '{"disableAllHooks": true}'`. Project-subagent frontmatter hooks need the trust dialog, and `-p` doesn't count as accepting it. — [Hooks reference](https://code.claude.com/docs/en/hooks)
- Best practices: "Validate and sanitize inputs", "Always quote shell variables", "Block path traversal" (check for `..`), "Use absolute paths", "Skip sensitive files" (`.env`, `.git/`, keys). — [Hooks reference](https://code.claude.com/docs/en/hooks)
- With PermissionRequest auto-approve, "Keep the matcher as narrow as possible. Matching on `.*` or leaving the matcher empty would auto-approve every tool permission prompt". — [Hooks guide](https://code.claude.com/docs/en/hooks-guide)

### Inferences
- The split is simple: judgment goes in prompts and skills, guarantees go in hooks. A PreToolUse deny is the only mechanism here that holds against every permission mode, which makes it the right home for "never touch X" rules.
- Prompt and agent hooks blur that line. They are LLM judgment run at a deterministic point, which suits "is the task really done" checks, but they aren't hard guarantees.

### Gaps
- I didn't read the full per-event input schemas in the hooks reference (the page is about 270K characters). Only the sections quoted above were fetched.

---

## Recommended day-to-day workflow (explore → plan → implement → commit, verification, context management, subagents, multi-Claude)

### Takeaway
Anthropic's guidance rests on one constraint: "Claude's context window fills up fast, and performance degrades as it fills." So:
- Give Claude a pass/fail check it can run.
- Separate exploration and planning (plan mode) from implementation, and skip the plan when the diff fits in one sentence.
- Write specific prompts that name files, patterns and what "done" means.
- Correct course early, and `/clear` between tasks or after two failed corrections.
- Push investigation and review into subagents.
- Scale with headless `-p`, worktrees and writer/reviewer sessions.

### Cited Findings
- Core constraint: "Most best practices are based on one constraint: Claude's context window fills up fast, and performance degrades as it fills." — [Best practices](https://code.claude.com/docs/en/best-practices)
- Verification first: "Give Claude a check it can run: tests, a build, a screenshot to compare. It's the difference between a session you watch and one you walk away from." There are four gates — [Best practices](https://code.claude.com/docs/en/best-practices):
  - Inside one prompt.
  - A `/goal` condition, re-checked by a separate evaluator after every turn.
  - A Stop hook, as a deterministic gate.
  - A verification subagent or dynamic workflow, so "the agent doing the work isn't the one grading it".
  - Also: "Have Claude show evidence rather than asserting success". Example: "write a validateEmail function. example test cases: user@example.com is true, invalid is false... run the tests after implementing"; for UI, "[paste screenshot]... take a screenshot of the result and compare it".
- Explore → Plan → Implement → Commit — [Best practices](https://code.claude.com/docs/en/best-practices):
  - Enter plan mode with `Shift+Tab` (or `claude --permission-mode plan`), and have Claude read and answer questions without changing anything.
  - Ask for a detailed plan, and press `Ctrl+G` to edit it in your editor.
  - Approve and implement "verifying against its plan" ("write tests..., run the test suite and fix any failures").
  - "commit with a descriptive message and open a PR".
  - When to skip: "If you could describe the diff in one sentence, skip the plan." Planning matters most when you're unsure of the approach, the change spans multiple files, or the code is unfamiliar.
- Specific prompts: scope the task ("covering the edge case where the user is logged out. avoid mocks"), point to sources (git history), reference existing patterns ("HotDogWidget.php is a good example"), and describe the symptom with what "fixed" looks like ("write a failing test that reproduces the issue, then fix it"). Use `@file`, pasted images, URLs and piping (`cat error.log | claude -p ...`). — [Best practices](https://code.claude.com/docs/en/best-practices)
- Interview, then a spec: "Interview me in detail using the AskUserQuestion tool... then write a complete spec to SPEC.md." Then "start a fresh session to execute it." Good specs "name the files and interfaces involved, state what is out of scope, and end with an end-to-end verification step". — [Best practices](https://code.claude.com/docs/en/best-practices)
- Course-correcting — [Best practices](https://code.claude.com/docs/en/best-practices):
  - `Esc` stops Claude mid-action with context kept.
  - `Esc Esc` or `/rewind` restores conversation and/or code, or summarizes from a chosen point.
  - "Undo that".
  - `/clear` between unrelated tasks.
  - "If you've corrected Claude more than twice on the same issue in one session... Run `/clear` and start fresh with a more specific prompt."
- Context management: `/clear` often; `/compact <instructions>`; partial summarize via rewind ("Summarize from here", "Summarize up to here"); `/btw` for side questions that never enter history; `/context` and a status line to watch usage. — [Best practices](https://code.claude.com/docs/en/best-practices)
- Checkpoints "only track changes made through Claude's file editing tools... This isn't a replacement for git." Name sessions with `/rename` and resume with `claude --continue` or `--resume`. — [Best practices](https://code.claude.com/docs/en/best-practices)
- Subagents for investigation: "Use subagents to investigate how our authentication system handles token refresh, and whether we have any existing OAuth utilities I should reuse." — [Best practices](https://code.claude.com/docs/en/best-practices)
- Adversarial review: "Before treating a task as done, have a subagent review the diff in a fresh context and report gaps." The bundled `/code-review` does a correctness check, or you can write your own review against PLAN.md. The caution: a reviewer asked to find gaps "will usually report some, even when the work is sound... Chasing every finding leads to over-engineering". Tell it to "flag only gaps that affect correctness or the stated requirements". — [Best practices](https://code.claude.com/docs/en/best-practices)
- Permissions: auto mode is "the built-in starting permission mode" for interactive terminal and VS Code sessions from v2.1.283; a classifier reviews actions. Use `/permissions` allowlists and `/sandbox`, and switch to Manual mode to approve every action yourself. — [Best practices](https://code.claude.com/docs/en/best-practices)
- CLI tools are "the most context-efficient way to interact with external services" (for example `gh`). — [Best practices](https://code.claude.com/docs/en/best-practices)
- Multi-Claude — [Best practices](https://code.claude.com/docs/en/best-practices):
  - Worktrees, cross-session messaging, the desktop app, cloud sessions, agent view (`claude agents`, research preview) and agent teams (experimental, off by default).
  - Writer/Reviewer: session A implements, session B reviews `@src/middleware/rateLimiter.ts`, and A addresses the feedback. "A fresh context improves code review since Claude won't be biased toward code it just wrote." Or one Claude writes tests and another writes code to pass them.
- Headless and fan-out — [Best practices](https://code.claude.com/docs/en/best-practices):
  - `claude -p "..." --output-format json|stream-json`.
  - `/batch <instruction>` splits work across 5–30 subagents, each in its own worktree.
  - Or loop `claude -p` with `--allowedTools` and `--permission-mode dontAsk`: "Test on a few files, then run on all of them."
- Failure patterns — [Best practices](https://code.claude.com/docs/en/best-practices):
  - The kitchen sink session: fix with `/clear`.
  - Correcting over and over: after two failed corrections, `/clear` and write a better prompt.
  - The over-specified CLAUDE.md: prune, or convert to hooks.
  - The trust-then-verify gap: "If you can't verify it, don't ship it."
  - The infinite exploration: scope narrowly, or use subagents.
- Building the setup over time, by trigger — [Extend Claude Code](https://code.claude.com/docs/en/features-overview):
  - Convention wrong twice → CLAUDE.md.
  - Same format request repeatedly → output style.
  - Same opening prompt → user-invocable skill.
  - Same playbook pasted for the third time → skill.
  - Copying data from a browser tab → MCP.
  - Lots of symbol hunting → code intelligence plugin.
  - Side task floods context → subagent.
  - Must happen every time → hook.
  - A second repo needs the same setup → plugin.

### Inferences
- The workflow and the building blocks fit together. CLAUDE.md and rules supply standing context. Skills package repeated phases (for example a `/fix-issue` with a verify step). Subagents handle the explore and review phases. Hooks enforce the verification gate. Plugins carry the whole kit to the next repo.

### Gaps
- I didn't fetch the April 2025 Anthropic engineering blog post "Claude Code best practices" separately. The docs page fetched here is the maintained current version, and most of its advice (explore-plan-code-commit, writer/reviewer, headless fan-out) matches that post as I remember it, but I didn't verify this.
- The `/goal` and dynamic-workflow features are mentioned but weren't researched in depth.

---

## Output styles and plugins (brief)

### Takeaway
An output style replaces or extends the system prompt's response behavior (role, tone, format) for a whole session. Use one for "how Claude answers", never for project facts. Custom styles drop Claude Code's built-in coding instructions unless `keep-coding-instructions: true`. A plugin is the packaging layer: a directory with `.claude-plugin/plugin.json` that bundles skills, agents, hooks, MCP servers and output styles as one installable, namespaced unit. Reach for one when a second repo or a teammate needs the same setup.

### Cited Findings

**Output styles**
- An output style "sets Claude's role, tone, and response format for every response in a session." The built-ins are Default (no style), Proactive (starts work, makes routine assumptions), Concise [v2.1.237+] (leads with the result, no preamble or recaps), Explanatory (`★ Insight` blocks) and Learning (Insights plus `TODO(human)` pieces for you to write). — [Output styles](https://code.claude.com/docs/en/output-styles)
- File format: Markdown at `~/.claude/output-styles/`, `.claude/output-styles/` or a managed location. Frontmatter: `name`, `description`, `keep-coding-instructions` (default false), and `force-for-plugin` (plugin styles only). Example: `name: Diagrams first` / `keep-coding-instructions: true` / body "When explaining code... start with a Mermaid diagram". — [Output styles](https://code.claude.com/docs/en/output-styles)
- Without `keep-coding-instructions: true`, custom styles leave out Claude Code's built-in software-engineering instructions ("how to scope changes, write comments, and verify work"). — [Output styles](https://code.claude.com/docs/en/output-styles)
- Switching: `/output-style <style>` [v2.1.269+ for non-interactive mode and the SDK], `/config`, or `"outputStyle": "Explanatory"`. The settings value is case-sensitive; a mismatch silently falls back to Default. A new style applies from the next message [v2.1.251+]. In the terminal, edited style files need a restart. — [Output styles](https://code.claude.com/docs/en/output-styles)
- Styles apply to the main conversation and forks, not to other subagents. Style instructions add input tokens on every request. — [Output styles](https://code.claude.com/docs/en/output-styles)
- Choosing: an output style when you want "Every response in a certain voice, length, or format, or Claude in a different role"; CLAUDE.md for project facts; a skill for one kind of task; a hook for guarantees; `--append-system-prompt` for launch-time additions. "An output style gives Claude instructions to follow. It doesn't guarantee that something always happens or never happens." — [Output styles](https://code.claude.com/docs/en/output-styles)
- Trigger: "You keep asking Claude to be shorter, explain more, or answer in the same format → Set an output style". — [Extend Claude Code](https://code.claude.com/docs/en/features-overview)

**Plugins**
- "A Claude Code plugin is a directory of skills, agents, hooks, MCP servers, or other components that Claude Code installs and loads as one unit." The manifest is `.claude-plugin/plugin.json`. Components: `skills/<name>/SKILL.md` (run as `/my-plugin:review`), `agents/*.md`, `hooks/hooks.json`, `.mcp.json`, a hooks module (a "mod", JavaScript functions that can draw panes and add commands), and `output-styles/`. — [Plugins](https://code.claude.com/docs/en/plugins); [Output styles](https://code.claude.com/docs/en/output-styles)
- When to use: "Skills, subagents, hooks, and MCP servers all work on their own, without a plugin... Use a plugin when you want several skills, subagents, hooks, or MCP servers packaged as one unit." Trigger: "A second repository needs the same setup → Package it as a plugin". — [Plugins](https://code.claude.com/docs/en/plugins); [Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- Cost: an enabled plugin is "part of every session". Model-invocable skill and agent descriptions sit in context on every turn, its MCP servers run, and its hooks fire. "What the plugin runs, it runs as you." Disable a plugin with `/plugin` or `claude plugin disable`. — [Plugins](https://code.claude.com/docs/en/plugins)
- Distribution: a marketplace is a `.claude-plugin/marketplace.json` catalog. The official `claude-plugins-official` is added on first interactive run. Install scopes are user, project (committed `.claude/settings.json`) or local. Develop without a marketplace using `--plugin-dir`. Tooling: `claude plugin validate`, `claude plugin eval`, `/reload-plugins`. — [Plugins](https://code.claude.com/docs/en/plugins); [Skills](https://code.claude.com/docs/en/skills)
- Plugin subagents ignore `permissionMode`, `mcpServers` and `hooks` frontmatter. — [Subagents](https://code.claude.com/docs/en/sub-agents)

### Inferences
- For a single user with a hub-and-projects layout, a plugin is the official alternative to copying a skill and agent library into `~/.claude` with a sync script. Plugin skills are namespaced, though (`/plugin:skill`), which changes how they're invoked.

### Gaps
- I didn't fetch the plugin manifest reference or the create-plugin page, so the full list of `plugin.json` fields isn't covered here.

---

## Choosing between the building blocks (cross-cutting)

### Takeaway
Pick the building block by when it loads and whether it's enforced:
- CLAUDE.md and unscoped rules: always loaded, advisory.
- Path-scoped rules: loaded when matching files are touched.
- Skills: description always loaded, body on demand.
- Output styles: always loaded, about response style.
- Subagents: separate context, return a summary.
- Hooks: run outside the model, deterministic.
- Plugins: package any of the above.

### Cited Findings
- Context cost by feature — [Extend Claude Code](https://code.claude.com/docs/en/features-overview):
  - CLAUDE.md: full content, every request.
  - Output style: every request.
  - Skills: descriptions every request, full content when used; zero for `disable-model-invocation`.
  - MCP: tool names; schemas on demand.
  - Subagents: isolated.
  - Hooks: zero unless they return output.
- Layering — [Extend Claude Code](https://code.claude.com/docs/en/features-overview):
  - CLAUDE.md files are additive, and Claude reconciles conflicts by judgment.
  - Skills and subagents override by name (skills: managed > user > project; subagents: managed > CLI > project > user > plugin).
  - MCP overrides by name (local > project > user).
  - Hooks merge.
- Comparisons — [Extend Claude Code](https://code.claude.com/docs/en/features-overview):
  - Skill vs subagent: a skill "adds to your main window"; a subagent "uses a separate window... only summary returns".
  - CLAUDE.md vs skill: "Put it in CLAUDE.md if Claude should always know it... Put it in a skill if it's reference material Claude needs sometimes... or a workflow you trigger with `/<name>`."
  - Hook vs skill: use a hook "when the action must happen the same way every time and doesn't need Claude to think"; use a skill "when Claude should decide how to apply the steps".
  - MCP vs skill: MCP gives the connection, and a skill teaches how to use it well.
  - They combine: a subagent can preload skills (`skills:`), and a skill can run in a subagent (`context: fork`).
- Anthropic's blog post "Steering Claude Code: when to use CLAUDE.md, skills, hooks, and subagents" is linked from the docs as a deeper walkthrough: https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more — [Extend Claude Code](https://code.claude.com/docs/en/features-overview) (I didn't fetch the post itself).

### Inferences
- A practical decision order for any new piece of guidance:
  1. Must it always happen? Use a hook.
  2. Is it a fact needed every session? Use CLAUDE.md.
  3. Does it matter only for some files? Use a path-scoped rule.
  4. Is it a procedure or reference needed sometimes? Use a skill, with `disable-model-invocation` if it has side effects.
  5. Is it noisy, self-contained work? Use a subagent.
  6. Is it about the tone or format of every reply? Use an output style.
  7. Does it need sharing across repos or people? Use a plugin.

### Gaps
- I didn't read the "Steering Claude Code" blog post, so any extra decision guidance there isn't captured.
