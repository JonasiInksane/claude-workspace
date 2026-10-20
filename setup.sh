#!/usr/bin/env bash
# Checks (and optionally sets up) what this Claude Code workspace needs.
# Works in Git Bash on Windows, and on macOS and Linux.
#
#   bash setup.sh            same as: bash setup.sh check
#   bash setup.sh check      report Node, git, Git Bash, claude, PATH and the global library; changes nothing
#   bash setup.sh install    the checks, then install the library into ~/.claude, build index.html,
#                            run the workspace self-check and offer "git init"
#
# On Windows, Setup.ps1 does the same from PowerShell and can also fix your user PATH (-FixPath).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-check}"

usage() {
  echo "Usage: bash setup.sh [check|install]"
}

case "$MODE" in
  check|install) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac

if [ -t 1 ]; then
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; GRAY=$'\033[90m'; RESET=$'\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; CYAN=''; GRAY=''; RESET=''
fi

PROBLEMS=0
WARNINGS=0
NEXT=()

ok()      { printf '  %s[ OK ]%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()    { WARNINGS=$((WARNINGS + 1)); printf '  %s[WARN]%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail()    { PROBLEMS=$((PROBLEMS + 1)); printf '  %s[FAIL]%s %s\n' "$RED" "$RESET" "$*"; }
info()    { printf '         %s%s%s\n' "$GRAY" "$*" "$RESET"; }
section() { printf '\n%s%s%s\n' "$CYAN" "$*" "$RESET"; }
next_step() {
  local s
  for s in ${NEXT[@]+"${NEXT[@]}"}; do
    if [ "$s" = "$1" ]; then return 0; fi
  done
  NEXT+=("$1")
}

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WIN=1 ;;
  *) IS_WIN=0 ;;
esac

# On Windows, Claude Code and the Node tools use %USERPROFILE%, which can differ from Git Bash's $HOME.
USER_HOME="$HOME"
if [ "$IS_WIN" = 1 ] && [ -n "${USERPROFILE:-}" ] && command -v cygpath >/dev/null 2>&1; then
  USER_HOME="$(cygpath -u "$USERPROFILE")"
fi
LOCAL_BIN="$USER_HOME/.local/bin"
CLAUDE_HOME="$USER_HOME/.claude"

printf '\n%sClaude workspace setup  (mode: %s)%s\n' "$CYAN" "$MODE" "$RESET"
printf '%sWorkspace: %s%s\n' "$GRAY" "$ROOT" "$RESET"

if [ ! -f "$ROOT/tools/install-library.mjs" ]; then
  fail "This does not look like the workspace root (tools/install-library.mjs is missing)."
  exit 1
fi

# ------------------------------------------------------------------ checks

section "Prerequisites"

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version 2>/dev/null || true)"
  MAJOR="${NODE_VERSION#v}"
  MAJOR="${MAJOR%%.*}"
  case "$MAJOR" in ''|*[!0-9]*) MAJOR=0 ;; esac
  if [ "$MAJOR" -ge 20 ]; then
    NODE_OK=1
    ok "Node.js $NODE_VERSION"
  else
    fail "Node.js $NODE_VERSION is too old; the workspace tools need Node 20 or newer."
    next_step "Install Node.js 20 or newer (https://nodejs.org), then run setup again."
  fi
else
  fail "Node.js not found. The workspace tools (tools/*.mjs) and hooks need Node 20 or newer."
  next_step "Install Node.js 20 or newer (https://nodejs.org), then run setup again."
fi

GIT_OK=0
if command -v git >/dev/null 2>&1; then
  GIT_OK=1
  ok "$(git --version 2>/dev/null || echo git)"
else
  warn "git not found. Install git for version control."
fi

if [ "$IS_WIN" = 1 ]; then
  BASH_PATH=""
  if [ -n "${CLAUDE_CODE_GIT_BASH_PATH:-}" ]; then
    BASH_PATH="$CLAUDE_CODE_GIT_BASH_PATH"
  elif command -v cygpath >/dev/null 2>&1; then
    # Prefer <Git>\bin\bash.exe, the path Claude Code's CLAUDE_CODE_GIT_BASH_PATH examples use.
    GIT_WIN_ROOT="$(cygpath -w / 2>/dev/null || true)"
    GIT_WIN_ROOT="${GIT_WIN_ROOT%\\}"
    if [ -n "$GIT_WIN_ROOT" ] && [ -f "$GIT_WIN_ROOT\\bin\\bash.exe" ]; then
      BASH_PATH="$GIT_WIN_ROOT\\bin\\bash.exe"
    else
      BASH_PATH="$(cygpath -w "$(command -v bash)" 2>/dev/null || true)"
    fi
  fi
  if [ -n "$BASH_PATH" ]; then
    ok "Git Bash: $BASH_PATH"
  else
    warn "Could not locate Git Bash. Claude Code then runs shell commands through its PowerShell tool."
  fi
else
  info "Git Bash: not needed on this OS."
fi

CLAUDE_EXE=""
if [ -x "$LOCAL_BIN/claude" ]; then CLAUDE_EXE="$LOCAL_BIN/claude"; fi
if [ -f "$LOCAL_BIN/claude.exe" ]; then CLAUDE_EXE="$LOCAL_BIN/claude.exe"; fi
CLAUDE_ON_PATH="$(command -v claude 2>/dev/null || true)"
if [ -n "$CLAUDE_ON_PATH" ]; then
  CLAUDE_VERSION="$(claude --version 2>/dev/null | head -n 1 || true)"
  ok "claude $CLAUDE_VERSION  ($CLAUDE_ON_PATH)"
elif [ -n "$CLAUDE_EXE" ]; then
  CLAUDE_VERSION="$("$CLAUDE_EXE" --version 2>/dev/null | head -n 1 || true)"
  warn "claude $CLAUDE_VERSION is installed at $CLAUDE_EXE but is not on PATH in this shell."
else
  fail "claude (Claude Code) not found."
  if [ "$IS_WIN" = 1 ]; then
    info "Install it from PowerShell:  irm https://claude.ai/install.ps1 | iex"
    next_step "Install Claude Code (PowerShell: irm https://claude.ai/install.ps1 | iex), then open a new terminal."
  else
    info "See https://code.claude.com/docs for the install command for your OS."
    next_step "Install Claude Code (https://code.claude.com/docs), then open a new terminal."
  fi
fi

PATH_HAS_BIN=0
OLD_IFS="$IFS"; IFS=':'
for p in $PATH; do
  if [ "${p%/}" = "$LOCAL_BIN" ]; then PATH_HAS_BIN=1; fi
done
IFS="$OLD_IFS"
# On Windows, also read the persistent USER PATH (read-only) to tell "not set" from "terminal is older".
USER_PATH_HAS_BIN=0
if [ "$IS_WIN" = 1 ] && command -v powershell.exe >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
  WIN_BIN="$(cygpath -w "$LOCAL_BIN" | tr '[:upper:]' '[:lower:]')"
  USER_PATH="$(powershell.exe -NoProfile -NonInteractive -Command "[Environment]::GetEnvironmentVariable('Path','User')" 2>/dev/null | tr -d '\r' || true)"
  OLD_IFS="$IFS"; IFS=';'
  for p in $USER_PATH; do
    p="$(printf '%s' "$p" | sed -e 's/^"//' -e 's/"$//' -e 's/\\$//' -e "s/%USERPROFILE%/$(cygpath -w "$USER_HOME" | sed 's/[\\&/]/\\&/g')/I" | tr '[:upper:]' '[:lower:]')"
    if [ "$p" = "$WIN_BIN" ]; then USER_PATH_HAS_BIN=1; fi
  done
  IFS="$OLD_IFS"
fi

if [ "$PATH_HAS_BIN" = 1 ]; then
  ok "~/.local/bin is on PATH"
elif [ "$USER_PATH_HAS_BIN" = 1 ]; then
  ok "%USERPROFILE%\\.local\\bin is in your user PATH"
  info "This shell started before it was added; open a new terminal to pick it up."
  next_step "Open a new terminal: your user PATH already has .local\\bin, this shell just started earlier."
elif [ -n "$CLAUDE_ON_PATH" ] && [ "${CLAUDE_ON_PATH#"$LOCAL_BIN"/}" = "$CLAUDE_ON_PATH" ]; then
  info "~/.local/bin is not on PATH; not needed, claude runs from $CLAUDE_ON_PATH."
else
  warn "~/.local/bin is not on PATH (the native installer puts claude there)."
  if [ "$IS_WIN" = 1 ]; then
    next_step "Add .local\\bin to your user PATH from PowerShell: powershell -NoProfile -ExecutionPolicy Bypass -File .\\Setup.ps1 -Mode Install -FixPath, then open a new terminal."
  else
    next_step "Add ~/.local/bin to PATH in your shell profile, for example: export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
fi

# ------------------------------------------------------------------ library

# Prints current | outdated | missing for one library item.
item_state() {
  local src="$1" dst="$2" f rel
  if [ ! -e "$dst" ]; then echo missing; return 0; fi
  if [ -f "$src" ]; then
    if cmp -s "$src" "$dst"; then echo current; else echo outdated; fi
    return 0
  fi
  while IFS= read -r -d '' f; do
    rel="${f#"$src"/}"
    if ! cmp -s "$f" "$dst/$rel"; then echo outdated; return 0; fi
  done < <(find "$src" -type f -print0)
  echo current
}

section "Global library (~/.claude)"
report_kind() {
  local kind="$1" name state missing="" outdated="" current="" item
  for item in "$ROOT/library/$kind"/*; do
    [ -e "$item" ] || continue
    name="$(basename "$item")"
    if [ "$kind" = skills ] && [ ! -d "$item" ]; then continue; fi
    if [ "$kind" = agents ]; then
      case "$name" in README.md) continue ;; *.md) ;; *) continue ;; esac
    fi
    state="$(item_state "$item" "$CLAUDE_HOME/$kind/$name")"
    name="${name%.md}"
    case "$state" in
      missing) missing="$missing $name" ;;
      outdated) outdated="$outdated $name" ;;
      *) current="$current $name" ;;
    esac
  done
  if [ -z "$missing$outdated" ]; then
    if [ -n "$current" ]; then ok "$kind: all installed and up to date:$current"; else info "library/$kind is empty"; fi
  elif [ "$MODE" = install ]; then
    # install mode copies them in a moment, so this is not a warning yet.
    if [ -n "$missing" ]; then info "$kind not installed yet (installed below):$missing"; fi
    if [ -n "$outdated" ]; then info "$kind differ from library/ (replaced below, old version backed up):$outdated"; fi
  else
    if [ -n "$missing" ]; then warn "$kind not installed:$missing"; fi
    if [ -n "$outdated" ]; then warn "$kind differ from library/ (install replaces them and keeps a backup):$outdated"; fi
    next_step "Set up (installs the library, builds the navigator): bash setup.sh install"
  fi
}
report_kind skills
report_kind agents

section "Workspace"
IS_REPO=0
if [ -e "$ROOT/.git" ]; then
  IS_REPO=1
  ok "The workspace is a git repository"
else
  info "Not a git repository yet (install mode offers \"git init\")."
fi
if [ -f "$ROOT/index.html" ]; then ok "index.html (navigator) exists"; else info "index.html not built yet (install mode builds it)."; fi

# ------------------------------------------------------------------ install

run_tool() {
  local script="$1"
  if [ ! -f "$ROOT/$script" ]; then
    warn "$script not found; skipped"
    return 3
  fi
  printf '\n%s> node %s%s\n' "$GRAY" "$script" "$RESET"
  node "$ROOT/$script"
}

if [ "$MODE" = install ]; then
  section "Install"
  if [ "$NODE_OK" != 1 ]; then
    fail "Skipping the workspace tools because Node.js 20+ is missing."
  else
    rc=0; run_tool tools/install-library.mjs || rc=$?
    if [ "$rc" = 0 ]; then
      ok "Library installed into ~/.claude"
    elif [ "$rc" != 3 ]; then
      fail "install-library.mjs failed (exit code $rc)"
      next_step "Fix the error above, then run: node tools/install-library.mjs"
    fi

    rc=0; run_tool tools/build-index.mjs || rc=$?
    if [ "$rc" = 0 ]; then ok "Navigator built: index.html"; elif [ "$rc" != 3 ]; then fail "build-index.mjs failed (exit code $rc)"; fi

    rc=0; run_tool tools/check-workspace.mjs || rc=$?
    if [ "$rc" = 0 ]; then
      ok "Workspace self-check passed"
    elif [ "$rc" != 3 ]; then
      warn "The workspace self-check reported errors (listed above)."
      next_step "Fix the errors from: node tools/check-workspace.mjs"
    fi
  fi

  if [ "$IS_REPO" = 0 ]; then
    if [ "$GIT_OK" != 1 ]; then
      info "git is not installed, so \"git init\" was skipped."
    elif [ ! -t 0 ]; then
      info "Not running interactively, so \"git init\" was skipped."
    else
      answer=""
      read -r -p "The workspace is not a git repository. Run \"git init\" here? (y/N) " answer || answer=""
      case "$answer" in
        y|Y|yes|YES|Yes)
          if [ "$IS_WIN" = 1 ]; then
            # core.longpaths avoids "Filename too long" errors in deep folders on Windows (this repo only).
            git -c core.longpaths=true init "$ROOT" && git -C "$ROOT" config core.longpaths true && ok "Initialized a git repository in the workspace." || fail "git init failed."
          else
            git init "$ROOT" && ok "Initialized a git repository in the workspace." || fail "git init failed."
          fi
          next_step "Make a first commit: git add -A && git commit -m \"Workspace setup\"  (check .gitignore first)"
          ;;
        *) info "Skipped git init." ;;
      esac
    fi
  fi
fi

# ------------------------------------------------------------------ summary

section "Summary"
if [ "$PROBLEMS" = 0 ] && [ "$WARNINGS" = 0 ]; then
  printf '  %sEverything looks good.%s\n' "$GREEN" "$RESET"
elif [ "$PROBLEMS" = 0 ]; then
  printf '  %s%s warning(s), no problems.%s\n' "$YELLOW" "$WARNINGS" "$RESET"
else
  printf '  %s%s problem(s), %s warning(s).%s\n' "$RED" "$PROBLEMS" "$WARNINGS" "$RESET"
fi

if [ "$MODE" = check ]; then
  next_step "Set up (installs the library, builds the navigator): bash setup.sh install"
fi
if [ "$IS_WIN" = 1 ]; then
  next_step "Start: double-click \"Start Workspace.cmd\" and pick [W] for the hub."
else
  next_step "Start: cd \"$ROOT\" && claude"
fi
next_step "First start in a folder: accept the trust dialog so the project settings (permissions) apply."
next_step "Fill in context/identity.md, preferences.md, goals.md and stack.md."

section "Next steps"
i=1
for s in ${NEXT[@]+"${NEXT[@]}"}; do
  printf '  %s. %s\n' "$i" "$s"
  i=$((i + 1))
done
echo

if [ "$PROBLEMS" -gt 0 ]; then exit 1; fi
exit 0
