---
title: "Fix a finding (interactive)"
description: "A contract test that fails first, then the smallest fix, then the record. Starts in plan mode."
target: project
project: "tattoogenda"
permissionMode: "plan"
effort: "high"
ask: "Which finding, and anything I should know?"
askRequired: true
---

Fix the audit finding I name at the end of this prompt.

Read CLAUDE.md and AGENTS.md at the root of this repository first, and the definition of done they point to. Then look the finding up in the project's audit document, so you work from its full text and not only from my summary.

1. Restate the finding in your own words and show that it still exists on this branch by quoting the code. If it is already fixed, say so and stop.
2. Propose the smallest fix that closes it, with the files it touches and what could break. Ask what you need to know, then wait for my OK.
3. Write a contract test that fails on the current code because of the finding. Run it and show me the failure before you fix anything.
4. Fix it. The new test passes, and every existing test stays green without edits.
5. Run the type checks, lint and tests of every workspace you touched, with the repository's own scripts.
6. Write the record the project's docs ask for, naming the finding, and tell me what you verified and what you did not.

Do not commit, push or touch files outside the approved plan without asking me.
