// Tests for the palette's screens (parts/palette.js screenItems): the global screens in the nav's
// order, every tab of every project's page as a jump target ("example > Findings") with its route,
// Library and Inbox images, and odd states. Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom } from '../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
fakeFetch(() => ({ ok: true }));
const { screenItems } = await import('./palette.js');

test('screenItems: every project tab is a jump target, between Projects and Assets', () => {
  const state = { projects: [
    { name: 'example', tabs: ['overview', 'tasks', 'findings', 'changes', 'checks', 'architecture', 'assets', 'settings'] },
    { name: 'notes', tabs: ['overview', 'agents', 'assets', 'settings'] },
  ] };
  const items = screenItems(state);
  assert.deepEqual(items.slice(0, 2).map(i => i.label), ['Today', 'Projects']);
  const find = label => items.find(i => i.label === label);
  assert.deepEqual(find('example > Findings'), { label: 'example > Findings', route: 'project', sub: 'example/findings' });
  assert.deepEqual(find('notes > Agents'), { label: 'notes > Agents', route: 'project', sub: 'notes/agents' });
  assert.equal(items.filter(i => i.route === 'project').length, 12);
  assert.deepEqual(items.slice(-5).map(i => [i.label, i.route]), [['Assets', 'assets'], ['Flows', 'flows'], ['Runs', 'runs'], ['Library', 'library'], ['Inbox images', 'images']]);
  assert.ok(!items.some(i => /cockpit|health/i.test(i.label)), 'no cockpit or Health screens any more');
});

test('screenItems: no state, projects without tabs or names, and a label function of its own', () => {
  assert.deepEqual(screenItems(null).map(i => i.label), ['Today', 'Projects', 'Assets', 'Flows', 'Runs', 'Library', 'Inbox images']);
  const items = screenItems({ projects: [null, { name: '' }, { name: 'bare' }] }, id => id.toUpperCase());
  assert.deepEqual(items.filter(i => i.route === 'project').map(i => [i.label, i.sub]), [['bare > OVERVIEW', 'bare/overview']]);
});
