---
title: "Refactor (interactive)"
description: "Plan first, characterization tests before any edit, then the change and its record. Starts in plan mode."
target: project
project: "tattoogenda"
permissionMode: "plan"
effort: "high"
ask: "What do you want to refactor?"
askRequired: true
---

Refactor what I describe at the end of this prompt, in small steps I can review one at a time.

Before you plan anything, read CLAUDE.md and AGENTS.md at the root of this repository, and the definition of done they point to. Where they say more than this brief, they win.

1. Explore the code I name and everything that calls it. Then propose a plan: the first slice you would do, the files it touches, the risks you see (money, tenant boundaries, API and queue contracts) and what stays out of scope. Ask what you need to know, then wait for my OK.
2. Before you change any code that carries behaviour, write characterization tests that pin how it behaves today, and run them green against the unchanged code.
3. Make the change. The characterization tests stay green without edits; if one has to change, stop and tell me why first.
4. Run the type checks, lint and tests of every workspace you touched, with the repository's own scripts.
5. Write the refactor record the project's docs ask for, and tell me what you verified and what you did not.

Do not commit, push or touch files outside the approved plan without asking me.
