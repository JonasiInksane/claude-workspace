---
title: MCP servers
tags: [claude-code, mcp, playwright, windows, secrets]
updated: 2026-10-20
claude_code_version: 2.1.304
---

# MCP servers

**TL;DR:** Project servers go in `.mcp.json` at the repo root (committed, approved once per user),
personal ones in local or user scope via `claude mcp add`, and secrets stay in environment
variables (`${VAR}`), never in the JSON. On Windows try plain `npx` first and fall back to
`cmd /c` only if the server fails to start.

## Scopes

| Scope | Stored in | Visible to | Add with |
|---|---|---|---|
| `local` (default) | `~/.claude.json`, under this project | You, this project | `claude mcp add ...` |
| `project` | `.mcp.json` in the repo root | Everyone who clones | `claude mcp add --scope project ...` |
| `user` | `~/.claude.json` | You, every project | `claude mcp add --scope user ...` |

If two scopes define the same name, one wins (local > project > user > plugin > claude.ai
connectors); entries are not merged.

## .mcp.json schema

```json
{
  "mcpServers": {
    "<name>": { "type": "stdio", "command": "npx", "args": ["-y", "<package>"], "env": { "KEY": "${KEY}" } },
    "<name2>": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" } }
  }
}
```

- No `type` means stdio. A server with `url` but no `type` is **rejected**.
- `sse` still works but is deprecated; use `http` for remote servers.
- Optional per server: `timeout` (milliseconds) and `"alwaysLoad": true` (skip tool-search deferral).
- This hub ships `{"mcpServers": {}}`: it needs no servers.

## Environment variable expansion

- `${VAR}` and `${VAR:-default}` expand in `command`, `args`, `env`, `url` and `headers`.
- An unset variable without a default stays as literal `${VAR}` text, and `claude mcp list` warns.
- `CLAUDE_PROJECT_DIR` is not set in Claude Code's own environment, so write
  `${CLAUDE_PROJECT_DIR:-.}` for project paths.
- In a remote server's `url` and `headers`, credential variables such as `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `NPM_TOKEN` and `HTTPS_PROXY` always expand
  to an empty string. Copy the value into a variable with your own name.
- Set a variable for your user (new terminals pick it up):
  `[Environment]::SetEnvironmentVariable('DOCS_MCP_TOKEN', '<value>', 'User')`.
  List only the **name** in `.env.example`.

## Approval prompt

- In interactive sessions Claude Code asks before it uses servers from `.mcp.json`. Undo your
  answers with `claude mcp reset-project-choices`.
- `enableAllProjectMcpServers` or `enabledMcpjsonServers` in a committed `.claude/settings.json`
  are ignored until the folder is trusted. `disabledMcpjsonServers` always blocks by name.
- `claude -p`, SDK and cloud sessions load project servers **without asking**.

## claude mcp commands

```powershell
# stdio server, local scope. Claude's options go before --; everything after -- is the server command
claude mcp add --transport stdio --scope local pw -- npx -y @playwright/mcp@latest
# remote http server, written to .mcp.json
claude mcp add --transport http --scope project docs https://example.com/mcp
# with an env var (-e) for a stdio server, or a header (-H) for an http server
claude mcp add my-server --scope project -e API_KEY=placeholder -- npx -y my-mcp-server
claude mcp add --transport http docs https://example.com/mcp -H "Authorization: Bearer placeholder"
claude mcp list              # status of every server
claude mcp get pw            # details of one
claude mcp remove pw
```

- `-e` and `-H` accept several values, so put the server name **before** them (as above).
- Values passed with `-e` or `-H` are written into the config file as plain text. For a
  project-scope server, edit `.mcp.json` afterwards so it reads `${VAR}` instead of the real secret.
- `claude mcp add-json <name> '<json>'` also exists, but Windows PowerShell 5.1 strips the inner
  double quotes when it passes `'{"type":"stdio"}'` to a native program (tested). Escape them as
  `\"` or edit `.mcp.json` by hand, which is simpler.

In a session: `/mcp` shows servers, connection status and OAuth login; `/mcp reconnect <server>`,
`/mcp enable|disable <server>`. Env vars: `MCP_TIMEOUT` (startup, ms), `MAX_MCP_OUTPUT_TOKENS`
(default 25,000).

## Windows and npx

- The official docs no longer require a `cmd /c` wrapper, and v2.1.119 removed the warning that
  suggested one. Use `"command": "npx"` first.
- Only if the server fails to connect on native Windows (check `/mcp` or `claude mcp list`), switch
  to `"command": "cmd", "args": ["/c", "npx", "-y", "<package>"]` and edit the JSON by hand.
  (Unverified third-party reports say `claude mcp add` can mangle `/c`.)
- This is different from hooks: exec-form **hooks** cannot start `npx.cmd` at all
  (see [Hooks on Windows](hooks-on-windows.md)).

## Example entries

**Playwright, for testing a Next.js app in a browser** (config from the Playwright MCP README;
the same entry ships in this workspace's Next.js template `.mcp.json`):

```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
  }
}
```

Useful args from the README: `--headless`, `--browser msedge`, `--isolated`. Start `npm run dev`
first, then ask Claude to open `http://localhost:3000` and check the page.

**Next.js dev-server tools** (from the Next.js docs, needs Next.js 16+; connects to the running
`next dev` through its `/_next/mcp` endpoint):

```json
{
  "mcpServers": {
    "next-devtools": { "command": "npx", "args": ["-y", "next-devtools-mcp@latest"] }
  }
}
```

**Remote http server with a bearer token from an env var.** *Illustrative only*: the server name,
URL and variable are placeholders, not a real service.

```json
{
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "${DOCS_MCP_URL:-https://example.com/mcp}",
      "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" }
    }
  }
}
```

## Good habits

- Start each project with zero to three servers it actually uses; every server adds tools and context.
- Allow or deny MCP tools with permission rules: `mcp__playwright`, `mcp__playwright__*`,
  `mcp__playwright__browser_navigate` (no parentheses).
- Once a server works, file the setup steps as a knowledge note (`/capture-lesson`).

Sources: https://code.claude.com/docs/en/mcp, https://github.com/microsoft/playwright-mcp,
https://nextjs.org/docs/app/guides/mcp
