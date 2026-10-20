---
title: Agent memory and isolated agent sessions
tags: [claude-code, subagents, memory, agent, permissions, windows]
updated: 2026-10-21
claude_code_version: 2.1.305
---

# Agent memory and isolated agent sessions

**TL;DR:** `memory: project` gives an agent its own `.claude/agent-memory/<name>/MEMORY.md`, but
`claude --agent <name>` also loads the project's shared auto memory. Launch with `--settings`
holding `autoMemoryDirectory` (the agent's folder) and `additionalDirectories` (its image
folders) to get a session that sees only its own memory. `node tools/agent-session.mjs` does that.

## The `memory` field

| Scope | Folder | Notes |
|---|---|---|
| `project` | `<cwd>/.claude/agent-memory/<name>/` | In the repo, so it can be committed. Used by this workspace |
| `local` | `<cwd>/.claude/agent-memory-local/<name>/` | Meant to stay out of git (documented, not tested) |
| `user` | `~/.claude/agent-memory/<name>/` | Shared by every project; same-named agents collide (documented, not tested) |

- `<name>` is the frontmatter `name:`, not the filename (verified).
- The first 200 lines or 25KB of `MEMORY.md` load into the agent's prompt, plus instructions to
  keep it as an index of topic files (verified).
- Memory adds Write and Edit to the agent's tools even when `tools:` lists only Read, Glob and Grep.
  In default mode, writes to the memory folder were not prompted (verified in `-p`).
- With auto memory off (`autoMemoryEnabled: false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY`), the
  field does nothing (documented). The hub turns auto memory off, so agent memory only works in
  project sessions. Project templates leave it on.

## Subagent vs `--agent`

- **As a subagent** (Agent tool, "use the X agent"): gets its own MEMORY.md, not the main
  session's auto memory (documented and verified).
- **As the whole session** (`claude --agent X`): gets X's MEMORY.md (not stated in the docs,
  verified) **and** the project's shared auto memory in `~/.claude/projects/<slug>/memory/`
  (verified). Two agents of one project would share notes through it.

## Isolated launch

```powershell
claude --agent asset-builder --settings $env:TEMP\claude-workspace\agent-sessions\<project>--asset-builder--<hash>.json
```

`<hash>` is 8 characters of a hash of the workspace root, so two workspace copies never share a
file. `node tools/agent-session.mjs <project> <agent> --print` prints the exact path and command.

```json
{
  "autoMemoryEnabled": true,
  "autoMemoryDirectory": "C:\\dev\\claude-workspace\\projects\\<project>\\.claude\\agent-memory\\asset-builder",
  "permissions": { "additionalDirectories": [
    "C:\\dev\\claude-workspace\\inbox\\attachments\\<project>\\asset-builder",
    "C:\\dev\\claude-workspace\\inbox\\attachments\\<project>\\_shared"
  ] }
}
```

- `autoMemoryDirectory` is read from any settings scope, including `--settings` (documented). With
  it, the shared project memory no longer loads (verified). The agent's MEMORY.md then loads twice
  (agent memory plus auto memory). That costs context but nothing breaks.
- `--settings` outranks project settings, so `autoMemoryEnabled: true` there keeps memory on
  (documented precedence; not tested against a project that turns it off).
- `agent-session.mjs` picks the folder from the agent's scope (`project` or `local`) and refuses
  `user` (shared by every project) and agents without `memory:`.
- Use absolute paths. Relative `additionalDirectories` resolve against the session's cwd, not
  the settings file (verified for `--settings`).
- End-to-end test with two agents in one project: each saw only its own codeword and could
  read only its own image folder. The other agent's folder was denied in `-p`; interactively it
  would prompt. A plain session saw the shared memory (verified 2026-10-21).

## Reading folders outside the project

- Reads outside the working directory are denied in `-p` and prompt interactively (verified).
- `permissions.additionalDirectories` in a project's `.claude/settings.json` is **ignored until
  the folder is trusted** (stderr: "Ignoring 1 permissions.additionalDirectories entry ... not
  been trusted"). `--settings` and `--add-dir` work without trust (verified).
- `--add-dir` also loads `.claude/skills`, `.claude/commands` and `.claude/agents` from that
  folder; settings entries grant file access only (documented in the settings reference, not tested).

Sources: https://code.claude.com/docs/en/sub-agents, https://code.claude.com/docs/en/memory,
https://code.claude.com/docs/en/permissions, https://code.claude.com/docs/en/settings-reference
