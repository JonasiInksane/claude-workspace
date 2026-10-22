// Tests for the command building in tools/workspace-app/launch.mjs and the launch settings in
// tools/lib/prompt-file.mjs (session ids, resume, settings files). No terminals or windows open:
// realActions gets a recording runner, and no claude is ever started. Only the runTool tests
// start a process (a tiny Node script in a temp folder).
// Run: node tools/run-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  encodePs, explorerArgs, psCommand, psq, realActions, recordSession, SESSION_KINDS, sessionLaunch, sessionsFile, terminalCommand,
  wtArg, wtPath,
} from './launch.mjs';
import { checkLaunch, launchArgs, mergeSettings, promptSessionArgs, takePromptFile, UUID_RE } from '../lib/prompt-file.mjs';

const decode = b64 => Buffer.from(b64, 'base64').toString('utf16le');
const ID = '8c1e0a52-3b6d-4f0e-9a1b-2c3d4e5f6a7b';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-launch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// realActions with a runner that records instead of starting programs. `commands()` gives the
// PowerShell command of each terminal tab opened so far.
function recorded(t, extra = {}) {
  const dir = scratch(t);
  const runs = [];
  const actions = realActions({
    root: dir, tools: { wt: 'wt.exe', claude: 'C:\\bin\\claude.exe' }, dataDir: join(dir, 'data'),
    runner: async (command, args, opts) => { runs.push({ command, args, opts }); }, ...extra,
  });
  const commands = () => runs.map(r => decode(r.args[r.args.indexOf('-EncodedCommand') + 1]));
  const sessions = () => (existsSync(sessionsFile(join(dir, 'data')))
    ? readFileSync(sessionsFile(join(dir, 'data')), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
  return { dir, runs, actions, commands, sessions };
}

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

test('psCommand sets environment variables as PowerShell literals before the call, and refuses odd names', () => {
  assert.equal(
    psCommand('C:\\ws', 'C:\\node\\node.exe', ['cli.js', 'start'], { APP_VARIANT: 'development', NOTE: "it's $(x); y" }),
    "Set-Location -LiteralPath 'C:\\ws'; $env:APP_VARIANT='development'; $env:NOTE='it''s $(x); y'; & 'C:\\node\\node.exe' 'cli.js' 'start'",
  );
  assert.equal(psCommand('C:\\ws', 'p.exe', [], {}), "Set-Location -LiteralPath 'C:\\ws'; & 'p.exe'");
  for (const name of ['A B', 'X;calc', '1X', 'A$(x)', '', 'PATH:x']) {
    assert.throws(() => psCommand('C:\\ws', 'p.exe', [], { [name]: '1' }), /not an environment variable name/, name);
  }
});

test('checkLaunch takes a session id, a session to resume and a settings file, and still refuses the unsafe modes', t => {
  const dir = scratch(t);
  const settings = join(dir, 'settings.takeover.json');
  writeFileSync(settings, '{}');
  assert.deepEqual(checkLaunch({ sessionId: ID.toUpperCase() }), { error: '', launch: { sessionId: ID } });
  assert.deepEqual(checkLaunch({ resume: ID, permissionMode: 'acceptEdits', settingsFile: settings }),
    { error: '', launch: { permissionMode: 'acceptEdits', resume: ID, settingsFile: settings } });
  for (const [input, re] of [
    [{ sessionId: 'not-a-uuid' }, /sessionId must be a session id/],
    [{ resume: `${ID} --dangerously-skip-permissions` }, /resume must be a session id/],
    [{ sessionId: ID, resume: ID }, /not both/],
    [{ settingsFile: 'relative\\settings.json' }, /full path/],
    [{ settingsFile: join(dir, 'settings.txt') }, /full path/],
    [{ settingsFile: '\\\\server\\share\\s.json' }, /full path/],
    [{ settingsFile: join(dir, 'missing.json') }, /does not exist/],
    // R5: resuming or taking over never opens the unsafe modes.
    [{ resume: ID, permissionMode: 'bypassPermissions' }, /permission mode/],
    [{ resume: ID, permissionMode: 'dontAsk' }, /permission mode/],
  ]) assert.match(checkLaunch(input).error, re, JSON.stringify(input));
});

test('launchArgs: --resume or --session-id first, then mode, model, effort and --settings', () => {
  assert.deepEqual(launchArgs({ resume: ID, permissionMode: 'acceptEdits', settingsFile: 'C:\\run\\takeover.json' }),
    ['--resume', ID, '--permission-mode', 'acceptEdits', '--settings', 'C:\\run\\takeover.json']);
  assert.deepEqual(launchArgs({ sessionId: ID, permissionMode: 'plan', model: 'opus', effort: 'high', allowedTools: ['Read'] }),
    ['--session-id', ID, '--permission-mode', 'plan', '--model', 'opus', '--effort', 'high']);
  assert.deepEqual(launchArgs({}), []);
});

test('mergeSettings merges objects, keeps every list entry once, and lets the later layer win plain values', () => {
  const a = { autoMemoryEnabled: true, permissions: { allow: ['Read'], additionalDirectories: ['C:\\img'] } };
  const b = { autoMemoryEnabled: false, permissions: { allow: ['Read', 'Grep'], deny: ['Read(//c/**/.env)'] }, hooks: { PreToolUse: [] } };
  assert.deepEqual(mergeSettings(a, b), {
    autoMemoryEnabled: false,
    permissions: { allow: ['Read', 'Grep'], additionalDirectories: ['C:\\img'], deny: ['Read(//c/**/.env)'] },
    hooks: { PreToolUse: [] },
  });
  assert.deepEqual(a.permissions.allow, ['Read'], 'inputs are not changed');
  assert.deepEqual(mergeSettings(null, a, undefined), a);
});

test('promptSessionArgs: flags, one merged settings file for folders and tools, and the prompt last', t => {
  const dir = scratch(t);
  const takeover = join(dir, 'takeover.json');
  writeFileSync(takeover, JSON.stringify({ autoMemoryEnabled: false, permissions: { deny: ['Edit(//c/hub/**)'], additionalDirectories: ['C:\\run'] } }));
  const plain = promptSessionArgs({ prompt: '-rf', launch: { sessionId: ID, permissionMode: 'plan' } });
  assert.deepEqual(plain, { args: ['--session-id', ID, '--permission-mode', 'plan', '--', '-rf'], settings: null, settingsPath: '' });
  const asIs = promptSessionArgs({ prompt: 'p', launch: { settingsFile: takeover } });
  assert.deepEqual(asIs.args, ['--settings', takeover, 'p']);
  const merged = promptSessionArgs({ prompt: 'p', readDirs: ['C:\\img'], launch: { resume: ID, settingsFile: takeover, allowedTools: ['Read'] } });
  assert.deepEqual(merged.args, ['--resume', ID, '--settings', merged.settingsPath, 'p']);
  assert.deepEqual(JSON.parse(merged.settings), {
    permissions: { additionalDirectories: ['C:\\img', 'C:\\run'], allow: ['Read'], deny: ['Edit(//c/hub/**)'] },
    autoMemoryEnabled: false,
  });
  assert.match(merged.settingsPath, /read-dirs-[0-9a-f]{12}\.json$/);
  writeFileSync(takeover, '{broken');
  assert.throws(() => promptSessionArgs({ prompt: 'p', readDirs: ['C:\\img'], launch: { settingsFile: takeover } }), /could not be read/);
});

test('startClaude gives every new session an id, records it, and starts claude without a shell string', async t => {
  const { actions, runs, commands, sessions, dir } = recorded(t);
  const hub = await actions.startClaude({ dir, title: 'Workspace hub', kind: 'hub' });
  assert.match(hub.sessionId, UUID_RE);
  assert.deepEqual(runs[0].args.slice(0, 10), ['-w', '0', 'nt', '-d', dir, '--title', 'Workspace hub', 'powershell', '-NoExit', '-EncodedCommand']);
  assert.equal(commands()[0], `Set-Location -LiteralPath ${psq(dir)}; & 'C:\\bin\\claude.exe' '--session-id' '${hub.sessionId}'`);

  const project = await actions.startClaude({ dir: 'C:\\code\\example', title: 'example', project: 'example', sessionId: ID.toUpperCase() });
  assert.equal(project.sessionId, ID);
  // Continue the last session: -c, no id of its own, no record.
  const cont = await actions.startClaude({ dir, title: 'Workspace hub', continueLast: true, kind: 'hub' });
  assert.equal(cont.sessionId, '');
  assert.equal(commands()[2], `Set-Location -LiteralPath ${psq(dir)}; & 'C:\\bin\\claude.exe' '-c'`);
  const rows = sessions();
  assert.deepEqual(rows.map(r => [r.sessionId, r.kind, r.project, r.title]), [
    [hub.sessionId, 'hub', '', 'Workspace hub'],
    [ID, 'project', 'example', 'example'],
  ]);
  assert.ok(rows.every(r => !Number.isNaN(Date.parse(r.at))));
});

test('startClaude resumes for a takeover with its settings file, and refuses anything but acceptEdits or manual', async t => {
  const { actions, commands, sessions, dir } = recorded(t);
  const file = join(dir, 'settings.takeover.json');
  writeFileSync(file, '{}');
  const r = await actions.startClaude({
    dir: 'C:\\dev\\run-tree', title: 'Take over: implement', resume: ID, launch: { permissionMode: 'acceptEdits', settingsFile: file },
    kind: 'takeover', project: 'example',
  });
  assert.equal(r.sessionId, ID);
  assert.equal(commands()[0], "Set-Location -LiteralPath 'C:\\dev\\run-tree'; " +
    `& 'C:\\bin\\claude.exe' '--resume' '${ID}' '--permission-mode' 'acceptEdits' '--settings' ${psq(file)}`);
  assert.doesNotMatch(commands()[0], /--session-id/);
  assert.deepEqual(sessions().map(s => [s.sessionId, s.kind, s.project]), [[ID, 'takeover', 'example']]);
  for (const [opts, re] of [
    [{ resume: ID, launch: { permissionMode: 'plan' }, kind: 'takeover' }, /acceptEdits or manual/],
    [{ launch: { permissionMode: 'manual' }, kind: 'takeover' }, /resumes the stage's session, or starts from a prompt/],
    [{ launch: { permissionMode: 'plan' }, kind: 'takeover', prompt: 'Sum up' }, /acceptEdits or manual/],
    [{ resume: ID, launch: { permissionMode: 'bypassPermissions' } }, /permission mode/],
    [{ resume: ID, launch: { permissionMode: 'dontAsk' }, kind: 'takeover' }, /permission mode/],
    [{ resume: ID, continueLast: true }, /not both/],
    [{ resume: ID, sessionId: ID }, /not both/],
    [{ sessionId: 'x' }, /session id/],
    [{ kind: 'shell' }, /unknown session kind/],
  ]) await assert.rejects(actions.startClaude({ dir, title: 't', ...opts }), re, JSON.stringify(opts));
  assert.equal(commands().length, 1, 'nothing else started');

  // The executor's call (SPEC §3 WP11: no kind): a resume counts as a takeover and gets its check.
  const spec = await actions.startClaude({ dir: 'C:\\dev\\run-tree', title: 'Take over', resume: ID, launch: { permissionMode: 'manual', settingsFile: file } });
  assert.equal(spec.sessionId, ID);
  assert.equal(sessions()[1].kind, 'takeover');
  for (const launch of [{ permissionMode: 'plan' }, { permissionMode: 'auto' }, {}]) {
    await assert.rejects(actions.startClaude({ dir, title: 't', resume: ID, launch }), /acceptEdits or manual/, JSON.stringify(launch));
  }
  await assert.rejects(actions.startClaude({ dir, title: 't', launch: { resume: ID, permissionMode: 'plan' } }), /acceptEdits or manual/);
  // An explicit kind may resume in another mode (for example a project session picked again).
  await actions.startClaude({ dir, title: 'example', resume: ID, launch: { permissionMode: 'plan' }, kind: 'project', project: 'example' });
  // The A13 fallback: a new session (its own id) from a prompt that sums up the stage.
  const fresh = await actions.startClaude({ dir, title: 'Take over', prompt: 'Continue the stage: ...', launch: { permissionMode: 'acceptEdits' }, kind: 'takeover' });
  assert.match(fresh.sessionId, UUID_RE);
  assert.notEqual(fresh.sessionId, ID);
  assert.match(commands()[3], /claude-prompt\.mjs' '.*\.json'$/);
  takePromptFile(commands()[3].match(/'([^']*\.json)'$/)[1]); // clean up the prompt file
  assert.equal(commands().length, 4);
  assert.deepEqual(sessions().map(s => s.kind), ['takeover', 'takeover', 'project', 'takeover']);
});

test('startClaude with a prompt hands the session id over in the prompt file', async t => {
  const { actions, commands, sessions, dir } = recorded(t);
  const r = await actions.startClaude({
    dir, title: 'Flow: Refactor', prompt: 'Refactor "it"', readDirs: ['C:\\img'], launch: { permissionMode: 'plan', effort: 'high' },
    kind: 'flow', project: 'example',
  });
  const m = commands()[0].match(/^Set-Location -LiteralPath '.*'; & '(.*)' '(.*claude-prompt\.mjs)' '(.*\.json)'$/);
  assert.ok(m, commands()[0]);
  assert.equal(m[1], process.execPath);
  const handed = takePromptFile(m[3]);
  assert.deepEqual(handed, { prompt: 'Refactor "it"', readDirs: ['C:\\img'], launch: { permissionMode: 'plan', effort: 'high', sessionId: r.sessionId } });
  assert.deepEqual(sessions().map(s => [s.kind, s.project, s.title]), [['flow', 'example', 'Flow: Refactor']]);
  assert.ok(SESSION_KINDS.includes('flow'));
  await assert.rejects(realActions({ root: dir, tools: {}, runner: async () => {} }).startClaude({ dir, title: 't' }), /not found/);
});

test('startAgent passes a new session id to agent-session.mjs and records it', async t => {
  const { actions, commands, sessions, dir } = recorded(t);
  const r = await actions.startAgent({ project: 'example', agent: 'artist', title: 'example: artist' });
  assert.match(r.sessionId, UUID_RE);
  assert.ok(commands()[0].endsWith(`'example' 'artist' '--root' ${psq(dir)} '--session-id' '${r.sessionId}'`), commands()[0]);
  await actions.startAgent({ project: 'example', agent: 'artist', title: 'Flow: Art', kind: 'flow', prompt: 'p' });
  assert.match(commands()[1], /'--prompt-file' '.*\.json'$/);
  assert.deepEqual(sessions().map(s => [s.kind, s.project]), [['agent', 'example'], ['flow', 'example']]);
  await assert.rejects(actions.startAgent({ project: 'example', agent: 'artist', title: 't', sessionId: 'bad' }), /session id/);
  // The launch is checked before a terminal opens, and the prompt file gets the checked values.
  await assert.rejects(actions.startAgent({ project: 'example', agent: 'artist', title: 't', prompt: 'p', launch: { permissionMode: 'bypassPermissions' } }), /permission mode/);
  await assert.rejects(actions.startAgent({ project: 'example', agent: 'artist', title: 't', launch: { resume: ID } }), /only together with a prompt/);
  // R5: a takeover can't slip in as an agent session (its mode check lives in startClaude).
  for (const kind of ['takeover', 'hub', 'skill']) {
    await assert.rejects(actions.startAgent({ project: 'example', agent: 'artist', title: 't', prompt: 'p', kind, launch: { resume: ID, permissionMode: 'plan' } }),
      /starts as agent or flow/, kind);
  }
  assert.equal(commands().length, 2);
  const handed = takePromptFile(commands()[1].match(/'--prompt-file' '(.*\.json)'$/)[1]);
  assert.deepEqual(handed.launch, {}, 'the session id goes on the command line, not in the prompt file');
  // Resuming an agent session: no new id, the resumed one is recorded.
  const resumed = await actions.startAgent({ project: 'example', agent: 'artist', title: 'Again', prompt: 'Go on', launch: { resume: ID.toUpperCase(), permissionMode: 'plan' } });
  assert.equal(resumed.sessionId, ID);
  assert.doesNotMatch(commands()[2], /--session-id/);
  const back = takePromptFile(commands()[2].match(/'--prompt-file' '(.*\.json)'$/)[1]);
  assert.deepEqual(back.launch, { permissionMode: 'plan', resume: ID });
  assert.equal(sessions()[2].sessionId, ID);
});

test('runInTerminal runs one full-path .exe with its environment, and refuses what PowerShell would change', { skip: process.platform !== 'win32' && 'Windows paths' }, async t => {
  const { actions, commands, dir } = recorded(t);
  // A stand-in .exe: the check only needs a file there; the recording runner starts nothing.
  const exe = join(dir, 'bin', 'node.exe');
  mkdirSync(join(dir, 'bin'));
  writeFileSync(exe, '');
  await actions.runInTerminal({ dir, title: 'Web dev server', program: exe, args: ['C:\\node\\npm-cli.js', 'run', 'dev'], env: { APP_VARIANT: 'development' } });
  assert.equal(commands()[0], `Set-Location -LiteralPath ${psq(dir)}; $env:APP_VARIANT='development'; & ${psq(exe)} 'C:\\node\\npm-cli.js' 'run' 'dev'`);
  await actions.runInTerminal({ dir, title: 'Spaced', program: exe, args: ['C:\\my dir\\x.js', 'C:\\plain\\'] });
  assert.equal(commands().length, 2);
  for (const [program, re] of [
    ['C:\\x\\npm.cmd', /\.cmd or \.bat/],
    ['C:\\x\\run.BAT', /\.cmd or \.bat/],
    ['', /needs a program/],
    [undefined, /needs a program/],
    ['npm', /not a full path to an \.exe/],
    ['node.exe', /not a full path to an \.exe/],
    ['bin\\node.exe', /not a full path to an \.exe/],
    ['C:node.exe', /not a full path to an \.exe/],
    ['\\\\server\\share\\x.exe', /not a full path to an \.exe/],
    [join(dir, 'x.ps1'), /not a full path to an \.exe/],
    [join(dir, 'x.com'), /not a full path to an \.exe/],
    [join(dir, 'missing.exe'), /was not found/],
    [join(dir, 'bin'), /not a full path to an \.exe/],
  ]) assert.throws(() => actions.runInTerminal({ dir, title: 't', program }), re, String(program));
  for (const [args, re] of [
    [[''], /argument is empty/],
    [['run', ''], /argument is empty/],
    [['--filter="x"'], /double quote/],
    [['C:\\my dir\\'], /space and ends with a backslash/],
    ['run dev', /arguments as a list/],
  ]) assert.throws(() => actions.runInTerminal({ dir, title: 't', program: exe, args }), re, JSON.stringify(args));
  assert.throws(() => actions.runInTerminal({ dir, title: 't', program: exe, env: { 'A;B': '1' } }), /environment variable/);
  assert.equal(commands().length, 2, 'nothing else started');
});

test('sessionLaunch and recordSession: ids only where claude can use them; a failed record does not fail the start', async t => {
  assert.equal(sessionLaunch({ continueLast: true }).id, '');
  assert.match(sessionLaunch({}).launch.sessionId, UUID_RE);
  assert.equal(sessionLaunch({ resume: ID }).launch.sessionId, undefined);
  const dir = scratch(t);
  const notAFolder = join(dir, 'file');
  writeFileSync(notAFolder, 'x');
  const errors = t.mock.method(console, 'error', () => {});
  await recordSession(notAFolder, { sessionId: ID, kind: 'hub' });
  assert.equal(errors.mock.callCount(), 1);
  await recordSession(join(dir, 'data'), { sessionId: ID, kind: 'skill', project: 'example', title: 'x' }, new Date('2026-10-22T10:00:00Z'));
  assert.equal(readFileSync(sessionsFile(join(dir, 'data')), 'utf8'),
    '{"at":"2026-10-22T10:00:00.000Z","sessionId":"8c1e0a52-3b6d-4f0e-9a1b-2c3d4e5f6a7b","kind":"skill","project":"example","title":"x"}\n');
  // A torn last line (a crash mid-write) costs only that line: the next record starts fresh.
  const torn = join(dir, 'torn');
  mkdirSync(torn);
  writeFileSync(sessionsFile(torn), '{"at":"2026-10-22T09:00:00.000Z","sessionId":"');
  await recordSession(torn, { sessionId: ID, kind: 'hub' }, new Date('2026-10-22T10:00:00Z'));
  const lines = readFileSync(sessionsFile(torn), 'utf8').split('\n');
  assert.deepEqual(JSON.parse(lines[1]), { at: '2026-10-22T10:00:00.000Z', sessionId: ID, kind: 'hub', project: '', title: '' });
  assert.equal(lines[2], '');
});
