// Tests for the page's routing in main.js, loaded whole in a stand-in DOM (test/dom.mjs) with the
// shell elements of index.html and a browser-like address: setting location.hash adds a history
// entry and fires hashchange a moment later (only when the hash changes), history.back() fires it
// when the address it goes back to differs, and replaceState changes the entry quietly. The
// project view's hooks are wrapped, so a test sees when main.js hides, renders and shows it.
// Covered: a start at #project/<name> before the state arrives (completed in place by render()
// through show() without moving the focus), the order hide, render, show, a tab click and Back,
// the nav entry and g p of the project on show, a bare #health, and unsaved work (mayLeave) on
// Back and on a tab. The tests run in order on one page, as one visit: each starts where the one
// before ended.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEvent, fakeFetch, installDom, settle } from '../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());

// The address and the history, as a browser keeps them.
const entries = ['#project/example'];
let index = 0;
const hashchange = () => setTimeout(() => dom.window.dispatchEvent(fakeEvent('hashchange', { bubbles: false })), 0);
const browserLocation = {
  get hash() { return entries[index]; },
  set hash(v) {
    const next = String(v).startsWith('#') ? String(v) : `#${v}`;
    if (next === entries[index]) return;
    entries.splice(index + 1, Infinity, next);
    index++;
    hashchange();
  },
};
const browserHistory = {
  get length() { return entries.length; },
  replaceState(_, __, url) { entries[index] = String(url); },
  back() {
    if (index === 0) return;
    const from = entries[index];
    index--;
    if (entries[index] !== from) hashchange();
  },
};
Object.defineProperty(globalThis, 'location', { value: browserLocation, configurable: true, writable: true });
Object.defineProperty(globalThis, 'history', { value: browserHistory, configurable: true, writable: true });
const back = async () => { browserHistory.back(); await settle(5); };

// The shell elements main.js and the palette look up (index.html).
const doc = dom.document;
const add = (tag, id, parent = doc.body) => {
  const el = doc.createElement(tag);
  if (id) el.id = id;
  parent.append(el);
  return el;
};
add('main');
for (const id of ['nav', 'navFoot']) add('nav', id);
for (const id of ['rootPath', 'sideDate', 'toolsInfo', 'themeText', 'livePill', 'flash']) add('span', id);
for (const id of ['startHub', 'continueHub', 'openNavigator', 'themeToggle', 'startSomething']) add('button', id);
add('summary', '', add('details', 'hubMenu'));
const palette = add('dialog', 'palette');
add('input', 'palInput', palette);
add('ul', 'palList', palette);
add('dialog', 'commitDialog');

// GET /api/state answers only when a test lets it, so the page starts without the state.
let giveState;
const stateGiven = new Promise(r => { giveState = r; });
const example = {
  name: 'example', profileLabel: 'Example', type: { id: 'code', label: 'Code project' }, hasProfile: true, launchable: true,
  tabs: ['overview', 'tasks', 'checks', 'architecture', 'settings'], realPath: 'C:\\ws\\projects\\example', agents: [], archived: [],
};
const STATE = { root: 'C:\\ws', today: '2026-10-23', tools: { claude: true, editor: '' }, repos: { list: [] }, assets: [], flows: [], catalog: { skills: [] }, projects: [example] };
fakeFetch(async path => {
  if (path === '/api/state') { await stateGiven; return STATE; }
  return { ok: true };
});

// What main.js asks of the project view, in order: 'hide', 'render:<sub>', 'show:<sub>'.
const { default: projectView } = await import('./views/project.js');
const calls = [];
for (const hook of ['render', 'onShow', 'onHide']) {
  const real = projectView[hook];
  projectView[hook] = function (...args) {
    calls.push(hook === 'onHide' ? 'hide' : `${hook === 'render' ? 'render' : 'show'}:${args[hook === 'render' ? 1 : 0].sub}`);
    return real.apply(this, args);
  };
}
const since = mark => calls.slice(mark).filter((c, i, list) => !(c.startsWith('render:') && list[i - 1] === c));

const store = await import('./store.js');
await import('./main.js');
const section = doc.getElementById('view-project');
const tab = id => section.querySelector(`#ptab-${id}`);
const navEntry = key => doc.querySelector(`#nav [data-key="${key}"]`);

test('the page starts at #project/example before the state is there, and completes the route once it is', async () => {
  assert.equal(store.view, 'project');
  assert.equal(browserLocation.hash, '#project/example', 'without the state the route stays as it is');
  await settle(5);
  assert.deepEqual(calls, ['show:example'], 'shown at once; nothing to render without the state');
  giveState();
  await settle(20);
  assert.equal(browserLocation.hash, '#project/example/overview');
  assert.deepEqual(entries, ['#project/example/overview'], 'corrected in place: no new history entry');
  // render() sends the incomplete route through show(): the old route hides, then the new one
  // renders and shows. The incomplete route itself is never rendered.
  assert.deepEqual(since(1).slice(0, 3), ['hide', 'render:example/overview', 'show:example/overview']);
  assert.ok(!calls.includes('render:example'));
  assert.equal(doc.activeElement, doc.body, 'a corrected route moves no focus (focus: false)');
});

test('the nav entry of the project on show, and g p, add no history entry; Back leaves the page at once', async () => {
  dom.click(navEntry('today'));
  await settle(5);
  assert.equal(store.view, 'today');
  dom.click(navEntry('project/example'));
  await settle(5);
  assert.equal(browserLocation.hash, '#project/example/overview');
  assert.equal(entries.length, 3);
  const mark = calls.length;
  dom.click(navEntry('project/example'));
  await settle(5);
  dom.key(doc, 'g');
  dom.key(doc, 'p');
  await settle(5);
  assert.deepEqual(entries, ['#project/example/overview', '#today', '#project/example/overview'], 'the same address: no new entry');
  assert.ok(!since(mark).includes('hide'), 'the page stays as it is');
  await back();
  assert.equal(store.view, 'today', 'the first Back goes back');
  dom.click(navEntry('project/example'));
  await settle(5);
});

test('a bare #health (an old link) opens the current project\'s Architecture tab, not its Overview', async () => {
  browserLocation.hash = '#health';
  await settle(5);
  assert.equal(browserLocation.hash, '#project/example/architecture');
  assert.equal(store.sub, 'example/architecture');
  assert.equal(tab('architecture').getAttribute('aria-selected'), 'true');
});

test('a tab click is a new history entry (hide, render, show) with the focus on the tab; Back puts it on the heading', async () => {
  const mark = calls.length;
  dom.click(tab('checks'));
  await settle(5);
  assert.equal(browserLocation.hash, '#project/example/checks');
  assert.deepEqual(entries.slice(-2), ['#project/example/architecture', '#project/example/checks']);
  assert.deepEqual(since(mark).slice(0, 3), ['hide', 'render:example/checks', 'show:example/checks']);
  assert.equal(doc.activeElement, tab('checks'), 'the tab that was clicked keeps the focus');
  await back();
  assert.equal(store.sub, 'example/architecture');
  assert.equal(tab('architecture').getAttribute('aria-selected'), 'true');
  assert.equal(doc.activeElement.tagName, 'H2', 'after Back the heading has the focus');
});

test('unsaved work: Cancel keeps the screen for Back and for a tab, and nothing takes the focus later', async () => {
  const { clearLeaveGuard, setLeaveGuard } = await import('./parts/leave-guard.js');
  let asked = 0;
  dom.window.confirm = () => { asked++; return false; };
  setLeaveGuard({ hash: '#project/example/architecture', dirty: () => true, message: 'Discard your changes?' });
  const mark = calls.length;
  try {
    await back();
    assert.equal(asked, 1, 'Back asks first');
    assert.equal(browserLocation.hash, '#project/example/architecture', 'Cancel puts the address back');
    dom.click(tab('overview'));
    await settle(5);
    assert.equal(asked, 2, 'a tab asks too');
    assert.equal(browserLocation.hash, '#project/example/architecture');
    assert.equal(store.sub, 'example/architecture');
    assert.deepEqual(since(mark).filter(c => !c.startsWith('render:')), [], 'the screen was never hidden or shown again');
  } finally {
    clearLeaveGuard();
    delete dom.window.confirm;
  }
  // Later, the Overview opened another way (the palette): the heading takes the focus, not the tab
  // whose click was cancelled.
  store.go('project', 'example/overview');
  await settle(5);
  assert.equal(store.sub, 'example/overview');
  assert.equal(doc.activeElement.tagName, 'H2');
});
