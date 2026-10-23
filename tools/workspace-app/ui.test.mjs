// Tests for the page's module layout (tools/workspace-app/ui/): hash routing helpers and route
// aliases, the view registry contract, the shell markup, the pure helpers in lib.js and
// store.js (status badges, durations, intent routing), and safety rule R25 (everything renders
// as text: no HTML parsing of data, no style attributes). Checked from the source where the
// code needs a browser to run.
// Run: node tools/run-tests.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalProjectSub, hashFor, livePoll, matchRoute, parseHash, projectEntry, projectHash, projectRoute, projectSub, routeOf, setLive,
  tabsOf, upgradeRoute, viewOf, defaultSettings as pageDefaults,
} from './ui/store.js';
import { fmtAgo, fmtClock, fmtDuration, statusBadge } from './ui/lib.js';
import { routeIntent, routesForUi } from './runs/intent.mjs';
import { defaultSettings as serverDefaults } from './core/settings.mjs';

test('livePoll: when the live stream drops, an open poller pulls at once and then at its fast rate', async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  setLive(true);
  let pulls = 0;
  const stop = livePoll(async () => { pulls++; }, { ms: 40, liveMs: 60_000 });
  try {
    await sleep(20);
    assert.equal(pulls, 1, 'the first pull');
    await sleep(100);
    assert.equal(pulls, 1, 'while live, the next pull waits liveMs');
    setLive(false);
    await sleep(15);
    assert.equal(pulls, 2, 'pulled at once when the stream dropped');
    await sleep(150);
    assert.ok(pulls >= 4, `then every ms (got ${pulls})`);
  } finally { stop(); setLive(false); }
});

const uiDir = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const read = rel => readFileSync(join(uiDir, ...rel.split('/')), 'utf8');

// Every .js file under ui/, as paths relative to ui/ with forward slashes.
function uiScripts(dir = uiDir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...uiScripts(full));
    else if (name.endsWith('.js')) out.push(relative(uiDir, full).split('\\').join('/'));
  }
  return out;
}

// The source without comments, so prose may mention what the code must not do.
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('hash routes: #<route> and #<route>/<sub>, encoded both ways', () => {
  assert.deepEqual(parseHash('#flows'), { id: 'flows', sub: '' });
  assert.deepEqual(parseHash('#flows/hero-sprite'), { id: 'flows', sub: 'hero-sprite' });
  assert.deepEqual(parseHash('#projects/game-dev/findings'), { id: 'projects', sub: 'game-dev/findings' });
  assert.deepEqual(parseHash(''), { id: '', sub: '' });
  assert.deepEqual(parseHash('#flows/%E0%A4%A'), { id: 'flows', sub: '' }); // broken encoding
  assert.equal(hashFor('home'), '#home');
  assert.equal(hashFor('flows', 'a b/c'), '#flows/a%20b/c');
  assert.deepEqual(parseHash(hashFor('runs', 'x y#1')), { id: 'runs', sub: 'x y#1' });
  assert.equal(hashFor('project', 'example/findings'), '#project/example/findings');
  assert.equal(hashFor('run', '261022-104212-explain-x'), '#run/261022-104212-explain-x');
});

test('project routes: #project/<name>/<tab>[/<rest>] apart and together; a rest needs a tab', () => {
  assert.deepEqual(projectRoute('example/findings/EX-12'), { name: 'example', tab: 'findings', rest: 'EX-12' });
  assert.deepEqual(projectRoute('example/findings/a/b'), { name: 'example', tab: 'findings', rest: 'a/b' });
  assert.deepEqual(projectRoute('example'), { name: 'example', tab: '', rest: '' });
  assert.deepEqual(projectRoute(''), { name: '', tab: '', rest: '' });
  assert.deepEqual(projectRoute(undefined), { name: '', tab: '', rest: '' });
  assert.deepEqual(projectRoute('/checks/x'), { name: '', tab: '', rest: '' }, 'no name: nothing else counts');
  assert.deepEqual(projectRoute('example//x'), { name: 'example', tab: '', rest: '' }, 'no tab: no rest');
  assert.equal(projectSub('example', 'checks'), 'example/checks');
  assert.equal(projectSub('example', 'findings', 'EX-1'), 'example/findings/EX-1');
  assert.equal(projectSub('example', '', 'EX-1'), 'example', 'a rest without a tab is dropped');
  assert.equal(projectSub('', 'checks'), '');
  assert.equal(projectHash('we;ird', 'overview'), '#project/we%3Bird/overview');
  assert.deepEqual(parseHash(projectHash('we;ird', 'overview')), { id: 'project', sub: 'we;ird/overview' });
});

test('old routes still work: #cockpit/<name> is the Overview tab, #health/<name> the Architecture tab', () => {
  assert.deepEqual(parseHash('#cockpit/example'), { id: 'project', sub: 'example/overview' });
  assert.deepEqual(parseHash('#health/example'), { id: 'project', sub: 'example/architecture' });
  assert.deepEqual(parseHash('#cockpit'), { id: 'project', sub: '' }, 'no name: the current project, later');
  assert.deepEqual(parseHash('#cockpit/example/extra'), { id: 'project', sub: 'example/overview' });
  assert.equal(hashFor('cockpit', 'example'), '#project/example/overview');
  assert.equal(hashFor('health', 'example'), '#project/example/architecture');
  assert.deepEqual(upgradeRoute('runs', 'example'), { id: 'runs', sub: 'example' }, 'other routes stay as they are');
  assert.deepEqual(upgradeRoute('constructor', 'x'), { id: 'constructor', sub: 'x' }, 'no prototype lookups');
  assert.equal(viewOf('project'), 'project');
});

test('canonicalProjectSub: the state completes a project route (first tab, known tab, spelling, current project)', () => {
  const projects = [
    { name: 'example', type: { id: 'code' }, tabs: ['overview', 'tasks', 'findings', 'changes', 'checks', 'architecture', 'assets', 'settings'] },
    { name: 'notes', type: { id: 'generic' }, tabs: ['overview', 'agents', 'assets', 'settings'] },
    { name: 'Tattoo', type: { id: 'generic' } },
  ];
  assert.equal(canonicalProjectSub('example', projects), 'example/overview', 'no tab: the first tab of its type');
  assert.equal(canonicalProjectSub('example/checks', projects), 'example/checks');
  assert.equal(canonicalProjectSub('example/findings/EX-3', projects), 'example/findings/EX-3', 'the rest stays with a known tab');
  assert.equal(canonicalProjectSub('notes/checks', projects), 'notes/overview', 'a tab the type has not: the first tab');
  assert.equal(canonicalProjectSub('notes/bogus/x', projects), 'notes/overview', 'the rest goes with an unknown tab');
  assert.equal(canonicalProjectSub('EXAMPLE/checks', projects), 'example/checks', 'names match without case');
  assert.equal(canonicalProjectSub('tattoo', projects), 'Tattoo/overview', 'no tabs sent: Overview');
  assert.equal(canonicalProjectSub('ghost/checks', projects), 'ghost/checks', 'a project the state does not list stays (the page asks the server)');
  assert.equal(canonicalProjectSub('', projects, 'notes'), 'notes/overview', 'no name: the current project');
  assert.equal(canonicalProjectSub('', projects, 'gone'), '', 'a current project that is gone gives nothing');
  assert.equal(canonicalProjectSub('', projects, ''), '');
  assert.equal(canonicalProjectSub('example', null, ''), 'example', 'before the state arrives the route stays');
  assert.equal(canonicalProjectSub('', null, 'example'), '', 'and the current project waits for the state too (it may be stale)');
  for (const s of ['example', 'notes/checks', 'EXAMPLE', '', 'ghost/x']) {
    const once = canonicalProjectSub(s, projects, 'example');
    assert.equal(canonicalProjectSub(once, projects, 'example'), once, `stable: ${s}`);
  }
  assert.equal(projectEntry('Example', projects).name, 'example');
  assert.equal(projectEntry('', projects), null);
  assert.equal(projectEntry('x', null), null);
  assert.deepEqual(tabsOf(projects[1]), ['overview', 'agents', 'assets', 'settings']);
  assert.deepEqual(tabsOf({ tabs: [] }), ['overview']);
  assert.deepEqual(tabsOf(null), ['overview']);
});

test('route aliases: #library shows views/tools.js, the old #home shows Today', () => {
  assert.equal(viewOf('library'), 'tools');
  assert.equal(viewOf('home'), 'today');
  assert.equal(viewOf('runs'), 'runs');
  assert.equal(viewOf('constructor'), 'constructor'); // no prototype lookups
  assert.equal(routeOf('tools'), 'library');
  assert.equal(routeOf('today'), 'today');
  assert.equal(hashFor('tools'), '#library');
  assert.equal(hashFor('library'), '#library');
});

// View files that stay on disk but are no longer views (the old dashboard, replaced by Today).
const RETIRED_VIEWS = ['home'];

test('views: every ui/views/<id>.js is registered in main.js, says its id, and its CSS is linked', () => {
  const main = read('main.js');
  const index = read('index.html');
  const registry = main.match(/const VIEWS = \[([^\]]*)\]/)[1].split(',').map(s => s.trim()).filter(Boolean);
  const views = readdirSync(join(uiDir, 'views')).filter(n => n.endsWith('.js')).map(n => n.slice(0, -3));
  assert.deepEqual(views.filter(id => !RETIRED_VIEWS.includes(id)).sort(), [...registry].sort(),
    'VIEWS in main.js lists exactly the files in ui/views/ (apart from retired ones)');
  for (const id of views) {
    assert.match(main, new RegExp(`import ${id} from './views/${id}\\.js';`), `main.js imports views/${id}.js as ${id}`);
    const src = read(`views/${id}.js`);
    assert.match(src, /export default \{/, `${id}: default export`);
    assert.match(src, new RegExp(`\\n  id: '${id}',`), `${id}: id matches the file name`);
    for (const key of ['label', 'icon', 'render']) assert.match(src, new RegExp(`\\n  ${key}[,:]`), `${id}: ${key}`);
    // The nav icon is fixed markup: a plain string literal, never built from data.
    assert.match(src, /\n {2}icon: '[^'`$]*',\r?\n/, `${id}: icon is a plain string literal`);
  }
  for (const css of readdirSync(join(uiDir, 'css'))) {
    assert.ok(index.includes(`<link rel="stylesheet" href="/css/${css}">`), `index.html links css/${css}`);
  }
  assert.ok(existsSync(join(uiDir, 'app.css')) && index.indexOf('/app.css') < index.indexOf('/css/'), 'app.css comes first');
});

test('views: the shell registers the screens; Today replaced the old dashboard, the project page the cockpit and Health', () => {
  const main = read('main.js');
  const registry = main.match(/const VIEWS = \[([^\]]*)\]/)[1].split(',').map(s => s.trim());
  for (const id of ['today', 'project', 'launcher', 'run', 'review', 'runs', 'tools', 'projects', 'assets', 'flows', 'images']) {
    assert.ok(registry.includes(id), `${id} is in VIEWS`);
  }
  for (const id of ['home', 'cockpit', 'health']) assert.ok(!registry.includes(id), `${id} is no longer a view`);
  assert.equal(registry[0], 'today', 'Today comes first');
  // The nav's views (parts/nav.js orders them): no Dashboard, no Images, Library at the foot.
  assert.match(main, /const NAV_VIEWS = \{ today, projects, assets, flows, runs, tools \};/);
  assert.match(read('index.html'), /<nav id="nav" aria-label="Views"><\/nav>[\s\S]*<div class="side-actions">\s*(<!--[^>]*-->\s*)?<nav id="navFoot"[^>]*aria-label="[^"]+"><\/nav>/,
    'the foot nav (Library) sits in the side actions, above the Hub session buttons');
  assert.doesNotMatch(code(read('views/today.js')), /from '\.\/home\.js'/, 'Today no longer renders the old dashboard');
  for (const file of uiScripts()) {
    assert.doesNotMatch(code(read(file)), /go\('(cockpit|health)'/, `${file}: links go to the project page, not the old routes`);
  }
});

test('index.html: the shell dialogs, the live regions, and nothing the CSP would block', () => {
  const index = read('index.html');
  assert.match(index, /<dialog id="dialog" aria-labelledby="dialogTitle" aria-modal="true">/);
  assert.match(index, /<dialog id="palette" aria-label="[^"]+"/);
  assert.match(index, /<ul class="pal-list" id="palList" role="listbox"/);
  assert.match(index, /<dialog id="commitDialog" aria-labelledby="commitDialogTitle"/);
  assert.match(index, /<div id="announcer" class="sr-only" aria-live="polite"><\/div>/);
  assert.match(index, /id="livePill" hidden>Live updates paused, retrying/);
  assert.match(index, /id="themeToggle"/);
  assert.doesNotMatch(index, /\sstyle=/, 'no style attributes (CSP style-src self)');
  assert.doesNotMatch(index, /<style/, 'no inline style element');
  assert.deepEqual([...index.matchAll(/<script\b[^>]*>/g)].map(m => m[0]), ['<script type="module" src="/main.js">'], 'one module script, no inline script');
  assert.ok(read('dialog.js').includes("h('h3', { id: 'dialogTitle' }, title)"), 'the dialog title carries the labelled-by id');
});

test('R25: the page renders data as text; only icon() in lib.js parses markup, and h() never sets style', () => {
  const files = uiScripts();
  for (const want of ['main.js', 'lib.js', 'store.js', 'dialog.js', 'viewer.js', 'sprite-viewer.js', 'sprite-dialog.js', 'parts/palette.js', 'views/run.js']) {
    assert.ok(files.includes(want), `scanned ${want}`);
  }
  const parsers = /\b(innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|DOMParser|srcdoc)\b|document\.write/g;
  for (const file of files) {
    const src = code(read(file));
    const hits = [...src.matchAll(parsers)].map(m => m[0]);
    if (file === 'lib.js') {
      assert.deepEqual(hits, ['innerHTML'], 'lib.js: only icon() parses markup');
      const at = src.indexOf('innerHTML');
      const start = src.indexOf('export function icon(');
      const close = src.slice(start).match(/\r?\n\}\r?\n/);
      assert.ok(start !== -1 && close && at > start && at < start + close.index, 'lib.js: innerHTML sits inside icon()');
    } else {
      assert.deepEqual(hits, [], `${file}: no HTML parsing (use h() and text)`);
    }
    assert.doesNotMatch(src, /[{,]\s*['"]?style['"]?\s*:/, `${file}: no style prop (h() refuses it; the CSP blocks it)`);
    assert.doesNotMatch(src, /setAttribute\(\s*['"`]style['"`]/, `${file}: no style attribute`);
  }
  // h() itself refuses a style prop, so a mistake fails loudly in the browser too.
  assert.match(code(read('lib.js')), /if \(k === 'style'\) throw new Error\(/);
});

test('lib: run status badges follow the SPEC 5.1 table', () => {
  const table = {
    running: ['Running', 'blue'], waiting: ['Needs you', 'amber'], 'in-terminal': ['In terminal', 'violet'],
    passed: ['Passed', 'ok'], committed: ['Committed', 'ok'], failed: ['Failed', 'red'], 'gates-red': ['Checks red', 'red'],
    capped: ['Cap reached', 'amber'], 'paused-limit': ['Paused: usage limit', 'amber'], interrupted: ['Interrupted', 'amber'],
    parked: ['Parked', ''], cancelled: ['Cancelled', ''],
  };
  for (const [status, [label, cls]] of Object.entries(table)) assert.deepEqual(statusBadge(status), { label, cls }, status);
  assert.deepEqual(statusBadge('odd-new'), { label: 'odd-new', cls: '' });
  assert.deepEqual(statusBadge('toString'), { label: 'toString', cls: '' });
  assert.deepEqual(statusBadge(undefined), { label: 'Unknown', cls: '' });
});

test('lib: durations, clock times and "ago" texts', () => {
  assert.equal(fmtDuration(252_000), '4 m 12 s');
  assert.equal(fmtDuration(12_400), '12 s');
  assert.equal(fmtDuration(3_900_000), '1 h 05 m');
  assert.equal(fmtDuration(-1), '');
  assert.equal(fmtDuration(undefined), '');
  const now = Date.parse('2026-10-22T12:00:00Z');
  assert.equal(fmtAgo('2026-10-22T11:59:40Z', now), 'just now');
  assert.equal(fmtAgo('2026-10-22T11:55:00Z', now), '5 min ago');
  assert.equal(fmtAgo('2026-10-22T09:00:00Z', now), '3 h ago');
  assert.equal(fmtAgo('2026-10-21T12:00:00Z', now), 'yesterday');
  assert.equal(fmtAgo('2026-10-18T12:00:00Z', now), '4 days ago');
  assert.equal(fmtAgo('nonsense', now), '');
  const local = new Date(2026, 9, 22, 9, 5, 7).toISOString();
  assert.equal(fmtClock(local), '09:05');
  assert.equal(fmtClock(local, true), '09:05:07');
  assert.equal(fmtClock(''), '');
});

test('store: the page routes intent text exactly as the server does (routesForUi)', () => {
  const idPattern = '\\bF-\\d+\\b';
  const texts = ['refactor the cart totals', 'fix F-12 please', 'F-12', 'close F-3', 'why does checkout crash twice?',
    'review my branch', 'architecture cycles', 'check my work', 'add a export button', 'how do saved forms reach the database?',
    'hello there', '', '   ', 'refactor F-3 into a module', 'look over the diff'];
  for (const withId of [false, true]) {
    const routes = routesForUi(withId ? { idPattern } : {});
    for (const t of texts) {
      assert.deepEqual(matchRoute(t, routes), routeIntent(t, withId ? { idPattern } : {}), `${withId ? 'with' : 'without'} id pattern: "${t}"`);
    }
  }
  // Missing or broken rules never throw: everything goes to Explain.
  assert.deepEqual(matchRoute('refactor it', []), { pipeline: 'explain' });
  assert.deepEqual(matchRoute('refactor it', undefined), { pipeline: 'explain' });
  assert.deepEqual(matchRoute('x', [{ pattern: '(', flags: '', pipeline: 'fix' }, { pattern: 'x', flags: 'g', pipeline: 'review' }]), { pipeline: 'review' });
});

test('store: the page starts from the same settings defaults as the server', () => {
  assert.deepEqual(pageDefaults(), serverDefaults());
});
