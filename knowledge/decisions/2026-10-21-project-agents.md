---
title: Project agents with their own memory and images
tags: [decision, agents, memory, inbox, workspace]
updated: 2026-10-21
claude_code_version: 2.1.305
---

# Project agents with their own memory and images

**TL;DR:** Each project can have specialist agents (for example `asset-builder`), defined in
the project's `.claude/agents/`. Each has its own memory folder in the project repo and its own
image folder in the workspace inbox, and is started in an isolated session by
`node tools/agent-session.mjs`. This is slice 1 of the workspace app plan below.

## Context

- The user wants one agent per role inside a project, each remembering only its own
  learnings, plus a separate image folder per agent. Later, a Windows app should manage it all.
- Hub memory is `knowledge/` with auto memory off
  ([workspace structure](2026-10-20-workspace-structure.md)). Project sessions use their own
  settings, where auto memory is on.
- Tested on 2.1.305: `--agent` sessions also load the project's shared auto memory, and project
  `additionalDirectories` are ignored until the folder is trusted
  ([agent memory note](../claude-code/agent-memory.md)).

## Options

| Topic | Options considered |
|---|---|
| Memory store | A. Subagent `memory: project` (in the repo). B. `memory: local` (gitignored). C. Hand-rolled notes files the prompt points at |
| Isolation in `--agent` sessions | Accept the shared project memory, turn auto memory off (kills agent memory too), or redirect `autoMemoryDirectory` per session |
| Image access | Project `additionalDirectories` (needs trust, grants all agents' folders), `--add-dir`, or a per-session `--settings` file |
| Image location | Inside the project repo, or the gitignored hub inbox |

## Decision

1. **`memory: project`.** Built in, loads automatically, versioned with the project.
2. **Isolated launch through `tools/agent-session.mjs`.** It writes a per-session settings file to
   `%TEMP%\claude-workspace\agent-sessions\` and runs `claude --agent <name> --settings <file>` in
   the project. The file sets `autoMemoryDirectory` to the agent's folder and grants only that
   agent's and the project's `_shared` image folders. It is the one launch path: the CLI, and
   the workspace app, which runs it in a Windows Terminal tab (`start.ps1` later).
3. **Images in the inbox, per agent:** `inbox/attachments/<project>/<agent>/YYYY-MM-DD/`, plus
   `<project>/_shared/`, and `inbox/attachments/_hub/YYYY-MM-DD/` for images that belong to no
   project (a triage item like any other).
4. **Scaffolding by `tools/new-agent.mjs`** from `templates/agent/`. It never overwrites, and
   refuses built-in, library, duplicate and non-kebab names. `agent-session.mjs` refuses unsafe
   or duplicate names and `memory: user`, before it creates any folder.

## Plan (agreed 2026-10-20)

1. Agent convention: this record, `templates/agent/`, `new-agent.mjs`, `agent-session.mjs`,
   tests (done 2026-10-21).
2. Inbox layout: `_hub/`, `<project>/_shared/`, `<project>/<agent>/`; session-start,
   build-index and `/inbox-triage` treat agent image folders as libraries, not triage items
   (done 2026-10-21).
3. Workspace app: a Node server with no dependencies on `127.0.0.1` with a session token,
   opened as an Edge app window. Dashboard, project cards, agents (create, start, memory, images)
   and image upload (drag/drop, Ctrl+V) to a chosen project and agent
   (done 2026-10-21: `tools/workspace-app/`).
4. Launcher and docs: `Workspace App.cmd`, a desktop shortcut, a `start.ps1` menu entry and
   README updates (done 2026-10-21: `tools/workspace-app/start-app.ps1` runs the app hidden,
   `make-shortcut.mjs` makes the shortcut with an icon drawn by `make-icon.mjs`).

## Consequences

- Agent memory lives in the project repo; the user decides when to commit it there.
- Only sessions started by `agent-session.mjs` (or the app) are isolated. A plain
  `claude --agent X` still sees the project's shared memory, and as a subagent X cannot read its
  inbox images without a prompt.
- MEMORY.md loads twice in isolated sessions (agent memory plus auto memory): a small context cost.
- Isolation is about what loads, not a security boundary. With tools, an agent can still read
  other agents' memory files in the repo; its prompt tells it not to.
- `tools/lib/inbox.mjs` is the one rule for what waits in the inbox (session status, navigator,
  check-workspace; `/inbox-triage` states the same rule). Files under `attachments/<project>/`
  are libraries only while `projects/<project>` exists; otherwise they come back as triage items.
- "Continue last session" is not offered for agents yet: `claude -c` resumes the latest session
  in the folder, which may belong to another agent.
- Revisit if: Claude Code documents `memory` for `--agent`, adds per-agent directory grants, or
  stops loading the shared auto memory in `--agent` sessions.
