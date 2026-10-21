# Prompt and pipeline best practices

2026-10-21, Claude Code 2.1.306

## Summary

- **Write briefs, not commands.** Current models (Opus 5 and 5.5, Sonnet 5 and 5.5, Fable 5 and 5.1) follow instructions literally and react strongly to emphasis. A good prompt, skill or agent states the goal, why it matters, the exact scope, what "done" means and the output shape. Say each thing once and calmly. Habits from 2024-2025 (CRITICAL/MUST, "double-check your work", "write your reasoning in `<thinking>` tags", assistant prefill) now cause overtriggering, over-verification, refusals or 400 errors.
- **Build a pipeline only where you need to see or gate the middle.** One good prompt usually beats a chain. If you do chain, give each step one goal, a typed output contract, a gate written in code and a round cap, and pass work between steps as files and paths.
- **Prompts advise; tools enforce.** CLAUDE.md, rules, skills and output styles are advice the model weighs. Tests, Stop and PreToolUse hooks, JSON schemas, `--allowedTools` and `--max-budget-usd` are guarantees. The strongest single lever is a pass/fail check Claude can run.
- **Biggest risk for this workspace:** runs that end with no runnable check. Then "looks done" is the only signal, and the workspace app has no verification step and keeps no output to catch a bad run.
- **The workspace app** handles the single, interactive, fresh-session flow well, including reference images and safe prompt passing. It has no per-flow model, effort or permission mode, no headless runs or captured output, no chaining and no verification step. Recommended next step: per-flow launch settings and labeled images (both small), then a headless run mode and multi-step flows.

**How to read this report.** Sources are Anthropic's current docs (platform.claude.com and code.claude.com/docs, fetched 2026-10-21), Anthropic engineering posts (each dated), and Microsoft's PowerShell docs. Some blog posts predate the current models. Where they differ from the newer model-specific pages, the newer pages win. Labels used:

- **[local]**: confirmed in `claude --help` on this machine (2.1.306).
- **[constructed]**: a PowerShell 5.1 example written from the docs. Not run.
- **(synthesized)**: a template or rule combined from cited guidance. Not an Anthropic quote.
- **unverified**: the researchers could not confirm it in a primary source.

Version tags such as v2.1.302+ are the minimum versions the docs give. "Building effective agents" is dated December 2024 but names later models, and what was revised in it is unverified.

## Current models do what you say, so say it once, with the reason and the scope

Anthropic's mental model is "a brilliant but new employee who lacks context on your norms and workflows." Its golden rule: show the prompt to a colleague with minimal context, because "If they'd be confused, Claude will be too" ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)). Three habits follow from this.

**Give the reason, not only the rule.** "Never use ellipses" works less well than explaining that a text-to-speech engine will read the output, because "Claude is smart enough to generalize from the explanation" ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).

**State the scope outright.** Sonnet 5 "does not silently generalize an instruction from one item to another, and it does not infer requests you didn't make", so write "Apply this formatting to every section, not just the first one" ([Prompting Claude Sonnet 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5)).

**Use the verb you mean.** "Can you suggest some changes" gets suggestions. "Change this function" gets edits ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).

Literalism also turns soft filters into hard ones. Tell a reviewer to "only report high-severity issues" or to "be conservative" and it obeys. Recall drops, even though the model finds more bugs than before. Instead, ask for every finding with its severity and confidence and filter in a separate step, or give a concrete bar ([Prompting Claude Sonnet 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5); [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)).

**Put the whole spec in the first turn.** On Sonnet 5, an underspecified request filled in over several turns lowers token efficiency and sometimes quality. Opus 5 "performs best when given the complete task specification up front and left to run" ([Prompting Claude Sonnet 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5); [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)).

**Fence the scope.** Opus 5 and Fable 5.1 tend to widen it. Anthropic's suggested line: "If the request seems mistaken or a better approach exists, say so in a sentence and continue with the task as asked rather than quietly narrowing, widening, or transforming it" ([Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)). When you want an assessment and no changes, say so. Fable's guidance is "Report your findings and stop. Don't apply a fix until they ask for one" ([Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5)).

Since 2025 the advice has been to cut prompt text, not add it. Models from Opus 4.5/4.6 on are "more responsive to the system prompt than previous models", so prompts written to fight undertriggering now overtrigger ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)). Anthropic also warns that "Skills developed for prior models are often too prescriptive for Claude Fable 5 and can degrade output quality" ([Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5)).

| Old habit | Replace with | Why |
|---|---|---|
| "CRITICAL: You MUST use this tool when..." | "Use this tool when..." | 4.5/4.6+ models overtrigger on emphasis ([BP](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)) |
| "If in doubt, use [tool]" | "Use [tool] when it would enhance your understanding of the problem" | Same ([BP](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)) |
| "Think step by step and write your reasoning in `<thinking>` tags" | Rely on built-in thinking, raise effort, ask for "a short explanation of the answer" | May be declined as `reasoning_extraction` on Opus 5/5.5, Sonnet 5.5 and Fable 5.x ([Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)) |
| Assistant prefill to force JSON or skip the preamble | Structured outputs or `--json-schema`; "Respond directly without preamble" | Prefill returns a 400 error from the Claude 4.6 models on ([BP](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#migrating-away-from-prefilled-responses)) |
| "Do not use markdown" | "Your response should be composed of smoothly flowing prose paragraphs" | Positive instructions steer better ([BP](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)) |
| "Only report high-severity issues" | Report everything with severity and confidence, then filter in a second step | Literal filtering cuts recall ([Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)) |
| "Double-check your work" or "use a subagent to verify" (Opus 5) | Delete it and keep an external check | Causes over-verification ([Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)) |
| "After every 3 tool calls, summarize progress" (Sonnet 5) | Delete it | Redundant scaffolding now ([Sonnet 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5)) |
| "Avoid a generic look" | Name the exact patterns to avoid, or ask for 4 distinct options first | Generic negatives swap one default for another ([Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)) |
| `temperature` for variety (Sonnet 5) | Ask for several options in the prompt | Non-default sampling parameters return a 400 error on Sonnet 5 ([Sonnet 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5)) |

### A brief that works across current models (synthesized)

```text
<context>
I'm working on <larger task> for <who>. They need <what the output enables>.
Facts Claude can't infer: <paths, constraints, decisions already made>.
</context>

<task>
<One sentence with the verb you mean: "Change...", "Review...", "Report...">
Scope: <every file under X / only section Y>. Out of scope: <...>.
If the request looks mistaken, say so in one sentence and continue as asked.
</task>

<done_when>
<A check Claude can run and its expected result, for example "npm test passes">
Show evidence: the command you ran and what it returned.
</done_when>

<output>
<Where to write it, format, rough length. One short example if the format matters.>
</output>
```

The skeleton combines several cited pieces: the Fable 5 intent template ("I'm working on [the larger task] for [who it's for]. They need [what the output enables]"), the Opus 5 scope line, Claude Code's "show evidence" rule, and XML sections ([Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5); [Claude Code best practices](https://code.claude.com/docs/en/best-practices)). For large inputs, put the documents first and this block last (next subsection).

### Structure, examples and format control

**XML tags** "help Claude parse complex prompts unambiguously, especially when your prompt mixes instructions, context, examples, and variable inputs." Use consistent, descriptive tag names, and nest documents as `<documents><document index="1"><source>...</source><document_content>...</document_content></document></documents>` ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).

**Long inputs (over about 20k tokens).** Put the documents at the top and the question, instructions and examples at the end. Anthropic measured that "Queries at the end can improve response quality by up to 30 percent in tests". That figure carries no model or date and has not been confirmed on the 5.x models. Asking Claude to pull relevant quotes into `<quotes>` tags first also helps it ignore the rest ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#long-context-prompting)).

**Examples** are "one of the most reliable ways to steer Claude's output format, tone, and structure." Use 3 to 5, relevant and diverse, wrapped in `<example>` tags ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)). Positive examples work better than "don't" instructions ([Prompting Claude Sonnet 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5)). A single annotated example with a `<rationale>` line explaining why it is correct helps the model generalize the principle rather than copy the surface ([Prompting Claude Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1)). For reusable templates, Anthropic's own examples still use double-brace placeholders such as `{{ANNUAL_REPORT}}` inside XML slots ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).

**Format advice now depends on the model, and it points in opposite directions.**

- Opus 5 runs long, and changing effort does not reliably change that, so ask for concision explicitly. In long system prompts, add a short `<tone_preference>` reminder near the end ([Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)).
- Fable 5.1 already formats less, so a pasted anti-markdown block "can suppress structure the content needs" ([Prompting Claude Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1)).
- Matching the prompt's style to the output you want works on all models: less markdown in the prompt means less in the reply ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).

## Effort, not magic words, sets how hard Claude thinks

On current models, thinking is adaptive and **effort is the main control**.

- Thinking is always on for Opus 5.5 and the Fable/Mythos 5.x models. It is on by default for Opus 5, Sonnet 5/5.5 and Haiku 5.5.
- `budget_tokens` is deprecated on the 4.6 models and returns a 400 error on 4.7 and later.
- Anthropic prefers general instructions to prescriptive ones: "A prompt like 'think thoroughly' often produces better reasoning than a hand-written step-by-step plan" ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).

To change how deeply Claude reasons, change effort before you add prompt text. For Opus 5.5: "To get less thinking, lower the effort level first". For Sonnet 5: "raise effort to `high` or `xhigh` rather than prompting around it" ([Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5); [Prompting Claude Sonnet 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5)). Effort names don't mean the same amount of thinking across models: Opus 5.5 at `medium` matches or beats Opus 5 at `high` ([Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)).

In Claude Code, **`ultrathink` is the only keyword**. It adds an in-context instruction for that turn without changing the effort sent to the API. "think", "think hard" and "think more" are passed through as ordinary prompt text ([Claude Code model config](https://code.claude.com/docs/en/model-config)).

You can set effort with `/effort`, `claude --effort <level>`, `CLAUDE_CODE_EFFORT_LEVEL`, `effortLevel` in settings, or an `effort` field in skill or subagent frontmatter. Defaults in Claude Code 2.1.30x:

- `high` on most effort-capable models.
- `medium` on Opus 5.5, Sonnet 5.5 and Haiku 5.5.
- `xhigh` on Opus 4.7.

The docs warn that "`max` may show diminishing returns and is prone to overthinking" ([Claude Code model config](https://code.claude.com/docs/en/model-config)).

| Model | Watch for | Adjust |
|---|---|---|
| Opus 5 | Long answers; verifies its own work; delegates readily; takes review filters literally; 1M-token context | Ask for concision; remove verification and "double-check" lines; add a when-to-delegate rule plus a hard cap |
| Opus 5.5 | Default effort `medium`; thinking always on | Lower effort to cut thinking. Drop "think carefully" lines from chat prompts: in Anthropic's test, replies started sooner "with no clear decline in the quality" |
| Sonnet 5 | Very literal, especially at low effort; no `temperature`; about 30% more tokens for the same text | Name the scope; raise effort instead of prompting; leave `max_tokens` headroom |
| Fable 5 / 5.1 | Brief instructions are enough; old skills too prescriptive. 5.1 formats less, may make one tool call per turn, and answers from memory at low effort | Trim skills. Nudge it to request every independent item in one response. Add "search before answering" for names it doesn't recognize |

Sources for the table: the per-model pages for [Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5), [Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5), [Sonnet 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5), [Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5) and [Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1). The Sonnet 5.5, Haiku 5.5 and Opus 4.8 pages were not fetched. Anthropic's own caveat applies to everything in this section: treat a model-named technique "as measured on that model and re-check it against your own evals before applying it to another" ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)). To build those evals, start with clear success criteria and 20 to 50 automated test cases, and prefer volume over hand-graded polish ([Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests); [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).

## Build a pipeline only where you need to see or gate the middle

Anthropic separates *workflows*, where "LLMs and tools are orchestrated through predefined code paths", from *agents*, which "dynamically direct their own processes and tool use". It advises starting with the simplest option, often a single well-prompted call with retrieval and examples ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)). The current docs narrow the case for chaining further: "With adaptive thinking and subagent orchestration, Claude handles most multistep reasoning internally. Explicit prompt chaining ... is still useful when you need to inspect intermediate outputs or enforce a specific pipeline structure" ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).

| Pattern | Use it when | In Claude Code terms (synthesized) |
|---|---|---|
| One call | Usually the right answer | One prompt, or a skill |
| Prompt chain | Fixed stages you want to inspect or gate (outline, then check, then write) | Separate sessions or `claude -p` steps with handoff files |
| Routing | Inputs fall into categories that are better handled separately | A classifier step that picks the next prompt or model |
| Parallelization | Independent subtasks (sectioning), or several opinions (voting) | `/batch`, a `claude -p` fan-out loop, dynamic workflows |
| Orchestrator-workers | Subtasks can't be known in advance | Subagents, dynamic workflows |
| Evaluator-optimizer | Clear criteria, and iterating measurably helps | Reviewer subagent, Stop hook, `/goal` |
| Autonomous agent | Open-ended work whose path can't be scripted | An interactive session with checks and caps |

The pattern names and "use when" column come from [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents).

**When multi-agent doesn't pay.** It is a poor fit when the value doesn't justify about 15 times the tokens of a chat, when agents must share one context, or for "most coding tasks", which have few parallel steps ([Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)).

**When a dynamic workflow fits.** Claude Code recommends one "when a task needs more agents than one conversation can coordinate, or when you want the orchestration codified as a script you can read and rerun." The script holds the loop and the intermediate results, so Claude's context holds only the final answer. A workflow can't take user input mid-run ("For sign-off between stages, run each stage as its own workflow"). It runs at most 16 agents at once by default and at most 1,000 per run ([Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows)).

### Every step needs one goal, a contract and a gate

The most common chain is self-correction: draft, review against criteria, then refine. "Each step is a separate API call so you can log, evaluate, or branch at any point" ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)). Between steps, put programmatic "gates" that check the intermediate output ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)). Choose the handoff format by who reads it next:

| Next reader | Hand off as | Source |
|---|---|---|
| Code | JSON that matches a schema: `output_config.format` in the API, `--json-schema` in the CLI, `agent(prompt, {schema})` in workflows | [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs); [headless](https://code.claude.com/docs/en/headless); [workflows](https://code.claude.com/docs/en/workflows) |
| The next LLM step | Prose inside named XML tags | [BP](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) |
| A human, or anything large | A file, passing only its path. Subagents should "store their results externally and pass lightweight references back" | [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) |
| State across sessions | A JSON state file, a free-text progress note, and git | [BP](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) |

**Structured outputs.** They constrain decoding to your schema and are GA. Their limits ([Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)):

- Every object needs `additionalProperties: false`.
- Numeric and length constraints are not supported, and neither are recursive schemas.
- A `max_tokens` stop or a refusal can still return output that doesn't match the schema.
- Don't add a "reasoning" field. Asking for step-by-step reasoning in the output can trigger a `reasoning_extraction` refusal, so use a short `summary` field instead ([Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)).

**Step-design rules (synthesized from the sources above):**

1. Give each step one goal, stated in one sentence.
2. Tell it its position and what it must not do ("step 2 of 4; don't rewrite, only check").
3. Wrap each upstream artifact in its own tag.
4. Gate in code: parse the output, validate enums and counts, then route.
5. Log every step's input and output, so you can rerun one step on its own.
6. Cap every loop.

Here is an outline-check gate written that way:

```text
<role>You are step 2 of 4 in a report pipeline: the outline checker.</role>
<outline>{{step1.outline}}</outline>
<questions>{{user.key_questions}}</questions>
<criteria>
- Every key question has exactly one section.
- No two sections cover the same ground.
- Each section names at least one source it will draw on.
</criteria>
<instructions>Check the outline against each criterion. Do not rewrite it.
If a criterion fails, name the section and the smallest fix.</instructions>
```

Return format: `{"verdict": "pass"|"revise", "issues": [{"section","criterion","fix"}], "summary": "..."}`. Then gate in code: if the verdict is `revise` and fewer than 2 rounds have run, send `issues` back to step 1. Otherwise escalate to a human.

### Delegation briefs decide whether subagents help

**The evidence for multi-agent comes from older models.** Anthropic's research system (an Opus 4 lead with Sonnet 4 subagents) beat a single Opus 4 agent by 90.2% on an internal eval. It used about 15 times the tokens of a chat, and on BrowseComp, token usage alone explained about 80% of the variance in performance ([Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)). No figures for the current model generation were found.

**What made it work:**

- Each subagent got an objective, an output format, tool guidance and clear task boundaries. Without them, subagents duplicated each other's work.
- The lead prompt scaled effort with explicit numbers: one agent with 3 to 10 tool calls for a simple fact, 2 to 4 subagents for a comparison, 10 or more for complex research.
- Searches started broad, then narrowed.

Subagents should return "a condensed, distilled summary of its work (often 1,000-2,000 tokens)" ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

**Today's models lean toward over-delegating.** Opus 5 delegates "more readily", and Anthropic warns this "multiplies cost and time when applied to small tasks". Its damping line is "Delegate to a subagent only for large tasks that are genuinely independent and parallelizable", together with "do not use subagents to verify or double-check your own work". Back it with the hard caps `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (Claude Code 2.1.217+) ([Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)). Fable 5 and 5.1 go the other way: delegate more, and keep the lead working while subagents run ([Prompting Claude Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1)).

A delegation brief (synthesized):

```text
<objective>The one question this subagent answers, and why it matters to the whole task.</objective>
<scope>In: ... Out (another agent covers it): ...</scope>
<sources_and_tools>Prefer X. Start with short, broad queries, then narrow. Budget about 10-15 tool calls.</sources_and_tools>
<output_format>Write full notes to <absolute path>. Return at most 300 words: findings with sources, confidence, gaps.</output_format>
<stop_when>The question is answered with sources, or the budget is spent. Report gaps rather than guessing.</stop_when>
```

## A check Claude can run beats any instruction to be careful

Claude Code's best-practices page puts it plainly: "Claude stops when the work looks done. Without a check it can run, 'looks done' is the only signal available, and you become the verification loop." A check is anything that returns a signal Claude can read: a test suite, a build exit code, a linter, a script that diffs output against a fixture, or a screenshot compared against a design. The page lists four ways to apply one, from weakest to strongest ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)):

| Gate | How it works | Strength |
|---|---|---|
| In the prompt | "run the tests after implementing", with concrete test cases | Advisory |
| `/goal` | A condition re-checked by a separate evaluator after every turn | Holds for the whole session |
| Stop hook | A script blocks the turn from ending until the check passes | Deterministic |
| Second opinion | A fresh-context verification subagent or workflow tries to refute the result | Independent of the worker |

**Ask for evidence, not claims.** Have Claude show "the test output, the command it ran and what it returned, or a screenshot" ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)). Fable 5's version is "audit each claim against a tool result from this session", which in Anthropic's testing "nearly eliminated fabricated status reports" ([Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5)). Also say that tests verify correctness rather than define the solution, and that Claude should report a bad test instead of working around it ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).

**Limit reviewers.** "A reviewer prompted to find gaps will usually report some, even when the work is sound ... Chasing every finding leads to over-engineering." Restrict it to correctness and the stated requirements ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)).

**Choose graders deliberately** ([Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)):

- Use code-based checks first.
- For subjective qualities, give each dimension its own isolated LLM judge, and give the judge an "Unknown" option.
- Calibrate judges against human ratings.
- "grade what the agent produced, not the path it took."
- A 0% pass rate across many trials usually means the task is broken, not the agent.
- Where consistency matters, measure pass^k (every one of k trials passes). At 75% success per trial, all three of three trials pass only about 42% of the time.

**Every loop needs a stop rule.** The cookbook's evaluator-optimizer loop stops only on PASS and has no maximum iteration count ([claude-cookbooks evaluator_optimizer](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/evaluator_optimizer.ipynb)). Claude Code's workflow examples instead say "until the type check passes or two rounds in a row make no progress" ([Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows)). A loop contract (synthesized):

- The evaluator returns `pass`, `revise` or `fail`.
- Stop on `pass`. Escalate to a human on `fail`.
- Stop after 2 to 3 rounds, or when the same feedback comes back twice.
- Pass forward the running list of unresolved items, not only the latest feedback. The cookbook passes only the latest, which lets earlier issues come back.

No Anthropic source gives a numeric iteration limit.

## Context is a budget: load little up front and point to the rest

Context engineering means curating everything in the context window: system prompt, tools, examples, message history and retrieved data. The goal is "the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome", because recall declines as the token count grows ("context rot") ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Claude Code's docs say it more bluntly: "Claude's context window fills up fast, and performance degrades as it fills" ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)).

**The toolkit** ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)):

- A system prompt at the "right altitude": between brittle if-else rules and vague guidance. Split it into sections, and add to it only when you see a failure.
- A few diverse, canonical examples instead of long lists of edge-case rules.
- Just-in-time retrieval: keep identifiers (paths, queries, links) in context and load the data with tools when needed. Pre-load a small core, such as CLAUDE.md.
- Compaction, external notes, and subagents working in clean context windows.

**Tool design** ([Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents); [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)):

- A few high-impact tools whose jobs don't overlap.
- Return names rather than UUIDs, and offer a concise response format.
- Paginate and truncate output.
- Write error messages that say what to do next.
- Require absolute paths.

**Session habits in Claude Code** ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)):

- `/clear` between unrelated tasks.
- `/compact <instructions>` to steer a compaction.
- `/btw` for side questions that never enter the history.
- "If you've corrected Claude more than twice on the same issue in one session ... Run `/clear` and start fresh with a more specific prompt."
- A CLAUDE.md line such as "When compacting, always preserve the full list of modified files and any test commands" steers what compaction keeps.

The root CLAUDE.md is re-read after `/compact`, but instructions given only in the conversation are lost ([Memory](https://code.claude.com/docs/en/memory)).

### Long jobs survive on files and git, not on the context window

For work that spans many context windows, Anthropic's harness has two prompts ([Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)):

- **First session:** create `init.sh`, a JSON feature list with every feature marked failing, a progress log, and a first git commit.
- **Every later session:** read the state, run a smoke test, build one feature, verify it end to end, commit, and update the notes.

The feature list is JSON "because models are less likely to inappropriately overwrite it than Markdown" (same source). The current docs go further: "consider starting with a brand new context window rather than using compaction. Claude's latest models are extremely effective at discovering state from the local filesystem" ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)). If your harness does compact, tell the model, so it doesn't stop early to save tokens (same source).

Specs also make good handoffs. Have Claude interview you and write `SPEC.md`, then "start a fresh session to execute it". The best specs "name the files and interfaces involved, state what is out of scope, and end with an end-to-end verification step that proves the feature works" ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)).

A minimal handoff note (synthesized). Compare it with what the workspace's `/write-handoff` skill produces:

```text
# Handoff: <task> (session N, YYYY-MM-DD)
Goal / done criteria: <one line + link to SPEC.md or features.json>
State: <branch, last commit, what passes now (command + result)>
Done this session: <items>
Next: <the single next item, by id>
Known broken / open questions: <items>
Do not: <invariants, e.g. don't edit tests>
Startup: pwd; read this file and git log -10; run <smoke command>
```

Rule of thumb (synthesized): compact when you are in the middle of one problem and the history is valuable. Start fresh with a handoff file when you switch phases, after repeated failed corrections, or whenever the state is fully captured in files and git. No Anthropic source compares the two quantitatively.

## Claude Code's building blocks: advice that loads, guarantees that run

| Block | When it loads | Enforced? | Use it for |
|---|---|---|---|
| CLAUDE.md and unscoped `.claude/rules/` | Every session, in full, as a user message after the system prompt | No, advisory | Facts needed every session: commands, non-default conventions, gotchas |
| Path-scoped rule (`paths:`) | When Claude touches a matching file | No | Rules for one part of the codebase |
| Skill | Description always (unless `disable-model-invocation`); body when used | No | Procedures and reference material needed sometimes |
| Subagent | Its own fresh context; only a summary comes back | Tool limits yes; behavior no | Noisy, self-contained work, and tool restrictions |
| Hook | Runs outside the model; costs no context unless it prints output | Yes, deterministic | Anything that must always or never happen |
| Output style | Every request | No | Voice, length and format of every reply |
| Plugin | Whatever it bundles, every session | Depends on contents | Sharing one setup across repos |

Sources for the table: [Extend Claude Code](https://code.claude.com/docs/en/features-overview); [Memory](https://code.claude.com/docs/en/memory).

### CLAUDE.md: short, concrete, pruned

**What goes in, what stays out** ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)):

- **Include:** commands Claude can't guess, style rules that differ from the defaults, test instructions, repo etiquette, project-specific decisions, environment quirks, and gotchas that aren't obvious.
- **Leave out:** anything Claude can read from the code, standard conventions, API docs, fast-changing facts, tutorials, and file-by-file descriptions.
- **The test for each line:** "Would removing this cause Claude to make mistakes? If not, cut it. Bloated CLAUDE.md files cause Claude to ignore your actual instructions!"

**Size.** Aim for under 200 lines per file. `@` imports help organize a file but "don't reduce its context cost", so the 200-line budget covers everything that loads at launch. Only path-scoped rules and CLAUDE.md files in subdirectories actually load later ([Memory](https://code.claude.com/docs/en/memory)).

**Wording.** Write rules you can verify: "Run `npm test` before committing", not "Test your changes". Avoid contradictions, because then "Claude may pick one arbitrarily" ([Memory](https://code.claude.com/docs/en/memory)). Use emphasis sparingly: add "IMPORTANT" to one line that keeps getting skipped, because "If you emphasize many lines, none of them stands out". Anything that must always hold belongs in a hook ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)).

**Tools** ([Memory](https://code.claude.com/docs/en/memory)):

- `/doctor prompt-audit` (v2.1.283+) flags "instructions written for older models, references to files or commands that don't exist, and files that contradict each other", and changes nothing until you ask.
- `/context` shows which memory files loaded.
- HTML block comments are stripped before loading, so maintainer notes cost nothing.
- `AGENTS.md` is read directly (v2.1.277+) when no CLAUDE.md exists.

### Skills: the description triggers it, the body teaches it

**How a skill loads.** Its `name` and `description` sit in the system prompt. The body loads when the skill looks relevant, and bundled files are read or run only when needed: "Only the script's output consumes tokens" ([Agent Skills engineering post](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills); [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)).

**Writing the description.**

- Write it in the third person.
- Say what the skill does and when to use it, using words people actually type. Anthropic's example: "Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction" ([Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)).
- Keep it short, with the main use case first. Claude Code cuts the description plus `when_to_use` at 1,536 characters, and once the skill listing passes about 1% of the context window it drops descriptions, least-used skills first. The portable Agent Skills limit is 1,024 characters ([Skills](https://code.claude.com/docs/en/skills)).

**Writing the body** ([Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)):

- Keep it under 500 lines.
- Link reference files only one level deep. Claude may read only the first 100 lines of files linked from other references.
- Give long reference files a table of contents.
- Use one term per concept.
- Offer one default with an escape hatch, not a menu of options.
- Match how strict you are to how fragile the task is: heuristics for open-ended tasks, exact scripts marked "Do not modify the command" for a "Narrow bridge with cliffs on both sides".

**Put key rules at the top.** Claude Code adds a skill's content once and "doesn't re-read the file". After compaction it may keep only the start of the skill. So put the key rules first and word them for the whole task ("Run the tests after every edit") ([Skills](https://code.claude.com/docs/en/skills)).

**Useful frontmatter and syntax** ([Skills](https://code.claude.com/docs/en/skills)):

- `disable-model-invocation: true` for skills with side effects. It also takes the description out of context.
- `$ARGUMENTS`, `$0` or named `arguments` for input.
- `` !`git diff HEAD` `` to inject live command output before Claude sees the skill.
- `context: fork` with `agent:` to run the skill in a subagent. The body must then be self-contained.
- `shell: powershell` for PowerShell command blocks.

**Commands are now skills.** A `.claude/commands/x.md` file still works, but a skill with the same name wins, and only skills get supporting files and `paths`. Write new ones as skills (same source).

**Test before you write much** ([Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)):

1. Run Claude without the skill and record where it fails.
2. Build three test scenarios from those failures and measure a baseline.
3. Write the minimum instructions that fix them.
4. Have a fresh "Claude B" use the skill on real tasks while "Claude A" refines it.
5. Test with every model you'll use: Haiku may need more detail, Opus less.

To tune triggering, Anthropic's skill-creator uses about 20 test queries: 8 to 10 that should trigger the skill and 8 to 10 near-misses that shouldn't. It splits them into training and held-out sets and runs each query three times ([skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md)). Outside Claude Code (claude.ai and the Skills API), extra frontmatter keys such as `argument-hint` are a hard error ([Skills](https://code.claude.com/docs/en/skills)).

### Subagents: the delegation message is the whole brief

**What a subagent sees.** Its file body is its system prompt. It runs in a fresh context with CLAUDE.md, a git status snapshot and any preloaded skills, but not your conversation, output style or auto memory ([Subagents](https://code.claude.com/docs/en/sub-agents)). So the calling prompt has to carry the goal, the scope, the done criteria and the shape of the answer.

**How to write one** (same source):

- A description that singles it out. Adding "use proactively" encourages automatic delegation.
- The minimum `tools`.
- The official prompt pattern: a role line, "When invoked:" followed by numbered steps, a checklist, and an explicit output format.
- Skip subagents for back-and-forth work, context shared across phases, quick edits, or when latency matters.

**Recent changes** (same source):

- Subagents can nest up to three layers deep (v2.1.219+).
- Up to 20 can run at once by default.
- Forks inherit the parent conversation and reuse its prompt cache (on by default from v2.1.302).
- `memory: project` gives an agent its own `MEMORY.md` (the first 200 lines or 25KB load). It "has no effect if auto memory is off".

### Hooks: where "always" and "never" belong

"An instruction like 'never edit `.env`' in CLAUDE.md or a skill is a request, not a guarantee. A `PreToolUse` hook that blocks the edit is enforcement" ([Extend Claude Code](https://code.claude.com/docs/en/features-overview)).

**Exit codes** ([Hooks guide](https://code.claude.com/docs/en/hooks-guide)):

- Exit 0 means no objection. It does not approve the action.
- Exit 2 blocks the action, with stderr as the reason.
- Exit 0 with JSON output gives structured control. Use one approach per hook.
- A hook's deny holds in every permission mode, including `bypassPermissions`.

**Using a Stop hook as a gate.** A Stop hook that runs your test script is the deterministic verification gate ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)). Claude Code overrides a Stop hook that blocks 8 times in a row, so have the script check `stop_hook_active` to avoid loops ([Hooks guide](https://code.claude.com/docs/en/hooks-guide)).

**Gotchas** ([Hooks guide](https://code.claude.com/docs/en/hooks-guide); [Hooks reference](https://code.claude.com/docs/en/hooks)):

- `Edit|Write` matchers miss files changed through Bash or PowerShell. Add a Stop hook that scans `git status --porcelain`.
- On Windows, set `"shell": "powershell"` and use `${CLAUDE_PROJECT_DIR}`, never a bare `$CLAUDE_PROJECT_DIR`.

**Security.** "Command hooks execute shell commands with your full user permissions." In `-p` and SDK runs the trust dialog never appears, so hooks committed in a repo's `.claude/settings.json` run even in a folder you never trusted ([Hooks reference](https://code.claude.com/docs/en/hooks)).

**Output styles and plugins.** An output style sets the voice and format for a whole session. A custom style drops Claude Code's built-in coding instructions unless you set `keep-coding-instructions: true` ([Output styles](https://code.claude.com/docs/en/output-styles)). A plugin packages skills, agents, hooks and MCP servers as one namespaced unit; reach for one when "A second repository needs the same setup" ([Plugins](https://code.claude.com/docs/en/plugins)).

**Which block to use (synthesized from [Extend Claude Code](https://code.claude.com/docs/en/features-overview)):**

| If the guidance... | Put it in |
|---|---|
| Must always happen | A hook |
| Is a fact needed every session | CLAUDE.md |
| Matters only for some files | A path-scoped rule |
| Is a procedure or reference needed sometimes | A skill (user-only if it has side effects) |
| Is noisy, self-contained work | A subagent |
| Sets the tone of every reply | An output style |
| Must be shared across repos | A plugin |

## Images work best labeled, cropped and placed before the question

**Adding images in the terminal.** Drag and drop an image, paste it with Alt+V on native Windows (which inserts an `[Image #N]` chip), or type a path, as in "Analyze this image: /path/to/your/image.png" ([Common workflows](https://code.claude.com/docs/en/common-workflows); [Interactive mode](https://code.claude.com/docs/en/interactive-mode)).

**What the Read tool does with them.** It returns PNG, JPEG, GIF and WebP files as visual content. It "resizes and recompresses large images to fit the model's image size limits before sending them, so Claude may see a downscaled version of a large screenshot". For fine detail, ask Claude to crop the region (for example with ImageMagick) and read the crop. Read refuses images over 128 MB ([Tools reference](https://code.claude.com/docs/en/tools-reference)).

**Prompting with images** ([Vision](https://platform.claude.com/docs/en/build-with-claude/vision)):

- "Claude works best when images come before text." Images placed after the text "still perform well".
- With several images, label each one ("Image 1:", "Image 2:").
- Keep text in images legible, and avoid heavy JPEG compression.
- Expect mistakes on low-quality, rotated, or very small images (under 200 pixels).
- Claude doesn't read image metadata.

Claude Code adds two tips. Use images "when text descriptions would be unclear or cumbersome". For UI work, close the loop with "take a screenshot of the result and compare it to the original. list differences and fix them" ([Common workflows](https://code.claude.com/docs/en/common-workflows); [Claude Code best practices](https://code.claude.com/docs/en/best-practices)).

| Limit | Value |
|---|---|
| Formats | JPEG, PNG, GIF, WebP (only the first frame of an animation) |
| Dimensions | Up to 8000x8000 px; at most 2000 px per side when a request has more than 20 images |
| Size | 10 MB per image (base64) on the Claude API, 5 MB on Bedrock and Google Cloud; 32 MB per request |
| Count | 100 per API request on 200k-context models, 600 on others; 20 per message on claude.ai |
| Resolution tier | Claude 4.7 and later: 2576 px long edge, at most 4784 visual tokens. Other models: 1568 px, at most 1568 tokens |
| Cost | ceil(width/28) x ceil(height/28) visual tokens. A 1920x1080 screenshot costs 2691 tokens on the high-resolution tier |

All values are from [Vision](https://platform.claude.com/docs/en/build-with-claude/vision). For dense charts and drawings, tools beat prompt tricks. A crop tool gives "consistent uplift on image evaluations when Claude is able to 'zoom' in on relevant regions" ([crop tool recipe](https://platform.claude.com/cookbook/multimodal-crop-tool)). On Opus 5.5, "Without tools, raising effort improves its reading of technical drawings but does little for charts" ([Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)).

**Two cautions.**

- **Paths change the order (synthesized).** When you give images as file paths, Claude reads them with the Read tool after it has read your prompt. The image content therefore lands after your text, whatever order you list the paths in. A true image-before-text order needs pasted images or SDK content blocks. For path-based images, labels, roles and "what to look at" matter more than where the list sits.
- **"Describe the image first" is unverified.** This common tip is not in the current Vision or prompting pages. It is still a cheap way to catch a misread before Claude acts on it.

**Other reference material.** An `@src/file.ts` mention includes the file's content up to the Read limit (25,000 tokens by default; text files over 256 KB aren't included). A directory mention gives only a listing ([Common workflows](https://code.claude.com/docs/en/common-workflows); [Tools reference](https://code.claude.com/docs/en/tools-reference)). You can also give URLs for docs, pipe data in, or let Claude fetch what it needs ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)). Whether `@path` mentions inside a `-p` prompt expand the way they do interactively is unverified.

```powershell
# [constructed] Labeled image comparison in a headless run (not run)
claude -p "Image 1 is C:\shots\expected.png (the approved design). Image 2 is C:\shots\actual.png (the current build). Read both images. Compare only layout, spacing and colors of the header and booking form; ignore text content. List differences, most important first." --add-dir C:\shots --allowedTools "Read" --permission-mode dontAsk --output-format json
```

## Headless runs need an allowlist, a JSON result and a spending cap

**What `-p` does.** `claude -p "prompt"` makes one non-interactive agent run and exits. It reads piped stdin (capped at 10 MB) and prints `text` (the default), a single `json` object, or `stream-json` events ([Run Claude Code programmatically](https://code.claude.com/docs/en/headless)).

**What the JSON result contains** ([headless](https://code.claude.com/docs/en/headless); [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)):

- `subtype`: `success`, or an error subtype such as `error_max_turns`, `error_max_budget_usd`, `error_during_execution` or `error_max_structured_output_retries`.
- `result`: the final text, present only on `success`.
- `session_id`, `total_cost_usd`, `usage`, `num_turns` and `stop_reason`.
- `modelUsage`: costs across the whole tree, subagents included.
- `structured_output`, when you pass `--json-schema`. Check that the field exists before you use it.

Branch on the exit code and on `subtype` before reading anything else.

**Permissions are the main trap.**

- **Since v2.1.302, `claude -p` starts in Manual mode when no mode is set.** Any call that needs approval is denied unless an allow rule, a hook or a permission-prompt tool approves it. Interactive sessions start in `auto` mode on v2.1.283+ ([Permission modes](https://code.claude.com/docs/en/permission-modes)).
- **For CI, the docs give an exact allowlist:** `--permission-mode dontAsk --allowedTools "Bash(npm test)" "Read"`. Keep `--dangerously-skip-permissions` for isolated containers or VMs, because it "offers no protection against prompt injection or unintended actions" (same source).
- **Mind the space in prefix rules.** Write `Bash(git diff *)`, not `Bash(git diff*)`; without the space the rule also matches `git diff-index` ([headless](https://code.claude.com/docs/en/headless)).
- **Windows: add `PowerShell(...)` rules.** An allowlist with only `Bash(...)` rules may not cover commands Claude runs through its PowerShell tool. The rule syntax exists, but it was not verified in a `-p` run.

**Isolating the run.**

- `--bare` skips hooks, skills, plugins, MCP servers, auto memory and CLAUDE.md. It "is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release". However, it needs `ANTHROPIC_API_KEY` or an `apiKeyHelper` and never reads an OAuth login ([headless](https://code.claude.com/docs/en/headless)).
- On a subscription login, approximate it with `--setting-sources`, `--strict-mcp-config --mcp-config <file>` and `--disable-slash-commands` (an inference, not a documented recipe).
- Without `--bare`, a `-p` run starts the project's hooks and MCP servers "even in a folder you've never trusted" (same source).

**Caps.** `--max-budget-usd` stops the run when estimated spend reaches the cap, counting subagents. It can overshoot by about one response, so leave headroom ([How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)). `--max-turns` is documented but missing from the local `--help` [local] ([CLI reference](https://code.claude.com/docs/en/cli-reference)).

**Sessions across steps** ([headless](https://code.claude.com/docs/en/headless); [Manage sessions](https://code.claude.com/docs/en/sessions)):

- Capture `session_id` and pass `--resume <id>` to continue the same conversation.
- Avoid `--continue` when runs can overlap, because it picks the most recent conversation.
- Use `--fork-session` to branch from a session without changing it.
- A resumed `-p` run does not restore `--settings`, `--mcp-config`, `--add-dir`, `--plugin-dir`, `--fallback-model` or the permission mode. Pass them again.
- The system prompt is recorded on the first request. A different `--append-system-prompt` on resume has no effect until compaction, so put per-step instructions in the user prompt, or pass `--system-prompt-snapshot off` (v2.1.257+) ([CLI reference](https://code.claude.com/docs/en/cli-reference)).

**Fan-out.** Run on 2 or 3 items, refine the prompt, then run the full set. Or use `/batch`, which splits a change across 5 to 30 subagents, each in its own worktree ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)).

### Windows PowerShell 5.1 mangles quotes and non-ASCII text

- **Quotes.** Windows PowerShell 5.1 uses the legacy way of passing arguments to native programs, which mangles embedded double quotes. That breaks inline JSON for `--json-schema`, `--settings`, `--agents` and `--mcp-config` ([about_Parsing](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing)).
- **Encoding.** Text piped into a native program is encoded with `$OutputEncoding`, which defaults to ASCII in 5.1, so "café" arrives as "caf?" ([about_Preference_Variables](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-5.1)).
- **Safe options:** flags that take a file path, stdin with UTF-8 forced, or a Node `child_process.spawn('claude', [...args])` with an argument array. The Node option matches this workspace's existing tooling.
- **Still open:** how claude.exe decodes stdin, and whether the `\"` escape works on its command line, are undocumented. Test each once before relying on it.

```powershell
# [constructed] Not run. Long or non-ASCII prompt through stdin, with UTF-8 forced
$OutputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()   # decode the reply as UTF-8 (need unverified)
$raw = Get-Content .\prompts\step1.md -Raw -Encoding UTF8 |
  claude -p "Follow the instructions above." --output-format json --permission-mode dontAsk --allowedTools "Read,Grep,Glob" --max-budget-usd 1
$r = ($raw -join "`n") | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $r.subtype -ne 'success') { throw "Step 1 failed: $($r.subtype)" }

# Step 2 in the same conversation: pass the permission flags again
$r2 = (claude -p "Propose fixes for the top 3 findings" --resume $r.session_id --output-format json --permission-mode dontAsk --allowedTools "Read,Grep,Glob") -join "`n" | ConvertFrom-Json

# Interactive start with plan mode, model, effort and a session name
claude --permission-mode plan --model opus --effort high -n auth-plan "Read src/auth and propose a plan for adding Google OAuth"

# Save output as UTF-8 explicitly (plain '>' in your own 5.1 console may write UTF-16; unverified)
claude -p "Summarize CHANGELOG.md" | Out-File -Encoding utf8 .\summary.md
```

**CLI or Agent SDK?** The Agent SDK is Claude Code as a library. Over the CLI it adds typed message streams, in-process hooks, a `canUseTool` approval callback, custom tools that run in-process, and streaming input that can carry image attachments ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview); [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)). For any other language, Anthropic says: "run the CLI as a subprocess with the `-p` flag and `--output-format json`" ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)). For this workspace, the CLI covers linear steps. The SDK would add `@anthropic-ai/claude-agent-sdk` as a dependency, which needs your OK. Anthropic also says third-party products may not offer claude.ai login, so whether personal scripts may use your subscription login through the SDK is unverified (same source).

**Scheduled and CI runs.** The GitHub Action `anthropics/claude-code-action@v1` takes CLI flags through `claude_args` ([GitHub Actions](https://code.claude.com/docs/en/github-actions)). For any scheduled run, "be explicit about what success looks like and what to do with results. The task runs autonomously, so it can't ask clarifying questions" ([Common workflows](https://code.claude.com/docs/en/common-workflows)).

## Where the sources disagree, and what to do

| Topic | One source says | Another says | Recommendation |
|---|---|---|---|
| Verification | Claude Code best practices: have a fresh-context subagent review the diff. Fable 5: fresh verifiers beat self-critique | Opus 5: remove "use a subagent to verify" and "double-check" instructions, because they cause over-verification | Keep external, objective checks that the pipeline owns: tests, a Stop hook, a separate reviewer stage. Delete in-prompt "verify yourself" lines when running Opus 5. |
| Review filtering | [Best practices](https://code.claude.com/docs/en/best-practices): tell reviewers to flag only gaps that affect correctness or requirements | [Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5) / [Sonnet 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5): soft filters cut recall; report everything and filter later | Two stages: an exhaustive reviewer with severity and confidence, then a filter step. Or give one concrete bar ("anything that could cause incorrect behavior, a test failure, or a misleading result"). |
| Emphasis | [skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md): all-caps ALWAYS/NEVER is "a yellow flag". BP: drop CRITICAL/MUST | [Best practices](https://code.claude.com/docs/en/best-practices): add "IMPORTANT" to a skipped line. The [platform skill guide](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) shows "MUST filter" as an iteration step | Explain the reason first. Put one marker on one rule only after it has been skipped. Use a hook if the rule must hold. |
| Skill descriptions | skill-creator: Claude undertriggers, so make descriptions a little "pushy" | [BP](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices): 4.5/4.6+ models overtrigger on prompts written against undertriggering | Use specific trigger phrases, not emphatic words. Measure with a trigger eval of about 20 queries. Narrow the description, or set `disable-model-invocation`, if the skill fires too often. |
| Context size | [Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (Sep 2025): context rot appears across all models | Opus 5: behavior stays "consistent throughout the window" (1M tokens) | Keep curating. Irrelevant tokens still cost money, time and attention, and Claude Code's current docs still say performance degrades as context fills. |
| Delegation | Opus 5: delegate only large independent work, and keep spawn counts low | [Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1): delegate more, keep the lead working | Depends on the model: damp delegation and set the spawn caps on Opus 5; allow more on Fable. |
| Formatting blocks | BP: an anti-markdown block for chattier models | Fable 5.1: such a block suppresses structure the content needs | Don't paste formatting boilerplate into every prompt. Add it per model, only when the output shows the problem. |
| Evaluator loops | [Cookbook](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/evaluator_optimizer.ipynb): loop until PASS, no cap | [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents): agents need stopping conditions. [Workflows](https://code.claude.com/docs/en/workflows): stop after two rounds without progress | Always cap: 2 to 3 rounds, plus a stop when a round makes no progress. |
| Table-of-contents threshold for skill reference files | Platform guide: files over 100 lines | skill-creator: files over 300 lines | Use 100. |
| Description length | Agent Skills spec: 1,024 characters | Claude Code listing: 1,536 characters | Stay under 1,024 for portability. The shared 1% listing budget is the real limit. |

## Conclusion

Across late-2026 guidance, upgrading to a newer model now means deleting prompt text, not adding it. Verification lines, emphasis, anti-laziness nudges, step-by-step scaffolding and formatting blocks helped the 2024-2025 models. On current models they cause overtriggering, over-verification, refusals or 400 errors. The craft has moved from persuading the model to designing what surrounds it: a complete brief in the first turn, a check it can run, typed handoffs, and caps the harness enforces. A prompt or skill library should therefore be checked against each new model with a small eval set, and removing old instructions should be the first experiment.

For this workspace, the flow launcher is the right thing to improve. Most of what the research recommends is controlled by how a run starts, not by what the prompt says:

- effort and permission mode at launch;
- where images sit and how they are labeled;
- whether the run is interactive or headless;
- where its output lands, and what checks it.

The interactive settings are flags on a command the app already builds. Headless runs and multi-step flows need more work (see the suggested next steps below).

## What the workspace app supports today

| Practice | Supported? (Yes / Partly / No) | How, or what is missing |
|---|---|---|
| Complete brief in the first turn | Partly | The flow body (up to 16,000 characters) and run notes (up to 2,000) arrive together as one first prompt. There are no fields or prompts for goal, scope or done criteria. |
| Prompt template following the best-practice structure | No | The flow body is free text; there is no starter template. |
| Variables or placeholders | No | Only free-text "Notes for this run". |
| Examples and output-format sections | Partly | Possible only as free text inside the flow body. |
| Success criteria or a "done when" check | No | No field. It can only be written into the prompt text. |
| Preview of the exact prompt | Yes | The Run dialog shows the exact first prompt before launch. |
| Prompt reaches claude.exe unchanged on PowerShell 5.1 | Yes | Passed through a temp JSON file read by a Node helper. Quotes, backslashes, %, $, backticks, ; and newlines were verified to arrive intact. |
| Fresh context per task | Yes | Every flow run opens a new interactive session in a Windows Terminal tab. |
| Reference images attached to a run | Yes | Per-flow image folder (drag-drop, paste or file picker; up to 40 per run, 25 MB each). Read access comes from `permissions.additionalDirectories` in a `--settings` file. |
| Images before text | No | The image list comes after the flow prompt and notes. Path-based images are read after the text in any case (see the images section). |
| Images labeled by role, with what to look at | No | A bulleted list of absolute paths, named only by file name. Workaround: refer to each file by name in the flow body and say what to compare. |
| Image formats Claude can see | Partly | PNG, JPEG, GIF and WebP match the Read tool's documented formats. The app also accepts BMP, which isn't in that list; whether Claude sees BMP is unverified, so convert to PNG. Large files are resized by Read; the app has no crop or resize step. |
| Per-flow permission mode (for example plan) | No | Not settable per flow. You can still press Shift+Tab inside the session. |
| Per-flow model and effort | No | Not settable per flow. `/model` and `/effort` work inside the session. |
| Per-flow allowed tools, max turns or budget cap | No | Not available. |
| Multi-step chains with handoff files | No | One prompt per run. One flow's output can't be passed to the next. |
| Parallel runs or fan-out | No | Not available. |
| Verification or reviewer step, with a round cap | No | Possible only as instructions inside the prompt. |
| Deterministic checks | Partly | The Tools view runs check-workspace and the test suite and shows their output, but nothing runs a check as a gate on a flow. |
| Headless runs (`claude -p`) with captured JSON output and run history | No | Flows always open an interactive session. Nothing is recorded after launch. |
| Resume a specific session | No | The hub offers "continue last session" only, with no session list. |
| Isolated specialist agents with their own memory and images | Yes | Runs `claude --agent <name> --settings <file>` with the agent's own memory folder (autoMemoryDirectory) and per-agent and per-project image folders. Memory can be viewed but not edited in the app. Agent memory needs auto memory on; `tools/agent-session.mjs` sets `autoMemoryEnabled: true` in its `--settings` file, which outranks the project's settings (see `tools/lib/agents.mjs`, `sessionSettings`). |
| Agent definitions that follow subagent guidance | Partly | The template's Role / Owns / Leaves alone / Done means sections give a focused job with boundaries and done criteria. It has no `tools`, `effort` or `permissionMode` fields, but the whole file is editable, so they can be added by hand. An agent gets a first prompt only through a flow. |
| Run skills with arguments | Yes | The Tools view sends "/<skill> <form values>" as the first prompt, which is how Claude Code triggers a skill. |
| Author skills, hooks, CLAUDE.md, context files or settings | No | Edit them outside the app. The app can then run install-library (dry-run preview first). |
| Explore, plan, implement, verify workflow guidance | Partly | `pipelines/*.md` cover these stages, prompts that work, and a `claude -p` section, but the app doesn't show, link to or run them. |

## Suggested next steps for the app

1. **Per-flow launch settings** (small). Add optional permission mode (default, plan, acceptEdits), model, effort and allowed tools to the flow frontmatter, and pass them as `--permission-mode`, `--model`, `--effort` and `--allowedTools` on the existing interactive launch. Why: effort is the documented first control for reasoning depth, plan mode is the documented explore-and-plan stage, and all of these flags combine with an interactive start prompt.
2. **Labeled images first, in formats Claude reads** (small). Put the image block above the flow prompt as "Image 1 (expected.png): <role>", with an optional one-line caption per image, and convert BMP to PNG on upload. Why: the Vision docs prefer image-then-text and "Image 1:" labels, and BMP isn't in the Read tool's documented formats.
3. **Best-practice flow template with variables and a "done when" field** (medium). New flows start from the Context / Task / Done when / Output skeleton. `{{NAME}}` placeholders become fields in the Run dialog, and the done-when check is added as the final instruction. Why: literal models need the scope and done criteria in the first turn, `{{VAR}}` is Anthropic's convention, and a runnable check is the strongest single lever.
4. **Headless run mode with captured results** (medium). Add an option to run a flow as `claude -p --output-format json --permission-mode dontAsk --allowedTools ... --max-budget-usd ...`, spawned from Node with an argument array and the prompt on stdin. Save the prompt, `subtype`, `result`, `session_id`, cost and `permission_denials` to a per-run folder, and add an "open in terminal" button that runs `claude --resume <id>`. Why: this is the documented automation pattern; Node spawn avoids the PowerShell 5.1 quoting and encoding traps; session IDs make failed runs inspectable. `--bare` would need an API key.
5. **Multi-step flows with handoff files** (large). A flow becomes an ordered list of steps. Each step writes its output to a file in the run folder and receives the previous step's file path, with an optional "pause for my OK" between steps. Why: chaining pays off exactly where you need to inspect or gate the middle; files and paths avoid the "game of telephone"; and Claude Code's own workflows handle sign-off by splitting stages.
6. **Optional reviewer step with a round cap** (medium, builds on step 5). A final step in a fresh session receives the diff or output plus the done criteria. It reports every finding with severity and confidence, and sends the work back for fixes at most twice. Why: fresh-context reviewers beat self-critique; a separate stage avoids the over-verification that in-prompt "double-check" lines cause on Opus 5; and every loop needs a cap.
