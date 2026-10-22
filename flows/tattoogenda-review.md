---
title: "Review (interactive)"
description: "A read-only review that follows the project's Code Review Rules. Starts in plan mode."
target: project
project: "tattoogenda"
permissionMode: "plan"
effort: "high"
ask: "What should I review?"
askRequired: true
---

Review what I name at the end of this prompt: a branch, a commit range, a folder or my uncommitted changes. This is a read-only review: do not edit, create or delete any file.

Read CLAUDE.md and AGENTS.md at the root of this repository first, and follow the Code Review Rules in AGENTS.md.

Look hardest at money handling, tenant boundaries, API and queue contracts, and tests that were weakened or removed. Check each claim against the code before you report it.

Report your findings as a list, most severe first, each as [severity] path:line, followed by the problem, the evidence (quote the code), and a suggested fix. Severity is critical, high, medium or low. End with what you could not check, and stop there.
