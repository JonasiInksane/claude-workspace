---
title: "Debug (interactive)"
description: "Ranked hypotheses, a failing repro test, then the fix. Starts in plan mode."
target: project
project: "tattoogenda"
permissionMode: "plan"
effort: "high"
ask: "What is wrong, and how do I reproduce it?"
askRequired: true
---

Find and fix the bug I describe at the end of this prompt.

Read CLAUDE.md and AGENTS.md at the root of this repository first, and the definition of done they point to.

1. Read the code on the path of the bug. Then list your hypotheses for the cause, most likely first, each with the evidence for and against it and the quickest way to tell it apart from the others. Ask what you need to know, then wait for my OK on which one to chase.
2. Write a test that reproduces the bug and fails for the reason you expect. Run it and show me the failure. If the bug can't be pinned in a test, explain why and stop with your diagnosis.
3. Fix the cause, not the symptom. The repro test passes, and every existing test stays green without edits.
4. Run the type checks, lint and tests of every workspace you touched, with the repository's own scripts.
5. Tell me the root cause in two or three sentences, what you verified and what you did not, and write a record if the project's docs ask for one.

Do not commit, push or touch files outside the approved plan without asking me.
