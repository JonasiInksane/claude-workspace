// Screenshots of the workspace app for UI work. Starts the app with the fake Claude and a
// throw-away data folder (or opens a running app with --url), drives headless Edge through the
// DevTools protocol, and saves one PNG per route. It also prints every console error, CSP
// violation and uncaught exception the page logged, so a broken screen can't pass unnoticed.
// No dependencies; needs Node 22+ (global WebSocket) and Microsoft Edge.
//
//   node tools/workspace-app/test/shots.mjs --out <dir> [--routes today,projects,runs]
//        [--theme light|dark|both] [--width 1400] [--height 900] [--full]
//        [--example [--seed <file.mjs>]] [--fixtures] [--data-dir <dir>] [--url <sign-in link>] [--wait 900]
//
// - A route is a hash route ("cockpit/example" becomes #cockpit/example) or, when it starts
//   with "/", a path on the app's origin.
// - --example runs the app in-process on a temporary workspace (like test/e2e.test.mjs): a copy
//   of pipelines/app and flows/, the synthetic "example" project (a git repo matching
//   pipelines/app/profiles/example.json) at projects/example, its profile and the sample runs in
//   a temporary data folder, plus "sample-art" (an asset pipeline with one asset) and "notes"
//   (a plain project). Use it to see every kind of project screen; nothing real is touched.
// - --seed <file.mjs> (with --example): a module whose default export, async ({ root, dataDir }),
//   runs before the app starts, to add data the screens show (library assets, settings versions).
//   test/seed-library.mjs seeds the asset library and two settings versions of "example".
// - --fixtures loads the sample runs (test/fixtures/runs/install.mjs) into the data folder.
// - --data-dir reuses a data folder you prepared (profiles, runs); default is a new temp folder.
// - --full captures the whole page height instead of the viewport.
// - Exit code 1 when the page logged an error or an exception, 2 on a setup failure.
//
// Imported (not run), it exports startExample, startEdge and cdp, so a script can drive the same
// page further (click, type, open dialogs) and take its own screenshots.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(here, '..', 'server.mjs');
const EDGE_PATHS = [
  join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

function parseArgs(argv) {
  const o = { out: '', routes: ['today'], theme: 'light', width: 1400, height: 900, full: false, example: false, seed: '', fixtures: false, dataDir: '', url: '', wait: 900 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i] ?? '';
    if (a === '--out') o.out = val();
    else if (a === '--routes') o.routes = val().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--theme') o.theme = val();
    else if (a === '--width') o.width = Number(val());
    else if (a === '--height') o.height = Number(val());
    else if (a === '--full') o.full = true;
    else if (a === '--example') o.example = true;
    else if (a === '--seed') o.seed = val();
    else if (a === '--fixtures') o.fixtures = true;
    else if (a === '--data-dir') o.dataDir = val();
    else if (a === '--url') o.url = val();
    else if (a === '--wait') o.wait = Number(val());
    else if (a === '-h' || a === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n')); process.exit(0); }
    else fail(`unknown argument ${a}`);
  }
  if (!o.out) fail('--out <dir> is required');
  if (!['light', 'dark', 'both'].includes(o.theme)) fail('--theme must be light, dark or both');
  if (o.seed && !o.example) fail('--seed needs --example (it seeds the temporary workspace)');
  if (o.seed && !existsSync(o.seed)) fail(`--seed: ${o.seed} was not found`);
  return o;
}

// Runs a --seed module's default export on the example workspace before the app starts.
async function runSeed(file, { root, dataDir }) {
  const mod = await import(pathToFileURL(resolve(file)).href);
  if (typeof mod.default !== 'function') fail(`--seed: ${file} has no default export function`);
  await mod.default({ root, dataDir });
}

function fail(msg) {
  console.error(`shots: ${msg}`);
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}

// Starts the app and resolves with its sign-in link.
function startServer(dataDir) {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [SERVER, '--no-open', '--data-dir', dataDir, '--fake-claude'], {
      env: { ...process.env, WS_APP_TEST: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the app did not print a sign-in link:\n${out}`)), 30_000);
    const onData = chunk => {
      out += chunk;
      const m = /Sign-in link[^:]*:\s*(http:\/\/\S+)/.exec(out) || /already running:\s*(http:\/\/\S+)/.exec(out);
      if (m) { clearTimeout(timer); resolveP({ child, url: m[1] }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`the app exited (${code}):\n${out}`)); });
  });
}

// The --example workspace: the real app (createApp) in this process on a temporary root, with
// the fake Claude for every stage, after `seed` (a --seed module's path) ran on it. Resolves with
// the sign-in link, the workspace root and a stop function.
export async function startExample(dataDir, { seed = '' } = {}) {
  const { createServer } = await import('node:http');
  const { cpSync } = await import('node:fs');
  const { createApp } = await import('../app.mjs');
  const { exampleRepoFiles, fakeProfile, makeRepo, writeFiles } = await import('./helpers.mjs');
  const { installRunFixtures } = await import('./fixtures/runs/install.mjs');
  const hub = resolve(here, '..', '..', '..');
  const base = mkdtempSync(join(tmpdir(), 'ws-shots-root-'));
  const root = join(base, 'ws');
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  cpSync(join(hub, 'pipelines', 'app'), join(root, 'pipelines', 'app'), { recursive: true });
  if (existsSync(join(hub, 'flows'))) cpSync(join(hub, 'flows'), join(root, 'flows'), { recursive: true });
  await makeRepo(join(root, 'projects', 'example'), { files: exampleRepoFiles() });
  // An asset-pipeline project (tools/asset.mjs plus assets/, like game-dev) with one asset, and a
  // plain project with only a CLAUDE.md, so every project type has something to show.
  writeFiles(join(root, 'projects', 'sample-art'), {
    'CLAUDE.md': '# Sample art\n\nA synthetic asset pipeline for screenshots.\n',
    'tools/asset.mjs': '// stub\n',
    'assets/lowpoly/props/Crate/asset.json': { name: 'Crate', category: 'props', style: 'lowpoly', status: 'review', source: 'procedural' },
    'assets/lowpoly/props/Crate/brief.md': '# Crate\n\nA wooden crate.\n',
  });
  writeFiles(join(root, 'projects', 'notes'), { 'CLAUDE.md': '# Notes\n\nA plain project.\n' });
  // A short worktree path (the profile allows at most 50 characters); it is never created here.
  writeFiles(dataDir, { 'profiles/example.json': fakeProfile({ isolation: { worktreePath: join(tmpdir(), 'ws-shots-run') } }) });
  await installRunFixtures(dataDir);
  if (seed) await runSeed(seed, { root, dataDir });
  const token = 'shots'.padEnd(32, '0');
  const fake = resolve(here, 'fake-claude.mjs');
  const noop = async () => ({});
  let port = 0;
  const app = createApp({
    root, token, dataDir, getPort: () => port,
    actions: { tools: { wt: '', claude: '', edge: '', editor: null }, startClaude: noop, runTool: noop },
    engineOptions: { claudeCommand: () => [process.execPath, fake, '--fixture', 'auto', '--delay-ms', '1'] },
  });
  const server = createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const stop = async () => {
    try { await (await app.getEngine()).shutdown(); } catch { /* engine never started */ }
    await new Promise(r => server.close(r));
    server.closeAllConnections?.();
    try { rmSync(base, { recursive: true, force: true }); } catch { /* a file may still be open */ }
  };
  return { url: `http://127.0.0.1:${port}/?t=${token}`, root, stop };
}

// Headless Edge with a DevTools port: { child, profile, ws } (the page target's WebSocket URL).
export async function startEdge(o) {
  const edge = EDGE_PATHS.find(p => existsSync(p));
  if (!edge) fail('Microsoft Edge was not found');
  const profile = mkdtempSync(join(tmpdir(), 'ws-shots-edge-'));
  const child = spawn(edge, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${o.width},${o.height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) { killTree(child); fail('Edge did not open its DevTools port'); }
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === 'page');
    } catch { /* not ready */ }
    if (!target) await sleep(100);
  }
  if (!target) { killTree(child); fail('Edge has no page to drive'); }
  return { child, profile, ws: target.webSocketDebuggerUrl };
}

// A minimal DevTools protocol client: send() resolves with the result; on() listens to events.
export function cdp(wsUrl) {
  return new Promise((resolveP, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.onopen = () => resolveP({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const n = ++id;
          pending.set(n, { res, rej, method });
          ws.send(JSON.stringify({ id: n, method, params }));
        });
      },
      on(method, fn) { listeners.set(method, [...(listeners.get(method) || []), fn]); },
      once(method, timeoutMs = 15_000) {
        return new Promise(res => {
          const t = setTimeout(() => res(null), timeoutMs);
          const fn = p => { clearTimeout(t); listeners.set(method, (listeners.get(method) || []).filter(f => f !== fn)); res(p); };
          this.on(method, fn);
        });
      },
      close() { ws.close(); },
    });
    ws.onerror = e => reject(new Error(`DevTools connection failed: ${e.message || e.type}`));
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`));
        else p.res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners.get(msg.method) || []) fn(msg.params);
      }
    };
  });
}

const fileName = (route, theme) => `${route.replace(/^[#/]+/, '').replace(/[^\w.-]+/g, '_') || 'root'}-${theme}.png`;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  let server = null;
  let example = null;
  let tempData = '';
  let url = o.url;
  if (!url) {
    const dataDir = o.dataDir || (tempData = mkdtempSync(join(tmpdir(), 'ws-shots-data-')));
    if (o.example) {
      example = await startExample(dataDir, { seed: o.seed });
      url = example.url;
    } else {
      if (o.fixtures) {
        const { installRunFixtures } = await import('./fixtures/runs/install.mjs');
        await installRunFixtures(dataDir);
      }
      ({ child: server, url } = await startServer(dataDir));
    }
  }
  const origin = new URL(url).origin;
  const edge = await startEdge(o);
  const problems = [];
  try {
    const page = await cdp(edge.ws);
    page.on('Runtime.consoleAPICalled', p => {
      if (p.type === 'error' || p.type === 'assert') problems.push(`console.${p.type}: ${p.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
    });
    page.on('Runtime.exceptionThrown', p => problems.push(`exception: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`));
    page.on('Log.entryAdded', p => { if (p.entry.level === 'error') problems.push(`log (${p.entry.source}): ${p.entry.text}${p.entry.url ? ` ${p.entry.url}` : ''}`); });
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: 1, mobile: false });
    const load = page.once('Page.loadEventFired');
    await page.send('Page.navigate', { url });
    await load;
    await sleep(o.wait);
    const themes = o.theme === 'both' ? ['light', 'dark'] : [o.theme];
    for (const theme of themes) {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      for (const route of o.routes) {
        if (route.startsWith('/')) {
          const loaded = page.once('Page.loadEventFired');
          await page.send('Page.navigate', { url: origin + route });
          await loaded;
        } else {
          await page.send('Runtime.evaluate', { expression: `location.hash = ${JSON.stringify(`#${route.replace(/^#/, '')}`)}` });
        }
        await sleep(o.wait);
        const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: o.full });
        const file = join(o.out, fileName(route, theme));
        writeFileSync(file, Buffer.from(shot.data, 'base64'));
        console.log(file);
      }
    }
    page.close();
  } finally {
    killTree(edge.child);
    killTree(server);
    if (example) await example.stop();
    await sleep(300);
    try { rmSync(edge.profile, { recursive: true, force: true }); } catch { /* Edge may still hold a file */ }
    if (tempData) try { rmSync(tempData, { recursive: true, force: true }); } catch { /* the app may still hold a file */ }
  }
  if (problems.length) {
    console.log(`\n${problems.length} problem(s) in the page:`);
    for (const p of problems) console.log(`  ${p}`);
    process.exitCode = 1;
  }
}

// Run as a script only; a driver script imports the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(`shots: ${e.message}`); process.exit(2); });
}
