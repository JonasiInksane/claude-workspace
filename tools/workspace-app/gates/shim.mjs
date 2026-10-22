// The tg-check shim: a tiny sh script in a stage's run-only bin folder, so Claude's Bash tool (Git
// Bash) can run `tg-check test <path>` and the guard hook has one fixed command name to allow
// instead of every spelling of a node path. The script hands its arguments to gates/check.mjs in
// --in-stage mode, which does all the checking.
//
//   #!/bin/sh
//   exec "/c/Program Files/nodejs/node.exe" "C:/dev/.../gates/check.mjs" --in-stage "C:/.../stages/05-implement" "$@"
//
// - The program is written in Git Bash's POSIX form (/c/...), which sh resolves itself.
// - The two paths node reads are written as C:/... (forward slashes). Git Bash rewrites a /c/...
//   argument into a Windows path only when it looks safe: a backtick or a semicolon in it leaves
//   the argument as /c/..., which node would read as C:\c\... (seen on Git for Windows here). A
//   C:/... argument is never rewritten, and node reads it as it is.
// - Every path is in double quotes with $, `, \ and " escaped, so a folder name can't run anything.
// - LF line endings only: sh reads a CR as part of the last argument.
// - The file has no extension; Git Bash finds it on PATH (spike E7). It is never run through
//   cmd.exe, so there is no .cmd twin.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SHIM_NAME = 'tg-check';

// The parts of an absolute drive path: ["C", "Program Files/nodejs"]. Only drive-letter paths are
// accepted: a relative path would depend on the shell's folder, and UNC paths are not needed.
function driveParts(p) {
  const s = String(p ?? '');
  if (/[\r\n\0]/.test(s)) throw new Error('A path for the tg-check shim has a line break in it.');
  const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(s);
  if (!m) throw new Error(`${s || 'An empty path'} is not an absolute path with a drive letter.`);
  const rest = (m[2] || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  return [m[1], rest];
}

// "C:\Program Files\nodejs" -> "/c/Program Files/nodejs".
export function posixPath(p) {
  const [drive, rest] = driveParts(p);
  return `/${drive.toLowerCase()}${rest ? `/${rest}` : ''}`;
}

// "c:\dev\x" -> "C:/dev/x": a Windows path that Git Bash passes on unchanged.
export function mixedPath(p) {
  const [drive, rest] = driveParts(p);
  return `${drive.toUpperCase()}:/${rest}`;
}

// A double-quoted sh word. Inside double quotes only $, `, \ and " are special.
export function shQuote(s) {
  return `"${String(s).replace(/["\\$`]/g, '\\$&')}"`;
}

export function shimText({ nodePath, checkPath, stageDir }) {
  return `#!/bin/sh\nexec ${shQuote(posixPath(nodePath))} ${shQuote(mixedPath(checkPath))} --in-stage ${shQuote(mixedPath(stageDir))} "$@"\n`;
}

// Writes <binDir>/tg-check and returns its path. Small and synchronous on purpose: the stage
// writes it once, before Claude starts.
export function writeShim(binDir, { nodePath, checkPath, stageDir }) {
  const text = shimText({ nodePath, checkPath, stageDir });
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, SHIM_NAME);
  writeFileSync(file, text, { mode: 0o755 });
  return file;
}
