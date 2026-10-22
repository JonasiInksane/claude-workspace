// Tests for gates/shim.mjs: the tg-check sh script, its paths and its quoting. When Git Bash is
// installed, the script is also run through its sh.exe, the way Claude's Bash tool runs it, to see
// the exact arguments node receives, including from folders with awkward names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../test/helpers.mjs';
import { SHIM_NAME, mixedPath, posixPath, shQuote, shimText, writeShim } from './shim.mjs';

const PRINT_ARGS = fileURLToPath(new URL('../test/fixtures/check/print-args.mjs', import.meta.url));
const BS = '\\';

test('posixPath gives the Git Bash form of a drive path', () => {
  assert.equal(posixPath(`C:${BS}Program Files${BS}nodejs${BS}node.exe`), '/c/Program Files/nodejs/node.exe');
  assert.equal(posixPath('D:/dev/x/'), '/d/dev/x');
  assert.equal(posixPath(`c:${BS}`), '/c');
  assert.equal(posixPath('E:'), '/e');
  assert.equal(posixPath(`C:${BS}a${BS}${BS}b`), '/c/a/b');
});

test('mixedPath gives a C:/ path that Git Bash passes on unchanged', () => {
  assert.equal(mixedPath(`c:${BS}dev${BS}claude-workspace${BS}gates${BS}check.mjs`), 'C:/dev/claude-workspace/gates/check.mjs');
  assert.equal(mixedPath('D:/x/'), 'D:/x');
  assert.equal(mixedPath(`C:${BS}`), 'C:/');
});

test('both forms refuse relative, UNC, empty and multi-line paths', () => {
  for (const fn of [posixPath, mixedPath]) {
    assert.throws(() => fn(`relative${BS}path`), /not an absolute path with a drive letter/);
    assert.throws(() => fn(`${BS}${BS}server${BS}share${BS}x`), /not an absolute path/);
    assert.throws(() => fn(''), /An empty path/);
    assert.throws(() => fn('C:/a\nb'), /line break/);
    assert.throws(() => fn('C:/a\rb'), /line break/);
  }
});

test('shQuote escapes the characters that are special inside double quotes', () => {
  assert.equal(shQuote('plain'), '"plain"');
  assert.equal(shQuote('a b'), '"a b"');
  assert.equal(shQuote('$HOME `id` "q" \\x'), '"\\$HOME \\`id\\` \\"q\\" \\\\x"');
});

test('the shim script hands its arguments to check.mjs --in-stage', () => {
  const text = shimText({
    nodePath: `C:${BS}Program Files${BS}nodejs${BS}node.exe`,
    checkPath: `C:${BS}dev${BS}claude-workspace${BS}tools${BS}workspace-app${BS}gates${BS}check.mjs`,
    stageDir: `C:${BS}Users${BS}user${BS}AppData${BS}Local${BS}claude-workspace${BS}runs${BS}example${BS}261022-104212-refactor-x${BS}stages${BS}05-implement`,
  });
  assert.equal(text, [
    '#!/bin/sh',
    'exec "/c/Program Files/nodejs/node.exe" "C:/dev/claude-workspace/tools/workspace-app/gates/check.mjs" --in-stage '
      + '"C:/Users/user/AppData/Local/claude-workspace/runs/example/261022-104212-refactor-x/stages/05-implement" "$@"',
    '',
  ].join('\n'));
  assert.ok(!text.includes('\r'), 'LF line endings only');
});

test('a folder name with $ or a backtick cannot run anything', () => {
  const text = shimText({ nodePath: 'C:/node/node.exe', checkPath: 'C:/x/check.mjs', stageDir: 'C:/runs/$(id)`id`/05-x' });
  assert.ok(text.includes('"C:/runs/\\$(id)\\`id\\`/05-x"'), text);
});

test('writeShim writes bin/tg-check and creates the folder', t => {
  const dir = tempDir('wp4-shim-', t);
  const binDir = join(dir, 'stages', '05-implement', 'bin');
  const file = writeShim(binDir, { nodePath: 'C:/node/node.exe', checkPath: 'C:/x/check.mjs', stageDir: join(dir, 'stages', '05-implement') });
  assert.equal(file, join(binDir, SHIM_NAME));
  assert.equal(SHIM_NAME, 'tg-check');
  const text = readFileSync(file, 'utf8');
  assert.ok(text.startsWith('#!/bin/sh\nexec "/c/node/node.exe" "C:/x/check.mjs" --in-stage "'), text);
  assert.ok(text.endsWith('" "$@"\n'));
});

// Git Bash's sh.exe, when it is installed in the usual place.
function gitSh() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean);
  for (const r of roots) {
    for (const rel of ['Git\\bin\\sh.exe', 'Git\\usr\\bin\\sh.exe']) {
      const p = join(r, rel);
      if (existsSync(p)) return p;
    }
  }
  return '';
}

function run(program, args, opts = {}) {
  return new Promise(res => {
    execFile(program, args, { windowsHide: true, timeout: 30_000, ...opts }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr }));
  });
}

const noGitBash = process.platform !== 'win32' || !gitSh() ? 'needs Git Bash on Windows' : false;

test('Git Bash runs the shim and node gets every argument intact', { skip: noGitBash }, async t => {
  // tempDir keeps only safe characters, so the awkward ones go in a folder inside it. A backtick
  // or a semicolon stops Git Bash from rewriting a /c/... argument, which is why the shim passes
  // C:/... paths to node.
  const dir = join(tempDir('wp4-shim-', t), 'run $HOME `id`; & (x)');
  const stageDir = join(dir, 'stages', '05-implement');
  mkdirSync(stageDir, { recursive: true });
  const script = join(dir, 'print-args.mjs');
  copyFileSync(PRINT_ARGS, script);
  const file = writeShim(join(stageDir, 'bin'), { nodePath: process.execPath, checkPath: script, stageDir });
  const r = await run(gitSh(), [file, 'test', 'apps/api/src/a b.test.mjs', 'x$y', '--flag=1']);
  assert.equal(r.code, 0, r.stderr);
  const args = JSON.parse(r.stdout.trim());
  assert.equal(args[0], '--in-stage');
  assert.equal(resolve(args[1]).toLowerCase(), resolve(stageDir).toLowerCase());
  assert.deepEqual(args.slice(2), ['test', 'apps/api/src/a b.test.mjs', 'x$y', '--flag=1']);
});
