// Tests for the project page's Agents tab (views/project/agents.js), rendered in a stand-in DOM
// (test/dom.mjs): the agents with what Projects offers for them (Start, Edit, Memory, Images),
// why an agent can't start, + New agent, the archived ones folded with Restore, the empty state,
// and that a refresh with the same data keeps the card. Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, textOf } from '../../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
fakeFetch(() => ({ ok: true }));
const store = await import('../../store.js');
const { agentsDeps, default: agents } = await import('./agents.js');

const agent = (name, over = {}) => ({ name, description: `${name} does things`, memory: 'project', isolated: true, valid: true, duplicate: false,
  file: `${name}.md`, images: 0, memoryFiles: 1, ...over });
const art = {
  name: 'sample-art', type: { id: 'assets', label: 'Asset pipeline' }, tabs: ['overview', 'assets', 'agents', 'settings'], realPath: 'C:\\x',
  launchable: true, linked: false, sharedImages: 2,
  agents: [agent('asset-builder'), agent('plain', { isolated: false, memory: '' })],
  archived: [{ archivedAs: 'old.md', name: 'old', description: 'Retired', valid: true }],
};
const ctx = p => ({ state: store.state, project: p, rest: '', go: store.go, refresh: () => {} });

test('the tab: each agent with Start, Edit, Memory and Images; one without memory of its own says why', () => {
  store.setState({ root: 'C:\\ws', tools: { claude: true }, projects: [art], assets: [] });
  const el = dom.document.createElement('div');
  agents.render(el, ctx(art));
  const rows = el.querySelector('ul.agents').children;
  assert.equal(rows.length, 3, 'two agents and the shared images row');
  const start = el.querySelector('[data-key="agent-sample-art-asset-builder-start"]');
  assert.equal(start.disabled, false);
  assert.equal(el.querySelector('[data-key="agent-sample-art-plain-start"]').disabled, true);
  assert.match(textOf(rows[1]), /No "memory: project" in its agent file/);
  for (const what of ['edit', 'memory', 'images']) assert.ok(el.querySelector(`[data-key="agent-sample-art-asset-builder-${what}"]`), what);
  assert.ok(el.querySelector('[data-key="project-sample-art-new-agent"]'), '+ New agent');
  const archived = el.querySelector('details.archived');
  assert.equal(archived.open, false, 'the archived agents start folded');
  assert.match(textOf(archived), /Archived agents \(1\).*old.*Restore/);
});

test('the tab: no Claude Code means no Start; no agents gives the empty state', () => {
  store.setState({ root: 'C:\\ws', tools: { claude: false }, projects: [art], assets: [] });
  const el = dom.document.createElement('div');
  agents.render(el, ctx(art));
  assert.equal(el.querySelector('[data-key="agent-sample-art-asset-builder-start"]').disabled, true);
  const none = { ...art, name: 'notes', agents: [], archived: [] };
  agents.render(el, ctx(none));
  assert.match(textOf(el), /No agents yet/);
  assert.equal(el.querySelector('details.archived'), null);
});

test('the tab: the same data keeps the same card; a change in the agents rebuilds it', () => {
  store.setState({ root: 'C:\\ws', tools: { claude: true }, projects: [art], assets: [] });
  const el = dom.document.createElement('div');
  agents.render(el, ctx(art));
  const card = el.firstChild;
  agents.render(el, ctx({ ...art }));
  assert.equal(el.firstChild, card);
  agents.render(el, ctx({ ...art, agents: [agent('asset-builder', { memoryFiles: 2 })] }));
  assert.notEqual(el.firstChild, card);
  assert.deepEqual(agentsDeps(art).slice(0, 1), ['sample-art']);
});
