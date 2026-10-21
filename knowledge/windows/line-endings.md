---
title: Line endings with Git Bash tools
tags: [windows, git, git-bash, sed, crlf, line-endings]
updated: 2026-10-21
---

# Line endings with Git Bash tools

TL;DR: Working copies here are CRLF, and Git Bash's `sed -i` silently rewrites a CRLF file to
LF. Use `sed -i -b` (keeps CRLF), the Edit tool, or a Node script; to repair, convert back
with the Node one-liner below.

## Details
- Git settings on this machine: `core.autocrlf=true` (from `C:\Program Files\Git\etc\gitconfig`)
  and the hub's `.gitattributes` (`* text=auto`, `*.sh` LF, `*.ps1` / `*.cmd` / `*.bat` CRLF).
  So files are LF in the repo and CRLF in the working copy.
- `sed -i 's/a/x/' file` (GNU sed 4.9 in Git for Windows 2.45.2) writes the file back with LF.
  `sed -i -b ...` (binary mode) keeps the CRLF.
- Git hides the damage: `git diff` shows only the real change, plus
  `warning: in the working copy of '<file>', LF will be replaced by CRLF the next time Git touches it`.
  The working copy is now mixed until the next checkout.
- That warning after a `sed`, `awk` or heredoc edit is the sign. Check a file with
  `file <path>` in Git Bash ("with CRLF line terminators" or not).
- Heredocs (`cat >> file <<'EOF'`) append LF lines to a CRLF file, which gives mixed endings.

## Example
Find the edited files that lost their CRLF, and restore it (Node, any shell):

```powershell
node -e "const fs=require('fs');const {execSync}=require('child_process');for(const f of execSync('git status --short --untracked-files=all',{encoding:'utf8'}).split('\n').filter(Boolean).map(l=>l.slice(3)).filter(f=>/\.(md|mjs|js|css|html|json)$/.test(f)&&fs.existsSync(f))){const t=fs.readFileSync(f,'utf8');const x=t.replace(/\r?\n/g,'\r\n');if(x!==t){fs.writeFileSync(f,x);console.log('CRLF:',f)}}"
```

Leave `*.sh` files out of a conversion like this: they must stay LF.

## Source
- Found while building the workspace app on 2026-10-21: `sed -i` on test files turned them LF.
  Both `sed -i` (LF) and `sed -i -b` (CRLF kept) were reproduced on a scratch file that day.
