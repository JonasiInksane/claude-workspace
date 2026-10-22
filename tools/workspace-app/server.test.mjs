// Tests for tools/workspace-app/server.mjs as a real process: one app per workspace, stale
// state files, idle shutdown, and the run engine's wiring (recovery at startup, the test-only
// --fake-claude flag, idle exit skipped while a stage runs but not for waiting runs: R21). Each
// test gets its own TEMP folder and data folder, so the real state files in
// %TEMP%\claude-workspace and the real %LOCALAPPDATA%\claude-workspace are never touched, and
// --no-open keeps windows from opening.
// Run: node tools/run-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { installRunFixtures } from './test/fixtures/runs/install.mjs';
import { exampleRepoFiles, fakeProfile, makeRepo, writeFiles } from './test/helpers.mjs';

const appDir = dirname(fileURLToPath(import.meta.url));
const serverJs = join(appDir, 'server.mjs');
const tagOf = root => createHash('sha1').update(resolve(root).toLowerCase()).digest('hex').slice(0, 8);

// Stops a process and everything it started (a fake claude and its child included).
function killTree(p) {
  if (p.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(p.pid)], { windowsHide: true, stdio: 'ignore' });
  else p.kill();
}

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'ws-server-'));
  const procs = [];
  t.after(async () => {
    for (const p of procs) killTree(p);
    await Promise.all(procs.map(p => (p.exitCode !== null ? null : new Promise(r => { p.once('exit', r); setTimeout(r, 5000); }))));
    rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  });
  const temp = join(base, 'temp');
  mkdirSync(temp);
  const makeRoot = name => { const r = join(base, name); mkdirSync(join(r, 'projects'), { recursive: true }); return r; };
  const stateFile = root => join(temp, 'claude-workspace', `app-${tagOf(root)}.json`);
  // Starts server.mjs; resolves with { proc, link, reused, output() } once it prints its link.
  // Without --data-dir in `args`, the data folder is <base>/data.
  const start = (root, args = [], { env: extraEnv = {} } = {}) => new Promise((resolveP, reject) => {
    const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, ...extraEnv };
    const data = args.includes('--data-dir') ? [] : ['--data-dir', join(base, 'data')];
    const proc = spawn(process.execPath, [serverJs, '--root', root, '--no-open', '--port', '0', ...data, ...args], { env });
    procs.push(proc);
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no link printed: ${out}`)), 15_000);
    proc.stdout.on('data', d => {
      out += d;
      const m = out.match(/(already running|Sign-in link)[^:]*: (http:\/\/127\.0\.0\.1:(\d+)\/\?t=[\w-]+)/);
      if (m) { clearTimeout(timer); resolveP({ proc, link: m[2], port: Number(m[3]), reused: m[1] === 'already running', output: () => out }); }
    });
    proc.stderr.on('data', d => { out += d; });
    proc.once('exit', code => { clearTimeout(timer); reject(new Error(`exited with ${code}: ${out}`)); });
  });
  return { base, makeRoot, start, stateFile, procs };
}

const exited = proc => new Promise(r => (proc.exitCode !== null ? r(proc.exitCode) : proc.once('exit', r)));

function get(port, path, headers = {}) {
  return new Promise((resolveP, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: headers.method || 'GET', headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolveP({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a second start for the same workspace reuses the running app', async t => {
  const { makeRoot, start, stateFile } = fixture(t);
  const root = makeRoot('a');
  const first = await start(root);
  assert.equal(first.reused, false);
  assert.ok(existsSync(stateFile(root)));
  assert.equal(JSON.parse((await get(first.port, '/health')).body).workspace, tagOf(root));
  const second = await start(root);
  assert.equal(second.reused, true);
  assert.equal(second.link, first.link);
  assert.equal(await exited(second.proc), 0);
});

test('a state file pointing at another workspace\'s app is ignored', async t => {
  const { makeRoot, start, stateFile } = fixture(t);
  const a = makeRoot('a');
  const b = makeRoot('b');
  const appB = await start(b);
  mkdirSync(dirname(stateFile(a)), { recursive: true });
  writeFileSync(stateFile(a), JSON.stringify({ port: appB.port, token: 'stale', pid: 1, root: a }));
  const appA = await start(a);
  assert.equal(appA.reused, false);
  assert.notEqual(appA.port, appB.port);
  // A state file for a port nobody listens on is ignored too.
  const c = makeRoot('c');
  writeFileSync(stateFile(c), JSON.stringify({ port: 1, token: 'dead', pid: 1, root: c }));
  assert.equal((await start(c)).reused, false);
});

test('the app stops after the heartbeat stops and removes its state file', async t => {
  const { makeRoot, start, stateFile } = fixture(t);
  const root = makeRoot('a');
  const app = await start(root, ['--idle', '2']);
  const signIn = await get(app.port, new URL(app.link).pathname + new URL(app.link).search);
  assert.equal(signIn.status, 302);
  const cookie = signIn.headers['set-cookie'][0].split(';')[0];
  const ping = await get(app.port, '/api/ping', {
    method: 'POST', Cookie: cookie, Origin: `http://127.0.0.1:${app.port}`, 'X-Workspace-App': '1',
  });
  assert.equal(ping.status, 200);
  assert.equal(await exited(app.proc), 0);
  assert.ok(!existsSync(stateFile(root)));
});

test('--data-dir is accepted, and starting the app does not create the folder', async t => {
  const { makeRoot, start } = fixture(t);
  const root = makeRoot('a');
  const dataDir = join(dirname(root), 'private-data');
  const app = await start(root, ['--data-dir', dataDir]);
  assert.equal(app.reused, false);
  assert.equal((await get(app.port, '/health')).status, 200);
  assert.ok(!existsSync(dataDir), 'the run engine and its recovery create nothing either');
});

// ---------------------------------------------------------------- the run engine

// Signs in; returns a function that sends a JSON POST the way the page does.
async function signedIn(app) {
  const signIn = await get(app.port, new URL(app.link).pathname + new URL(app.link).search);
  const cookie = signIn.headers['set-cookie'][0].split(';')[0];
  const send = (method, path, body) => new Promise((resolveP, reject) => {
    const headers = { Host: `127.0.0.1:${app.port}`, Cookie: cookie };
    if (method === 'POST') Object.assign(headers, { Origin: `http://127.0.0.1:${app.port}`, 'X-Workspace-App': '1', 'Content-Type': 'application/json' });
    const req = request({ host: '127.0.0.1', port: app.port, path, method, headers }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* text */ } resolveP({ status: res.statusCode, json, text }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
  return send;
}

test('--fake-claude is refused unless WS_APP_TEST=1', async t => {
  const { makeRoot } = fixture(t);
  const root = makeRoot('a');
  const env = { ...process.env };
  delete env.WS_APP_TEST;
  const proc = spawn(process.execPath, [serverJs, '--root', root, '--no-open', '--port', '0', '--fake-claude'], { env });
  let err = '';
  proc.stderr.on('data', d => { err += d; });
  assert.equal(await exited(proc), 1);
  assert.match(err, /--fake-claude is for tests and UI work only\. Set WS_APP_TEST=1 to use it\./);
});

test('startup recovers runs before listening; waiting runs do not keep the app from its idle exit (R21)', async t => {
  const { base, makeRoot, start } = fixture(t);
  const root = makeRoot('a');
  const dataDir = join(base, 'fixture-data');
  await installRunFixtures(dataDir);
  const app = await start(root, ['--idle', '2', '--data-dir', dataDir]);
  assert.match(app.output(), /workspace-app: runs recovered: 1 interrupted/);
  const run = JSON.parse(readFileSync(join(dataDir, 'runs', 'example', '261022-100005-explain-running', 'run.json'), 'utf8'));
  assert.equal(run.status, 'interrupted', 'the run whose app is gone');
  assert.match(run.statusReason, /The app restarted while answer ran/);
  const started = Date.now();
  assert.equal(await exited(app.proc), 0, 'four runs wait for you, and the app still stops');
  assert.ok(Date.now() - started < 15_000);
});

test('a running stage keeps the app from its idle exit; once cancelled, the app stops (R21)', { timeout: 90_000 }, async t => {
  const { base, makeRoot, start } = fixture(t);
  const root = makeRoot('a');
  const dataDir = join(base, 'data');
  cpSync(join(appDir, '..', '..', 'pipelines', 'app'), join(root, 'pipelines', 'app'), { recursive: true });
  await makeRepo(join(root, 'projects', 'example'), { files: exampleRepoFiles() });
  // An Explain run never makes the run worktree; the path only has to be valid (short).
  writeFiles(dataDir, { 'profiles/example.json': fakeProfile({ isolation: { worktreePath: join(tmpdir(), 'ws-run') } }) });
  const app = await start(root, ['--idle', '3', '--fake-claude', 'hang', '--data-dir', dataDir],
    { env: { WS_APP_TEST: '1', GIT_CEILING_DIRECTORIES: tmpdir() } });
  assert.match(app.output(), /Claude stages use the fake Claude \(fixture hang\)/);
  const send = await signedIn(app);
  const r = await send('POST', '/api/runs', { project: 'example', pipeline: 'explain', values: { what: 'How do sessions work?' } });
  assert.equal(r.status, 200, r.text);
  const id = r.json.runId;
  // The stage hangs: well past the idle time, the app is still there.
  for (let i = 0; i < 70; i++) {
    const run = (await send('GET', `/api/run?id=${id}`)).json.run;
    if ((run.stages[0].attempts || []).some(a => a.proc)) break;
    await new Promise(res => setTimeout(res, 100));
  }
  await new Promise(res => setTimeout(res, 7000));
  assert.equal(app.proc.exitCode, null, 'busy: no idle exit while the stage runs');
  const cancelled = await send('POST', '/api/runs/cancel', { id });
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.json.run.status, 'cancelled');
  assert.equal(await exited(app.proc), 0, 'no longer busy, so the idle exit comes');
});
