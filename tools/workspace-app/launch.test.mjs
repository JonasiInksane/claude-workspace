// Tests for the command building in tools/workspace-app/launch.mjs. No terminals or windows open;
// only the runTool test starts a process (a tiny Node script in a temp folder).
// Run: node tools/run-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodePs, explorerArgs, psCommand, psq, realActions, terminalCommand, wtArg, wtPath } from './launch.mjs';

const decode = b64 => Buffer.from(b64, 'base64').toString('utf16le');

test('psq makes PowerShell literals that nothing can break out of', () => {
  assert.equal(psq("it's"), "'it''s'");
  assert.equal(psq('$(rm -r C:\\)'), "'$(rm -r C:\\)'");
  assert.equal(psq('a; b'), "'a; b'");
  // PowerShell treats typographic quotes as single quotes too.
  assert.equal(psq('Jonas\u2019s PC'), "'Jonas\u2019\u2019s PC'");
  assert.equal(psq('\u2018x\u201Ay\u201B'), "'\u2018\u2018x\u201A\u201Ay\u201B\u201B'");
});

test('explorerArgs quotes the path so commas and spaces stay one argument', () => {
  assert.deepEqual(explorerArgs('C:\\a, b\\c'), ['"C:\\a, b\\c"']);
});

test('wt arguments escape ";" and keep paths from eating the closing quote', () => {
  assert.equal(wtArg('a;b'), 'a\\;b');
  assert.equal(wtPath('C:\\dev\\ws\\'), 'C:\\dev\\ws');
  assert.equal(wtPath('C:\\'), 'C:\\.');
  assert.equal(wtPath('C:\\x;y'), 'C:\\x\\;y');
});

test('psCommand goes to the folder and runs one quoted program', () => {
  assert.equal(
    psCommand("C:\\dev\\o'neil", 'C:\\bin\\claude.exe', ['-c']),
    "Set-Location -LiteralPath 'C:\\dev\\o''neil'; & 'C:\\bin\\claude.exe' '-c'",
  );
});

test('terminalCommand uses a Windows Terminal tab, or a new console without it', () => {
  const command = psCommand('C:\\ws', 'node.exe', ['tools\\agent-session.mjs', 'proj', 'art']);
  const wt = terminalCommand({ wt: 'wt.exe', dir: 'C:\\ws', title: 'proj: art', command });
  assert.equal(wt.command, 'wt.exe');
  assert.deepEqual(wt.args.slice(0, 7), ['-w', '0', 'nt', '-d', 'C:\\ws', '--title', 'proj: art']);
  assert.deepEqual(wt.args.slice(7, 10), ['powershell', '-NoExit', '-EncodedCommand']);
  assert.equal(decode(wt.args[10]), command);

  assert.equal(wt.hidden, false);

  // Without wt: a hidden helper runs Start-Process, which gives the session its own console.
  const plain = terminalCommand({ wt: '', dir: 'C:\\w s', title: 't', command });
  assert.equal(plain.command, 'powershell.exe');
  assert.deepEqual(plain.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(plain.hidden, true);
  assert.equal(plain.wait, true);
  const start = decode(plain.args[3]);
  assert.match(start, /^Start-Process -FilePath 'powershell\.exe' -WorkingDirectory 'C:\\w s' -ArgumentList '-NoExit','-EncodedCommand','/);
  assert.equal(decode(start.match(/'-EncodedCommand','([^']+)'/)[1]), command);
  const hiddenStart = terminalCommand({ wt: '', dir: 'C:\\ws', title: 't', command, windowStyle: 'Hidden' });
  assert.match(decode(hiddenStart.args[3]), / -WindowStyle Hidden$/);
  assert.doesNotMatch(start, /-WindowStyle/);
  assert.equal(encodePs('x'), Buffer.from('x', 'utf16le').toString('base64'));
});

test('runTool collects stdout and stderr without colour codes and keeps the exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-run-'));
  try {
    const script = join(dir, 'tool.mjs');
    writeFileSync(script, "console.log('\x1b[32mok\x1b[0m line'); console.error('bad line'); process.exit(3);\n");
    const r = await realActions({ root: dir, tools: {} }).runTool({ args: [script], cwd: dir });
    assert.equal(r.status, 3);
    assert.match(r.output, /^ok line\n/);
    assert.match(r.output, /bad line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runTool stops a hung tool together with the child that holds its output open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-run-'));
  try {
    const script = join(dir, 'hang.mjs');
    // Like run-tests: a child with inherited output that never ends.
    writeFileSync(script, "import { spawn } from 'node:child_process';\nconsole.log('started');\n" +
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });\n");
    const t0 = Date.now();
    const r = await realActions({ root: dir, tools: {} }).runTool({ args: [script], cwd: dir, timeoutMs: 1500 });
    assert.ok(Date.now() - t0 < 10_000, 'returned soon after the timeout');
    assert.match(r.output, /started[\s\S]*stopped: it ran longer than 2 seconds/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
