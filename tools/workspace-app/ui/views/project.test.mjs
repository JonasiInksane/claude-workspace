// Tests for the project page (views/project.js) in a stand-in DOM (test/dom.mjs): where the arrow,
// Home and End keys move the focus, why Start Claude here is off, the header and the tab bar's
// ARIA (tablist, tabs with aria-selected, aria-controls and one Tab stop, the tabpanel labelled by
// its tab), the keys moving the focus, a click opening a tab as its own route (and keeping the
// focus on it), the type's tabs, and the pages without tabs: no project chosen, a name the server
// doesn't know, a checkout that isn't linked yet, a link whose folder is gone.
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, reply, settle, textOf } from '../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
fakeFetch(path => {
  if (path === '/api/project?name=ghost') return reply(404, { ok: false, error: 'There is no project ghost.' });
  if (path === '/api/project?name=Bad+Name') return reply(400, { ok: false, error: '"Bad Name" is not a project name.' });
  if (path === '/api/project?name=later') {
    return { ok: true, project: { name: 'later', label: 'Later', present: false }, checklist: [{ id: 'linked', ok: false, text: 'Not linked yet. Link your existing checkout.' }] };
  }
  return { ok: true, pipelines: [], routes: [], runs: [] };
});
const store = await import('../store.js');
const { PANEL_ID, startProblem, tabId, tabKeyTarget, default: page } = await import('./project.js');

const CODE_TABS = ['overview', 'tasks', 'findings', 'changes', 'checks', 'architecture', 'assets', 'settings'];
const example = { name: 'example', profileLabel: 'Example', type: { id: 'code', label: 'Code project' }, tabs: CODE_TABS, hasProfile: true,
  realPath: 'C:\\ws\\projects\\example', linked: false, launchable: true, agents: [], archived: [] };
const notes = { name: 'notes', profileLabel: '', type: { id: 'generic', label: 'Plain project' }, tabs: ['overview', 'agents', 'assets', 'settings'],
  realPath: 'C:\\ws\\projects\\notes', linked: false, launchable: true, hasClaudeMd: true, agents: [], archived: [] };
const gone = { ...notes, name: 'gone', linked: true, realPath: '' };

function setup(sub) {
  store.setState({ root: 'C:\\ws', tools: { claude: true, editor: '' }, projects: [example, notes, gone], repos: { list: [] }, assets: [], catalog: { skills: [] } });
  store.setView('project', sub);
  const section = dom.document.createElement('section');
  dom.document.body.append(section);
  page.render(section, { sub });
  return section;
}
const show = (section, sub) => { page.onHide(); store.setView('project', sub); page.render(section, { sub }); page.onShow({ sub }); };

test('tabKeyTarget: Left and Right wrap, Home and End go to the ends, other keys are left alone', () => {
  assert.equal(tabKeyTarget('ArrowRight', 0, 4), 1);
  assert.equal(tabKeyTarget('ArrowRight', 3, 4), 0);
  assert.equal(tabKeyTarget('ArrowLeft', 0, 4), 3);
  assert.equal(tabKeyTarget('Home', 2, 4), 0);
  assert.equal(tabKeyTarget('End', 0, 4), 3);
  assert.equal(tabKeyTarget('ArrowDown', 0, 4), -1);
  assert.equal(tabKeyTarget('a', 0, 4), -1);
  assert.equal(tabKeyTarget('ArrowRight', -1, 4), -1, 'the focus is not on a tab');
  assert.equal(tabKeyTarget('ArrowRight', 0, 0), -1);
  assert.equal(tabKeyTarget('ArrowRight', 5, 4), -1);
});

test('startProblem: why Start Claude here is off, in words', () => {
  assert.equal(startProblem(example, { claude: true }), '');
  assert.equal(startProblem(example, {}), 'Claude Code was not found.');
  assert.match(startProblem({ ...example, launchable: false }, { claude: true }), /unusual characters/);
  assert.equal(startProblem({ ...example, realPath: '' }, { claude: true }), 'Link the checkout first.');
  assert.match(startProblem(gone, { claude: true }), /linked folder is gone/);
  assert.equal(startProblem(null), 'Link the checkout first.');
});

test('the header and the tab bar: name, path, type, and tabs that a screen reader can follow', () => {
  const section = setup('example/overview');
  assert.equal(section.querySelector('h2').textContent, 'Example');
  assert.match(textOf(section.querySelector('.pj-title')), /Example Code project C:\\ws\\projects\\example/);
  const list = section.querySelector('[role="tablist"]');
  assert.equal(list.getAttribute('aria-label'), 'Example sections');
  const tabs = list.querySelectorAll('[role="tab"]');
  assert.deepEqual(tabs.map(t => t.textContent), ['Overview', 'Tasks', 'Findings', 'Changes', 'Checks', 'Architecture', 'Assets', 'Settings']);
  assert.deepEqual(tabs.map(t => t.getAttribute('aria-selected')), ['true', 'false', 'false', 'false', 'false', 'false', 'false', 'false']);
  assert.deepEqual(tabs.map(t => t.getAttribute('tabindex')), ['0', '-1', '-1', '-1', '-1', '-1', '-1', '-1'], 'one Tab stop: the open tab');
  assert.ok(tabs.every(t => t.getAttribute('aria-controls') === PANEL_ID));
  assert.ok(tabs.every(t => t.tagName === 'BUTTON' && t.getAttribute('type') === 'button'), 'real buttons: Enter and Space open them');
  const panel = section.querySelector('[role="tabpanel"]');
  assert.equal(panel.id, PANEL_ID);
  assert.equal(panel.getAttribute('aria-labelledby'), tabId('overview'));
  assert.equal(section.querySelector(`#${tabId('overview')}`), tabs[0]);
});

test('the tab bar: Left, Right, Home and End move the focus; other keys do nothing', () => {
  const section = setup('example/overview');
  const tabs = section.querySelectorAll('[role="tab"]');
  tabs[0].focus();
  const e = dom.key(tabs[0], 'ArrowRight');
  assert.equal(dom.document.activeElement, tabs[1]);
  assert.equal(e.defaultPrevented, true);
  dom.key(tabs[1], 'ArrowLeft');
  dom.key(tabs[0], 'ArrowLeft');
  assert.equal(dom.document.activeElement, tabs[7], 'Left on the first tab wraps to the last');
  dom.key(tabs[7], 'Home');
  assert.equal(dom.document.activeElement, tabs[0]);
  dom.key(tabs[0], 'End');
  assert.equal(dom.document.activeElement, tabs[7]);
  const other = dom.key(tabs[7], 'x');
  assert.equal(other.defaultPrevented, false);
  assert.equal(dom.document.activeElement, tabs[7]);
  dom.key(tabs[7], 'ArrowRight', { ctrlKey: true });
  assert.equal(dom.document.activeElement, tabs[7], 'with Ctrl held the keys are not the tab bar\'s');
});

test('a click opens the tab as its own route; once it shows, the focus is on that tab', () => {
  const section = setup('example/overview');
  page.onShow({ sub: 'example/overview' });
  dom.click(section.querySelector(`#${tabId('checks')}`));
  assert.equal(dom.location.hash, '#project/example/checks');
  show(section, 'example/checks');
  const tab = section.querySelector(`#${tabId('checks')}`);
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  assert.equal(dom.document.activeElement, tab, 'the focus stays on the tab that was opened');
  assert.equal(section.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'), tabId('checks'));
  page.onHide();
});

test('a plain project gets its own tabs; More > Agents opens its Agents tab', () => {
  const section = setup('notes/overview');
  assert.equal(section.querySelector('h2').textContent, 'notes');
  assert.deepEqual(section.querySelectorAll('[role="tab"]').map(t => t.textContent), ['Overview', 'Agents', 'Assets', 'Settings']);
  dom.click(section.querySelector('[data-key="m-agents"]'));
  assert.equal(dom.location.hash, '#project/notes/agents');
  dom.click(section.querySelector('[data-key="m-projects"]'));
  assert.equal(dom.location.hash, '#projects');
});

test('pages without tabs: no project chosen, a broken link', () => {
  let section = setup('');
  assert.match(textOf(section), /No project chosen yet/);
  assert.equal(section.querySelector('[role="tablist"]'), null);
  section = setup('gone/overview');
  assert.match(textOf(section), /The linked folder is gone/);
  assert.equal(section.querySelector('[role="tablist"]'), null);
  assert.equal(section.querySelector('[data-key="start"]').disabled, true);
});

test('a name the state does not list: the server says it is unknown, or not linked yet', async () => {
  let section = setup('ghost/overview');
  page.onShow({ sub: 'ghost/overview' });
  await settle(5);
  page.render(section, { sub: 'ghost/overview' });
  assert.match(textOf(section), /No project named ghost\s*There is no project ghost\./);
  page.onHide();
  section = setup('Bad Name/overview');
  page.onShow({ sub: 'Bad Name/overview' });
  await settle(5);
  page.render(section, { sub: 'Bad Name/overview' });
  assert.match(textOf(section), /No project named Bad Name\s*"Bad Name" is not a project name\./, 'a name the server refuses reads as unknown too');
  page.onHide();
  section = setup('later/overview');
  page.onShow({ sub: 'later/overview' });
  await settle(5);
  page.render(section, { sub: 'later/overview' });
  assert.match(textOf(section), /Later is not linked yet\s*Not linked yet\. Link your existing checkout\./);
  dom.click(section.querySelector('[data-key="link"]'));
  assert.equal(dom.location.hash, '#projects', 'linking happens in Projects');
  page.onHide();
});
