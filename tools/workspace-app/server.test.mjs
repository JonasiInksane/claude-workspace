// Tests for tools/workspace-app/server.mjs as a real process: one app per workspace, stale
// state files, idle shutdown. Each test gets its own TEMP folder, so the real state files in
// %TEMP%\claude-workspace are never touched, and --no-open keeps windows from opening.
// Run: node --test "tools/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { request } from 'node:http';

const serverJs = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');
const tagOf = root => createHash('sha1').update(resolve(root).toLowerCase()).digest('hex').slice(0, 8);

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'ws-server-'));
  const procs = [];
  t.after(() => {
    for (const p of procs) if (p.exitCode === null) p.kill();
    rmSync(base, { recursive: true, force: true });
  });
  const temp = join(base, 'temp');
  mkdirSync(temp);
  const makeRoot = name => { const r = join(base, name); mkdirSync(join(r, 'projects'), { recursive: true }); return r; };
  const stateFile = root => join(temp, 'claude-workspace', `app-${tagOf(root)}.json`);
  // Starts server.mjs; resolves with { proc, link, reused } once it prints its link.
  const start = (root, args = []) => new Promise((resolveP, reject) => {
    const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp };
    const proc = spawn(process.execPath, [serverJs, '--root', root, '--no-open', '--port', '0', ...args], { env });
    procs.push(proc);
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no link printed: ${out}`)), 10_000);
    proc.stdout.on('data', d => {
      out += d;
      const m = out.match(/(already running|Sign-in link)[^:]*: (http:\/\/127\.0\.0\.1:(\d+)\/\?t=[\w-]+)/);
      if (m) { clearTimeout(timer); resolveP({ proc, link: m[2], port: Number(m[3]), reused: m[1] === 'already running' }); }
    });
    proc.stderr.on('data', d => { out += d; });
  });
  return { makeRoot, start, stateFile, procs };
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
