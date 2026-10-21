# Multi-step LLM workflow ("pipeline") patterns and context engineering for Claude (late 2026)

Research notes, 2026-10-21. `claude_code_version: 2.1.306` (from `claude --version` on this machine; `context/stack.md` still says 2.1.305). Claude Code docs: https://code.claude.com/docs. Every source is first-party Anthropic unless labeled. Engineering-blog posts are dated, and some predate current models (Opus 5 / 5.5, Sonnet 5.5, Haiku 5.5), so the newer model-specific prompting pages win where they disagree. Points where they disagree are flagged. Examples marked **(synthesized)** are my own illustrations built from the cited rules, not quotes.

Primary sources used:
- "Building effective agents" (Dec 19, 2024; the page now names Claude Haiku 4.5 / Sonnet 4.5 and the Claude Agent SDK, so it has been revised since publication): https://www.anthropic.com/engineering/building-effective-agents
- "Effective context engineering for AI agents" (Sep 29, 2025): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- "How we built our multi-agent research system" (Jun 13, 2025): https://www.anthropic.com/engineering/multi-agent-research-system
- "Writing effective tools for AI agents" (Sep 11, 2025): https://www.anthropic.com/engineering/writing-tools-for-agents
- "Effective harnesses for long-running agents" (Nov 26, 2025): https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- "Demystifying evals for AI agents" (Jan 9, 2026): https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Claude Code best practices (current docs): https://code.claude.com/docs/en/best-practices
- Claude Code dynamic workflows (current docs): https://code.claude.com/docs/en/workflows
- Prompting best practices (current docs; the old "Chain complex prompts" page URL now redirects here): https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- Prompting Claude Opus 5: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5
- Structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Claude cookbooks, agent patterns: https://github.com/anthropics/claude-cookbooks/tree/main/patterns/agents

---

## 1. Workflow patterns vs. autonomous agents: when each fits, and when NOT to build an agent

### Takeaway
Anthropic separates *workflows* (LLMs and tools run along predefined code paths) from *agents* (the LLM decides its own process and tool use), and its main advice is to start with the simplest thing: often one well-prompted call with retrieval and examples. Add a fixed workflow when the steps are predictable. Reach for an agent only for open-ended problems where the steps can't be hardcoded, and only when the extra cost, latency and compounding-error risk pay off. Current models also do much multi-step reasoning and delegation internally, so explicit chains are now mainly for inspecting intermediate outputs or enforcing a structure.

### Cited Findings
- Definitions: in workflows "LLMs and tools are orchestrated through predefined code paths"; in agents, LLMs "dynamically direct their own processes and tool use". Both fall under "agentic systems". — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Start with the simplest solution and add complexity only when needed. Agentic systems trade latency and cost for better task performance. Often a single LLM call optimized with retrieval and in-context examples is enough. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Workflows give predictability for well-defined tasks. Agents fit when you need flexible, model-driven decisions at scale. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Building block, the "augmented LLM": an LLM with retrieval, tools and memory, tailored to the use case behind a clear, well-documented interface (MCP is one option). — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- **Prompt chaining**: each step processes the previous step's output, and programmatic "gates" can check intermediate steps. Use it when a task splits cleanly into fixed subtasks; it trades latency for accuracy. Examples: write marketing copy, then translate it; write an outline, check it against criteria, then write the document. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- **Routing**: classify the input and send it to a specialized follow-up. Use it when categories are better handled separately and classification is accurate. Examples: customer-service queries split into general, refund and technical; easy questions to Haiku 4.5, hard ones to Sonnet 4.5. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- **Parallelization**: *sectioning* runs independent subtasks at the same time (for example, one call answers while another screens for inappropriate content, which works better than one call doing both). *Voting* runs the same task several times for diverse outputs (for example, several prompts review code for vulnerabilities). Use it for speed or for higher confidence from multiple perspectives. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- **Orchestrator-workers**: a central LLM breaks down the task, delegates and synthesizes. Unlike parallelization, the subtasks are decided per input rather than predefined. Examples: coding changes across many files; search across many sources. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- **Evaluator-optimizer**: one LLM generates, another evaluates and gives feedback, in a loop. Use it when evaluation criteria are clear and iteration measurably helps. Examples: literary translation; multi-round search where the evaluator decides whether more searching is needed. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- **Autonomous agents**: they plan and operate independently, check "ground truth" from the environment at each step, may pause for human input, and often have stopping conditions such as a maximum number of iterations. Use them for open-ended problems where the steps can't be predicted. They cost more and risk compounding errors, so test them in sandboxes with guardrails. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Three core principles: keep the design simple; be transparent by showing planning steps explicitly; craft the agent-computer interface (ACI) through thorough tool documentation and testing. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Frameworks (Claude Agent SDK, Strands, Rivet, Vellum are named) can hide prompts and responses and invite unneeded complexity. Start with the LLM APIs directly, understand the code under any framework, and reduce abstraction layers for production. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Current guidance: "With adaptive thinking and subagent orchestration, Claude handles most multistep reasoning internally. Explicit prompt chaining (breaking a task into sequential API calls) is still useful when you need to inspect intermediate outputs or enforce a specific pipeline structure." — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- Multi-agent is a poor fit when the value doesn't justify the token cost, when all agents need to share one context or depend heavily on each other, when there are few parallelizable steps ("most coding tasks"), or when agents must coordinate in real time. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Claude Code's own comparison: with subagents, skills and agent teams, Claude is the orchestrator and intermediate results land in its context. With a *dynamic workflow*, a script holds the loop, the branching and the intermediate results, so Claude's context holds only the final answer. Workflows scale to "dozens to hundreds of agents per run" and can be resumed within the session. — [Claude Code: dynamic workflows](https://code.claude.com/docs/en/workflows)
- Claude Code says a workflow fits "when a task needs more agents than one conversation can coordinate, or when you want the orchestration codified as a script you can read and rerun" (for example, a codebase bug sweep, a 500-file migration, cross-checked research). — [Claude Code: dynamic workflows](https://code.claude.com/docs/en/workflows)
- Opus 5 delegates more readily than earlier models: "Delegation pays off on genuinely independent, sizeable tracks of work, but it multiplies cost and time when applied to small tasks." — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)

### Inferences
- Decision ladder **(synthesized from the sources above)**:
  1. One call with good context and examples.
  2. If the task has fixed stages you want to inspect or gate, use a prompt chain.
  3. If inputs fall into distinct categories, put a router in front.
  4. If the subtasks are independent, use sectioning; if you need confidence, use voting.
  5. If the subtasks can't be known in advance, use orchestrator-workers.
  6. If you have a clear rubric or check and iterating helps, use evaluator-optimizer.
  7. Use a full agent loop only when the path can't be scripted.
  8. Use a multi-agent system only for wide, parallelizable, high-value work.
- In Claude Code terms: a skill is a prompt-level procedure that Claude follows, subagents are a few delegated tasks, and a dynamic workflow is the right tool when the orchestration itself should be code (repeatable, resumable, results kept out of context). A workspace "pipeline" Markdown file is closest to a skill: Claude holds the plan.
- Don't build an agent when: the steps are known (write a chain); the task is small (Opus 5 over-delegates, which multiplies cost); the work is tightly coupled or mostly sequential coding (multi-agent is a poor fit); or you can't verify the result (see section 3).

### Gaps
- The "Building effective agents" page shows the Dec 2024 date but names later models. I could not find a changelog of what was revised, so treat the model names in its examples as updated and the pattern text as unchanged (unverified).
- I found no newer Anthropic post that replaces this pattern taxonomy. A third-party summary (Lyzr, *third-party*) mentions a Feb 2026 "harness engineering" wave of posts from Anthropic and OpenAI; I did not verify any such Anthropic post.

---

## 2. Prompt chaining specifics: splitting steps, passing outputs, gates, self-correction

### Takeaway
Split a task into stages with one clear goal each. Pass results between stages in explicit, machine-checkable containers: XML tags for prose, JSON schemas (structured outputs) for anything code must read, and files with lightweight references when outputs are large. Put programmatic gates between steps. The most common chain is self-correction: draft, review against criteria, refine. Each step is a separate call so you can log, evaluate or branch.

### Cited Findings
- Chaining: "Each step processes the previous output." Programmatic checks ("gates") can run on intermediate steps. Example: write an outline, *check that it meets criteria*, then write the document. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- "The most common chaining pattern is **self-correction:** generate a draft → have Claude review it against criteria → have Claude refine based on the review. Each step is a separate API call so you can log, evaluate, or branch at any point." — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- XML tags "help Claude parse complex prompts unambiguously, especially when your prompt mixes instructions, context, examples, and variable inputs". Wrap each kind of content in its own tag (for example `<instructions>`, `<context>`, `<input>`). For multiple documents, use `<document>` with `<document_content>` and `<source>` subtags. Put examples in `<example>` / `<examples>`. — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- Structured outputs: `output_config.format` with `{"type": "json_schema", "schema": ...}` constrains the response to a JSON schema through constrained decoding, which removes parse errors and missing required fields. It is GA (no beta header) on the Claude API, Bedrock, Google Cloud and Microsoft Foundry. The older `output_format` parameter is deprecated and needs beta header `structured-outputs-2025-11-13`. Strict tool use (`strict: true`) validates tool inputs. The two can be combined, which is useful in agentic workflows that need reliable tool calls *and* a structured final answer. — [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- Structured-output limits that matter for handoff contracts:
  - Objects need `additionalProperties: false`.
  - Not supported: `minimum`/`maximum`, `minLength`/`maxLength`, recursive schemas, or array constraints beyond `minItems` 0/1.
  - Enum casing may differ, so compare case-insensitively.
  - `stop_reason: "max_tokens"` can return incomplete output, and `"refusal"` may not match the schema.
  - Complexity cap: 20 strict tools, 24 optional parameters, 16 union-type parameters.
  - Asking for step-by-step reasoning *in the output* can trigger a `reasoning_extraction` refusal. Ask for a short explanation instead.
  — [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- The Opus 5 page says the same: prompts or skills asking Claude to write out its reasoning verbatim or in a fixed format may be declined with `reasoning_extraction`. Ask for "a short explanation of the answer or a summary of the actions taken", or read summarized thinking blocks. — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- Prefill used to force JSON/YAML or classification formats. Current guidance: use Structured Outputs, or ask the model to follow the structure ("newer models can reliably match complex schemas when told to, especially if implemented with retries"). For classification, use a tool with an enum field, or structured outputs. — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- In Claude Code dynamic workflows, `agent(prompt, { schema })` makes a subagent return JSON matching the schema. Claude Code rejects self-contradictory schemas before starting, and fails the call after five failed validation attempts (configurable with `MAX_STRUCTURED_OUTPUT_RETRIES`). Primitives: `agent()`, `pipeline()` (one agent per item), `parallel()`, `phase()`, `log()`, plus an `args` global. Example shape: one agent lists files with a `{files: string[]}` schema, `pipeline(found.files, file => agent(...))` audits each, then `return audits.filter(Boolean)`. — [Claude Code: dynamic workflows](https://code.claude.com/docs/en/workflows)
- Workflow constraints: no mid-run user input ("For sign-off between stages, run each stage as its own workflow"); the script itself has no filesystem or shell access, only agents do; `Date.now()`/`Math.random()` throw so relaunches are deterministic; at most 16 concurrent agents by default and 1,000 agents per run. — [Claude Code: dynamic workflows](https://code.claude.com/docs/en/workflows)
- Headless pipelines: `claude -p "<prompt>" --output-format json` returns one JSON object with a `result` field, and `stream-json` prints one JSON object per line. Fan-out recipe:
  1. Have Claude write the task list to a file (for example `files.txt`).
  2. Loop `claude -p "Migrate $file ... Return OK or FAIL." --allowedTools "Edit,Bash(git commit *)" --permission-mode dontAsk`.
  3. Test on 2-3 files and refine the prompt before running on all of them.
  — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Output-format design: some formats are harder for LLMs (diffs need line counts up front, and code inside JSON needs escaping). Give the model tokens to think before it commits, stay close to formats common in internet text, and avoid formatting overhead. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Handoffs between subagents: subagents should "store their results externally and pass lightweight references back", which avoids information loss in the "game of telephone" through the coordinator. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Cookbook reference implementation (evaluator-optimizer): `generate()` parses `<thoughts>` and `<response>`; `evaluate()` parses `<evaluation>` (PASS / NEEDS_IMPROVEMENT / FAIL) and `<feedback>`; `loop()` repeats until PASS, feeding back a "Previous attempts:" list plus the latest feedback. — [claude-cookbooks evaluator_optimizer.ipynb](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/evaluator_optimizer.ipynb). The `basic_workflows.ipynb` notebook covers chaining, routing and parallelization. — [claude-cookbooks patterns/agents](https://github.com/anthropics/claude-cookbooks/tree/main/patterns/agents)

### Inferences
- Design rules for a chain step **(synthesized)**:
  1. One goal per step, stated in one sentence.
  2. Name the step's position ("step 2 of 4") and what it must *not* do (for example "don't rewrite, only check").
  3. Put each upstream artifact in its own XML tag.
  4. Define the output contract as a JSON schema when code consumes it, or as named XML tags when the next LLM step consumes prose.
  5. Gate in code, not in the model: parse, validate, check counts and enums, then route.
  6. Log every step's input and output so you can re-run a single step.
  7. When outputs are large, write them to a file and pass the path.
- Example step prompt plus output contract **(synthesized)**, for an outline-check gate:
  ```text
  <role>You are step 2 of 4 in a report pipeline: the outline checker.</role>
  <outline>{{step1.outline}}</outline>
  <criteria>
  - Every key question in <questions> has exactly one section.
  - No two sections cover the same ground.
  - Each section names at least one source it will draw on.
  </criteria>
  <questions>{{user.key_questions}}</questions>
  <instructions>
  Check the outline against each criterion. Do not rewrite the outline.
  If a criterion fails, say which section and the smallest fix.
  </instructions>
  ```
  JSON schema sent as `output_config.format` (`additionalProperties: false` on every object):
  ```json
  {"type":"object","additionalProperties":false,
   "required":["verdict","issues","summary"],
   "properties":{
     "verdict":{"type":"string","enum":["pass","revise"]},
     "issues":{"type":"array","items":{"type":"object","additionalProperties":false,
       "required":["section","criterion","fix"],
       "properties":{"section":{"type":"string"},"criterion":{"type":"string"},"fix":{"type":"string"}}}},
     "summary":{"type":"string","description":"One or two sentences explaining the verdict"}}}
  ```
  Gate in code: if `verdict == "revise"` and `round < 2`, send `issues` back to step 1; if it still fails after 2 rounds, stop and escalate to a human. The field is a short `summary`, not a "reasoning" field, to avoid `reasoning_extraction` refusals.
- Choose the handoff medium by consumer **(synthesized)**: code reads it → JSON schema; the next LLM step reads it → XML-tagged prose; a human reviews it, or it is large → a file plus a path; long-lived state → a structured JSON state file plus a free-text progress note plus git (section 5).

### Gaps
- The old standalone "Chain complex prompts" docs page (with worked legal-contract and research examples and tips such as "each subtask should have a single, clear objective") now redirects into the general best-practices page, which keeps only a short section. I could not fetch the old examples, so any quote from them is unverified.
- I could not read the prompts in the cookbook's `basic_workflows.ipynb` or `orchestrator_workers.ipynb` (the GitHub tree page doesn't render notebook contents); only `evaluator_optimizer.ipynb` was read.

---

## 3. Verification: giving Claude ways to check its work, graders, and evaluator-optimizer loops with stop conditions

### Takeaway
Anthropic's single strongest lever is to give Claude a check that returns pass or fail (tests, build exit code, linter, fixture diff, screenshot comparison) and then decide how hard that check gates the stop: in the prompt, as a `/goal`, as a Stop hook, or through a fresh-context reviewer. Grade outcomes, not paths. Calibrate LLM judges against humans. Always cap evaluator loops by rounds and by no-progress. On Opus 5, *remove* blanket "double-check" or "use a subagent to verify" instructions, because the model already self-verifies and extra instructions cause over-verification.

### Cited Findings
- "Claude stops when the work looks done. Without a check it can run, 'looks done' is the only signal available, and you become the verification loop." A check is "anything that returns a signal Claude can read": test suite, build exit code, linter, a script diffing output against a fixture, or a browser screenshot compared against a design. — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Four strengths of gating, which trade setup for attention: (1) in one prompt, ask Claude to run the check and iterate; (2) across a session, a `/goal` condition re-checked by a separate evaluator after every turn; (3) a deterministic Stop hook that blocks the turn from ending until the check passes; (4) a second opinion: "a verification subagent or a dynamic workflow that checks its own findings has a fresh model try to refute the result, so the agent doing the work isn't the one grading it." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- "Have Claude show evidence rather than asserting success: the test output, the command it ran and what it returned, or a screenshot." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Before/after prompt example: "write a validateEmail function. example test cases: user@example.com is true, invalid is false, user@.com is false. run the tests after implementing". — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Adversarial review: a fresh-context subagent "sees only the diff and the criteria you give it, not the reasoning that produced the change". Example: "Use a subagent to review the rate limiter diff against PLAN.md. Check that every requirement is implemented, the listed edge cases have tests, and nothing outside the task's scope changed. Report gaps, not style preferences." Caveat: "A reviewer prompted to find gaps will usually report some, even when the work is sound … Chasing every finding leads to over-engineering". Tell the reviewer to flag only gaps that affect correctness or the stated requirements. — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Writer/Reviewer across separate sessions: "A fresh context improves code review since Claude won't be biased toward code it just wrote." The same works with tests: one Claude writes the tests, another writes code to pass them. — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Long-running coding agents marked features complete after unit tests or curl checks without end-to-end verification. Prompting them to use browser automation (Puppeteer MCP) "and test like a human user" greatly improved results. Limitation: the agent couldn't see browser-native alert modals. — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Grader types: code-based (fast, cheap, objective, reproducible, but brittle to valid variation); model-based (rubric scoring, natural-language assertions, pairwise, reference-based, multi-judge consensus; flexible but non-deterministic, so it needs calibration against humans); human (gold standard, slow and expensive). Scores can be weighted, binary (all must pass) or hybrid. — [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- Judge rules: structured rubrics per dimension; "Grade each dimension with a separate, isolated LLM judge"; give the judge an out such as "Unknown" to reduce hallucinated verdicts; partial credit for multi-part tasks; calibrate against human experts. "grade what the agent produced, not the path it took." — [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- pass@k (at least one success in k tries) vs. pass^k (all k succeed). At 75% per-trial success, three trials all pass about 42% of the time. Use pass^k where consistency matters. — [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- Start with 20-50 simple tasks taken from real failures. A 0% pass rate across many trials usually means a broken task, not an incapable agent. "Read the transcripts!" — [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- Research-system judge: one LLM prompt that scored outputs from 0.0 to 1.0 plus pass/fail on factual accuracy, citation accuracy, completeness, source quality and tool efficiency "aligned best with human judgment". About 20 queries were enough early on because large prompt changes produce large effects. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Evaluator-optimizer fits "when evaluation criteria are clear and iteration measurably helps". Agents should have stopping conditions such as a maximum number of iterations. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Stop-condition phrasing from Claude Code workflow examples: "keep fixing the reported errors until the type check passes or two rounds in a row make no progress"; "stop once two rounds in a row find nothing new". — [Claude Code: dynamic workflows](https://code.claude.com/docs/en/workflows)
- The cookbook evaluator-optimizer loop returns only on `PASS` and has **no maximum iteration count**. `FAIL` is handled the same as `NEEDS_IMPROVEMENT`, and only the latest feedback is passed back. — [claude-cookbooks evaluator_optimizer.ipynb](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/evaluator_optimizer.ipynb)
- Workflow verifiers: `/deep-research` "votes on each claim" and filters out claims that don't survive cross-checking. When verifiers can't check a claim (rate limit, API error), it is listed as *unverified*, not counted as refuted. — [Claude Code: dynamic workflows](https://code.claude.com/docs/en/workflows)
- **Opus 5 counter-guidance**: "Claude Opus 5 verifies its own work without being told to. If your prompt contains explicit verification instructions ('include a final verification step for any non-trivial task,' 'use a subagent to verify'), remove them: instructions like these cause over-verification". Also avoid "double-check your answer" instructions. The sample damping prompt says "do not use subagents to verify or double-check your own work". — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- Opus 5 reviewers take filters literally: if a review prompt says "only report high-severity issues" or "be conservative", the model may report less. "Ask it to report everything and filter in a separate pass instead." — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- Test gaming: Claude can focus on passing tests at the expense of general solutions. Sample prompt: "Tests are there to verify correctness, not to define the solution … If … any of the tests are incorrect, please inform me rather than working around them." — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)

### Inferences
- **Tension to resolve in the report**: the Claude Code best-practices page recommends a fresh-context adversarial reviewer, while the Opus 5 page says to drop "use a subagent to verify" instructions. One way to reconcile them **(synthesized)**: an *external, objective* check (tests, build, Stop hook, a separate review stage the pipeline owns) is still recommended, but *in-prompt instructions telling the worker to re-verify itself* are redundant on Opus 5. Likewise, the best-practices advice to "flag only gaps that affect correctness" and the Opus 5 advice to "report everything and filter in a separate pass" are best combined as two stages: an exhaustive reviewer, then a filter or ranker step that keeps correctness-relevant findings.
- Evaluator-loop contract **(synthesized)**: the evaluator returns `{"status":"pass"|"revise"|"fail","feedback":[...],"unknown":bool}`. The loop stops on `pass`; or on `fail` (fundamentally wrong: escalate rather than polish); or after N rounds (2-3 is typical); or when a round changes nothing (same feedback twice, or no score improvement). Pass *all* prior feedback forward, or a running list of unresolved items, rather than only the latest (the cookbook passes only the latest, which can let earlier issues regress).
- Prefer the cheapest deterministic grader that works: code checks first, an LLM rubric judge only for the subjective dimensions, and one isolated judge per dimension.

### Gaps
- I found no Anthropic-published numeric guidance on the "right" maximum evaluator iterations; "two rounds without progress" comes from Claude Code workflow example prompts, not a stated rule.
- The `/goal` and Stop-hook mechanics (consecutive-block caps, evaluator model) are documented on pages I did not fetch (https://code.claude.com/docs/en/goal, https://code.claude.com/docs/en/hooks#stop).

---

## 4. Context engineering: definition, high-signal tokens, just-in-time retrieval, compaction, notes, sub-agents, tool design

### Takeaway
Context engineering means curating *everything* in the context window (system prompt, tools, examples, message history, retrieved data) toward "the smallest possible set of high-signal tokens" that makes the desired outcome most likely, because accuracy degrades as context grows ("context rot"). The practical toolkit: right-altitude system prompts, a few clear non-overlapping tools, a handful of canonical examples, just-in-time retrieval through identifiers (paths, queries) with a little pre-loaded context, compaction, external notes, and sub-agents that explore in clean windows and return 1,000-2,000-token summaries.

### Cited Findings
- Context engineering is the step after prompt engineering: it asks which *configuration of context* is most likely to produce the desired behavior, covering everything in context at inference time (tools, external data, message history), and it is iterative, redone each time context is passed in. — [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- "Context rot": as token count grows, recall accuracy declines. Context has an "attention budget" with diminishing returns. The degradation is gradual and appears across all models. — [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Guiding principle: "the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome." — [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- System prompts at the "right altitude": between brittle hardcoded if-else logic and vague guidance that assumes shared context. Organize them into sections (XML tags or Markdown headers). Start minimal, test, and add instructions or examples only for observed failures. — [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Examples: use a small set of diverse, canonical examples rather than a long list of edge-case rules. — [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Just-in-time retrieval: agents keep lightweight identifiers (file paths, stored queries, links) and load data at runtime with tools. Claude Code uses `head`/`tail`, glob and grep. Metadata (folder, names, timestamps) signals relevance. Trade-off: runtime exploration is slower and needs guidance. A **hybrid** (pre-load some, for example CLAUDE.md, and explore the rest on demand) often works best. "Do the simplest thing that works." — [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Compaction: summarize near the limit and continue in a new window. Claude Code keeps architectural decisions, unresolved bugs and implementation details, and drops redundant tool outputs. Tune compaction prompts for recall first, then precision. Clearing old tool results is a "light, safe" form of compaction. — [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Structured note-taking: persistent notes outside the window (to-do lists, NOTES.md). The Pokémon-playing Claude kept progress, maps and combat notes over thousands of steps and resumed from them after context resets. A file-based memory tool is available (it was in public beta at the time of that article). — [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Sub-agents: each works in a clean window, may use tens of thousands of tokens, and returns "a condensed, distilled summary of its work (often 1,000-2,000 tokens)". The lead coordinates and synthesizes. — [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Choosing a technique: compaction for extended back-and-forth; note-taking for iterative development with clear milestones; multi-agent for parallel research. — [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Claude Code framing: "Claude's context window fills up fast, and performance degrades as it fills … The context window is the most important resource to manage." Practices:
  - `/clear` between unrelated tasks.
  - `/compact <instructions>`; partial "Summarize from here / up to here" via `/rewind`.
  - CLAUDE.md compaction instructions, for example "When compacting, always preserve the full list of modified files and any test commands".
  - `/btw` side questions that never enter history.
  - Subagents for investigation.
  - Skills for knowledge that is only sometimes relevant, instead of CLAUDE.md.
  — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- CLAUDE.md: "For each line, ask: 'Would removing this cause Claude to make mistakes?' If not, cut it. Bloated CLAUDE.md files cause Claude to ignore your actual instructions!" Use hooks for actions that must happen every time, because CLAUDE.md is advisory and hooks are deterministic. — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- "CLI tools are the most context-efficient way to interact with external services" (for example `gh`). — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Tool design for agents:
  - Build a few tools for high-impact workflows rather than wrapping every endpoint; consolidate multi-step operations (`schedule_event`, `search_logs`, `get_customer_context`).
  - Namespace by service and resource (`asana_projects_search`).
  - Return high-signal fields (names over UUIDs; resolving IDs to natural language reduced hallucinations).
  - Offer a `response_format` enum (concise used ~1/3 of the tokens of detailed in their example, 72 vs. 206).
  - Paginate, filter and truncate with sensible defaults (Claude Code caps tool responses at 25,000 tokens by default).
  - Write actionable error messages, not tracebacks.
  - Describe tools as you would to a new hire, with unambiguous parameter names (`user_id`, not `user`).
  - Evaluate on realistic multi-call tasks and let Claude analyze transcripts and refactor the tools, with held-out tests.
  — [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Tools should be token-efficient, self-contained, clear in purpose and minimally overlapping. "Bloated tool sets" with ambiguous choices are a common failure. — [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- ACI design: include example usage, edge cases, input requirements and boundaries with other tools; "poka-yoke" tools (for example, require absolute file paths after relative paths caused errors on SWE-bench). The team spent more time optimizing tools than the overall prompt. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Model-version note: Opus 5 has a 1M-token context window as both default and maximum, "and its instruction following, tool calling, and reasoning stay consistent throughout the window." — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5). Context awareness (the model tracks its remaining token budget) is listed for Sonnet 5, Sonnet 4.6, Sonnet 4.5 and Haiku 4.5. — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- In dynamic workflows, sibling agents with the same model, effort, agent type, tools, output schema and working directory share a prompt-cache prefix. Claude Code staggers fan-out starts (default up to 5,000 ms) so the siblings read the first agent's cache. — [Claude Code: dynamic workflows](https://code.claude.com/docs/en/workflows)

### Inferences
- **Tension**: the context-engineering article (Sep 2025) says context rot appears across all models, while the Opus 5 page claims behavior stays consistent across its 1M window. The cautious reading: a bigger window doesn't remove the cost of irrelevant tokens (attention, cost, latency, distraction), and Claude Code's current docs still say "performance degrades as it fills". Keep curating.
- Pipeline rules **(synthesized)**: each step receives only what it needs (the upstream artifact plus its criteria, not the whole transcript); pass references (paths, IDs) and let the step fetch details; keep stable, shared prefixes (system prompt, tools) identical across parallel workers so they hit the prompt cache; cap tool output size at the tool, not in the prompt.
- Sub-agent return contract **(synthesized)**: a short summary (target ≤ ~1-2k tokens per the article), key findings with sources, open questions, and a path to the full output file.

### Gaps
- I didn't fetch the memory-tool or context-editing ("tool result clearing") API docs, so their current GA/beta status and parameter names are unverified here.
- I didn't verify the exact current Claude Code compaction trigger threshold.

---

## 5. Long-running and multi-context-window work: initializer, progress file, feature list, git as state, fresh start vs. compaction, handoffs

### Takeaway
For work that spans many context windows, Anthropic's recipe is: a distinct *first-session* prompt that sets up the environment (`init.sh`, a JSON feature or test list with everything failing, a progress log, an initial git commit); then each later session reads the state, runs a smoke test, does **one** feature, verifies it end to end, commits, and updates the notes. Use JSON for structured state, free text for progress notes, and git for history and rollback. Current models are good at rediscovering state from the filesystem, so a fresh window with a prescriptive startup routine is often better than compaction.

### Cited Findings
- Failure patterns without a harness: the agent tries to one-shot the whole app and runs out of context mid-feature, leaving partial, undocumented work; later sessions see progress and declare the project done too early. — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Two-part solution: an **initializer agent** (first session) creates `init.sh`, `claude-progress.txt` and an initial git commit; a **coding agent** (every later session) makes incremental progress, leaves the code clean and records structured updates. They differ only in their initial prompt; system prompt, tools and harness are the same. — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Feature list: the initializer expands the user prompt into a JSON file of requirements (200+ features for a claude.ai clone, all initially failing). Each entry has a category, description, test steps and a `passes` field. Coding agents may only change `passes`; the prompt says it is unacceptable to remove or edit tests. "JSON was chosen because models are less likely to inappropriately overwrite it than Markdown." — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Session startup routine: `pwd`; read the git log and progress files; read the feature list and pick the highest-priority unfinished feature; run `init.sh` and a basic end-to-end check before new work, which catches a broken state left by the previous session "and avoids compounding the problem". — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Failure → fix table:

  | Problem | Initializer fix | Coding-agent fix |
  |---|---|---|
  | Premature victory | Create a structured feature list | Read it and work on one feature |
  | Bugs or undocumented progress | Create a git repo and progress notes | Read the notes, test the basics, commit and update at session end |
  | Features marked done too early | Set up the feature list | Verify features before marking them passing |
  | Time lost working out how to run the app | Write `init.sh` | Start by reading `init.sh` |

  — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Open question noted by the authors: whether one general coding agent beats specialized testing, QA or cleanup agents is unresolved. — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Current docs recipe for multi-window tasks:
  1. Use a different prompt for the very first context window.
  2. Write tests in a structured format (`tests.json`) with "It is unacceptable to remove or edit tests because this could lead to missing or buggy functionality."
  3. Set up quality-of-life tools (`init.sh`).
  4. **Starting fresh vs. compacting**: "consider starting with a brand new context window rather than using compaction. Claude's latest models are extremely effective at discovering state from the local filesystem." Be prescriptive: "Call pwd…", "Review progress.txt, tests.json, and the git logs.", "Manually run through a fundamental integration test before moving on…"
  5. Provide verification tools (computer use, browser use, browser MCP).
  6. Encourage full use of context without leaving "significant uncommitted work".
  — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- State-management rules: JSON or other structured formats for structured state (test results, task status); unstructured text for progress notes; git for a log and restorable checkpoints ("Claude's latest models perform especially well in using git to track state across multiple sessions"); explicitly ask for incremental progress. Example `tests.json` (`{"tests":[{"id":1,"name":"authentication_flow","status":"passing"},…],"total":200,"passing":150,…}`) and `progress.txt` ("Session 3 progress: - Fixed authentication token validation … - Next: investigate user_management test failures (test #2) - Note: Do not remove tests…"). — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- In harnesses that compact or save to files, tell the model so it doesn't wrap up early. Sample: "Your context window will be automatically compacted as it approaches its limit … do not stop tasks early due to token budget concerns. As you approach your token budget limit, save your current progress and state to memory before the context window refreshes." — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- Specs as handoffs: have Claude interview you and write `SPEC.md`, then "start a fresh session to execute it". "The most useful specs are self-contained: they name the files and interfaces involved, state what is out of scope, and end with an end-to-end verification step that proves the feature works." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Session hygiene: name sessions (`/rename`) and treat them like branches; `claude --continue` / `--resume`. Checkpoints (`/rewind`) only track Claude's file edits, not Bash changes: "This isn't a replacement for git." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- "If you've corrected Claude more than twice on the same issue in one session, the context is cluttered with failed approaches. Run `/clear` and start fresh with a more specific prompt … A clean session with a better prompt almost always outperforms a long session with accumulated corrections." — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Multi-agent research long-horizon tips: the lead saves its plan to memory because context beyond 200k tokens is truncated; summarize completed phases, store essentials externally, and spawn fresh subagents with clean handoffs. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Opus 5 note: "It completes full tasks rather than leaving stubs or placeholders, and it performs best when given the complete task specification up front and left to run." — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- Dynamic workflow runs are resumable within the session (completed agents return saved results; the first changed or failed agent and everything after it re-run). Results persist under `~/.claude/projects/` and can be replayed after `claude --resume`. A fresh session starts the workflow over. — [Claude Code: dynamic workflows](https://code.claude.com/docs/en/workflows)

### Inferences
- Minimal handoff note between sessions **(synthesized from the harness and spec guidance)**:
  ```text
  # Handoff: <task> (session N, YYYY-MM-DD)
  Goal / done-criteria: <one line + link to SPEC.md or features.json>
  State: <branch, last commit hash, what passes now (command + result)>
  Done this session: <bullets>
  Next: <the single next item, by id>
  Known broken / open questions: <bullets>
  Do not: <invariants, e.g. don't edit tests, don't touch migrations>
  Startup: pwd; read this file + git log -10; run <init/smoke command>
  ```
- Rule of thumb **(synthesized)**: compact when you're mid-thought in one coherent problem and the history is valuable; start fresh (with a handoff or progress file) when switching phases, after repeated failed corrections, or whenever state is fully captured in files and git.

### Gaps
- No Anthropic source I found gives a quantitative comparison of fresh-start vs. compaction outcomes; the guidance is qualitative.
- The Opus 5 page mentions "long-run progress claims" as a Fable 5 topic (it is linked from the best-practices index); I didn't fetch the Fable 5 prompting page, so model-specific guidance on agents overstating progress is not captured.

---

## 6. Multi-agent research systems: orchestrator prompts, scaling effort, delegation, parallelism, token costs

### Takeaway
Anthropic's research system (Opus 4 lead with Sonnet 4 subagents) beat single-agent Opus 4 by 90.2% on its internal eval, mostly because it spends more tokens in parallel clean contexts. It costs about 15× chat tokens, so it only pays off for valuable, broad, parallelizable questions. What makes it work: explicit delegation briefs (objective, output format, tools, boundaries), effort-scaling rules embedded in the lead prompt, broad-then-narrow search, parallel tool calls, filesystem handoffs, and outcome-based LLM-judge evals.

### Cited Findings
- Architecture: orchestrator-worker. A lead agent plans, spawns parallel subagents (each with its own tools, prompts and context), synthesizes their findings and decides whether more research is needed. A CitationAgent attaches sources at the end. The search is iterative rather than static RAG. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Performance: +90.2% vs. single-agent Opus 4 on the internal research eval. On BrowseComp, three factors explained 95% of variance, and token usage alone about 80% (tool calls and model choice the rest). Agents use about 4× the tokens of chat; multi-agent systems about 15×. Parallelization cut research time by up to 90% on complex queries. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Eight prompting principles:
  1. Think like your agents: simulate their exact prompts and tools and watch step by step.
  2. Teach the orchestrator to delegate: each subagent needs an objective, an output format, tool guidance and clear task boundaries; vague instructions led to duplicated work.
  3. Scale effort to complexity: simple fact-finding uses 1 agent with 3-10 tool calls; comparisons use 2-4 subagents with 10-15 calls each; complex research uses 10+ subagents.
  4. Tool design matters: distinct purposes; check the available tools first; prefer specialized over generic tools.
  5. Let agents improve themselves: a tool-testing agent rewrote flawed tool descriptions and cut task completion time by 40%.
  6. Start wide, then narrow: agents default to overly long, specific queries.
  7. Guide thinking: extended thinking as the lead's scratchpad; interleaved thinking in subagents to judge tool results.
  8. Parallelize: the lead spawns 3-5 subagents at once, and subagents make 3+ tool calls in parallel.
  — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Evaluation: start with about 20 realistic queries; use an LLM judge with a rubric (factual accuracy, citation accuracy, completeness, source quality, tool efficiency); human testers caught source-quality issues (early agents favored SEO content farms); judge the end state, not the path. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Production: stateful errors compound, so resume from checkpoints instead of restarting, and tell the agent when a tool fails so it can adapt; full tracing; rainbow deployments; the synchronous bottleneck (the lead waits for each batch of subagents). — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Current models orchestrate subagents natively and may overuse them (Opus 4.6 "has a strong predilection for subagents"; Opus 5 delegates "more readily"). Damping prompt: "Use subagents when tasks can run in parallel, require isolated context, or involve independent workstreams that don't need to share state. For simple tasks, sequential operations, single-file edits, or tasks where you need to maintain context across steps, work directly rather than delegating." — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- Opus 5 damping prompt: "Delegate to a subagent only for large tasks that are genuinely independent and parallelizable … Do not delegate work you can finish yourself in a handful of tool calls … If one subagent can complete the task, use one rather than several, and keep spawn counts low." Deterministic caps in Claude Code and the Agent SDK: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, and the SDK's `max_budget_usd` / `maxBudgetUsd` (Claude Code 2.1.217+). Opus 5 "coordinates teams of subagents well, with effective writer-verifier patterns and few cases of agents overwriting each other's work." — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- Research prompts: give clear success criteria, ask for verification across sources, and for complex tasks: "develop several competing hypotheses. Track your confidence levels in your progress notes … Update a hypothesis tree or research notes file". — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- Claude Code workflow cost controls: a "Large workflow" warning above 25 agents or 1.5M projected tokens (advisory only); size guideline `small` (<5 agents), `medium` (<10, the default; `small` on Pro), `large` (<50), or `unrestricted`; run on a small slice first; use smaller models for stages that don't need the strongest one. — [Claude Code: dynamic workflows](https://code.claude.com/docs/en/workflows)

### Inferences
- Delegation brief template **(synthesized from principle 2 and the context-engineering return-size guidance)**:
  ```text
  <objective>One question this subagent must answer, and why it matters to the overall task.</objective>
  <scope>In: ... Out (another agent covers it): ...</scope>
  <sources_and_tools>Prefer X; start with short broad queries, then narrow; budget ~10-15 tool calls.</sources_and_tools>
  <output_format>Write full notes to <path>. Return ≤ 300 words: key findings with source URLs, confidence, gaps.</output_format>
  <stop_when>The question is answered with sources, or the budget is spent; report gaps rather than guessing.</stop_when>
  ```
- Effort scaling belongs in the *orchestrator's* prompt as explicit numbers (agents × tool calls per query type). Late-2026 models tend to over-delegate rather than under-delegate, so pair the numbers with a deterministic cap.

### Gaps
- The research-system post's specific anecdotes (for example, early versions spawning many subagents for simple queries) weren't in the fetched extract, so I don't cite them.
- I didn't find Anthropic data on multi-agent gains with the current Opus 5 / Sonnet 5.5 generation; the 90.2% figure is from the Opus 4 / Sonnet 4 era.
- The cookbook notebooks `async_multi_agent_orchestration.ipynb` and `latency_multi_agent.ipynb` ("Multi-Agent Teams Under Latency Pressure and Budgets") exist, but I didn't read their contents.

---

## 7. Common pipeline failure modes and how to avoid them

### Takeaway
The recurring failures are: errors compounding across steps or sessions; vague handoffs or delegation; information loss through a coordinator; over-delegation and over-verification; context rot from kitchen-sink sessions and bloated instructions or tools; premature "done" claims; test gaming; reviewer findings causing over-engineering; and unbounded loops. Each has a documented countermeasure, mostly some mix of explicit contracts, deterministic gates, fresh contexts and hard caps.

### Cited Findings
- **Error compounding**: autonomous agents "risk compounding errors", so test in sandboxes with guardrails and stopping conditions. — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents). Stateful errors compound in multi-agent systems, so resume from checkpoints and surface tool failures to the agent. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system). A smoke test at session start "avoids compounding the problem". — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- **Vague handoffs / delegation**: without an objective, output format, tool guidance and boundaries, subagents duplicated work. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system). Specs should name files and interfaces, state what is out of scope and end with an end-to-end verification step. — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- **Game of telephone**: route subagent outputs to the filesystem and pass references. — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- **Over-delegation**: Opus 4.6 and Opus 5 spawn subagents where a direct grep would do; add when-to-delegate guidance and caps. — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices); [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- **Over-verification and scope creep** on Opus 5: remove redundant verification instructions. Constrain scope: "Deliver what was asked, at the scope intended … say so in a sentence and continue with the task as asked rather than quietly narrowing, widening, or transforming it." — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- **Context rot / kitchen sink**: Claude Code lists "the kitchen sink session" (fix: `/clear` between tasks), "correcting over and over" (after two failed corrections, `/clear` and rewrite the prompt), "the over-specified CLAUDE.md" (prune, or turn rules into hooks), "the trust-then-verify gap" ("If you can't verify it, don't ship it.") and "the infinite exploration" (scope narrowly or use subagents). — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- **Tool bloat / ambiguity**: bloated, overlapping tool sets are a common failure. — [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents). Opaque error codes, UUID-heavy outputs and untruncated responses waste context. — [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents)
- **Premature victory / one-shotting**: use a structured feature list, one feature per session, and verify end to end before flipping `passes`. — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- **Test gaming / hardcoding**: tell Claude tests verify correctness rather than define the solution, and to report bad tests instead of working around them. — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- **Reviewer-driven over-engineering**: gap-hunting reviewers always find something; limit them to correctness and stated requirements. — [Claude Code best practices](https://code.claude.com/docs/en/best-practices). Overeagerness: Opus 4.5 and 4.6 add files, abstractions and flexibility nobody asked for; there is a sample "Avoid over-engineering" prompt. — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- **Brittle graders / path-checking**: grade outcomes, not step sequences; avoid verifiers so strict they reject correct answers over formatting. — [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents); [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents)
- **Unbounded loops / runaway cost**: the cookbook evaluator loop has no iteration cap. — [cookbook evaluator_optimizer.ipynb](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/patterns/agents/evaluator_optimizer.ipynb). Claude Code workflows enforce 1,000 agents per run, 16 concurrent by default, and 4,096 items per `parallel()`/`pipeline()`, and they reject longer lists with an error ("A silent cap would drop part of the workload without telling the script"). — [Claude Code: dynamic workflows](https://code.claude.com/docs/en/workflows)
- **Format-induced errors**: diffs and code-in-JSON are hard formats; relative paths broke after `cd` (fixed by requiring absolute paths). — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- **Destructive shortcuts in autonomous runs**: the sample prompt asks for confirmation before destructive, hard-to-reverse or externally visible actions, and says "do not use destructive actions as a shortcut", for example "--no-verify". — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- **Untrusted script-computed prompts**: in auto mode, prompts a workflow script passes to `agent()` don't count as user requests when the permission classifier reviews that subagent's actions. — [Claude Code: dynamic workflows](https://code.claude.com/docs/en/workflows)

### Inferences
- A pipeline-design checklist **(synthesized)**:
  1. Can a single call do it?
  2. Does every step have one goal, a typed output contract and a code gate?
  3. Does every loop have a round cap and a no-progress stop?
  4. Does every delegated task have objective, scope, format and budget?
  5. Do large outputs go to files with references?
  6. Is there an objective check before "done", run by something other than the worker's own say-so?
  7. Is session state in JSON + notes + git, so a fresh window can resume?
  8. Are model-specific habits (over-delegation and over-verification on Opus 5) damped in the prompt, and capped deterministically?
- Many 2024-2025 tips ("add a verification step", "double-check") are now anti-patterns on Opus 5-class models. Pipelines carried over from older models should be re-evaluated, ideally with a small (20-50 task) eval set, rather than assumed to still be optimal.

### Gaps
- I found no first-party quantitative data on error-compounding rates per chain length; the guidance is qualitative.
- I didn't check Sonnet 5.5 / Haiku 5.5-specific pipeline guidance (for example "early stopping in long agent prompts" for Haiku 5.5, "JSON output on reasoning tasks" for Sonnet 5.5). The best-practices index links those pages, but I didn't fetch them. They matter if cheaper models run pipeline steps.
