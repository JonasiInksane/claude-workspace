// Tests for the project page's Overview tab (views/project/overview.js): the facts bar badges and
// the quick row's disabled reasons (moved from the cockpit's tests), what an asset or plain
// project's About card says, and the tab rendered in a stand-in DOM (test/dom.mjs) for a code
// project (facts, notes, five recent runs with the waiting ones first, Health, Run <project>) and
// a plain one (About, Start work here with its reasons). Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, settle, textOf } from '../../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
const calls = fakeFetch(path => {
  if (path.startsWith('/api/pipelines')) return { ok: true, pipelines: [], routes: [] };
  if (path.startsWith('/api/project?')) return { ok: true, project: { name: 'notes', present: true, label: 'notes' }, git: { branch: 'main', sha: 'abc1234def', changed: 2, upstream: 'origin/main', ahead: 1, behind: 0 } };
  return { ok: true };
});
const store = await import('../../store.js');
const { slot } = await import('../../parts/project-data.js');
const { aboutFacts, factsBadges, mergeRuns, quickRow, recentRuns, default: overview } = await import('./overview.js');

const project = over => ({
  project: { label: 'Example', present: true },
  git: { branch: 'main', sha: 'abcdef1234', detached: false, changed: 2, ahead: 0, behind: 0, upstream: 'origin/main', stashes: { total: 20, onBranch: 3 } },
  isolation: { mode: 'worktree', worktree: { name: 'run-tree', state: 'ready' } },
  trust: { state: 'trusted' },
  lock: { held: true, runId: 'r1', title: 'Refactor: totals' },
  node: { active: '24.11.1', pin: '20.15.1', matches: false },
  warnings: [{ id: 'services.running', text: 'Local services are running on port 5432.' }, { id: 'lock.waiting', text: 'waited 3 days' }],
  ...over,
});

test('facts bar badges say every fact in words', () => {
  const b = factsBadges(project());
  assert.deepEqual(b.map(x => x.text), [
    'main', '2 changed', 'Even with origin/main', '20 stashes · 3 on this branch · untouched', 'Trusted',
    'run-tree busy: Refactor: totals', 'Checks use Node 24.11.1 · Example pins 20.15.1', 'Local services are running on port 5432.',
  ]);
  assert.equal(b.find(x => x.text.startsWith('Checks use')).cls, 'amber', 'a Node that differs from the pin is amber');
  assert.ok(!b.some(x => x.text === 'waited 3 days'), 'the lock warning gets its own note');
  const other = factsBadges(project({
    git: { branch: null, sha: 'abcdef1234', detached: true, changed: 0, ahead: 2, behind: 1, upstream: 'origin/main', stashes: { total: 1, onBranch: 0 } },
    isolation: { mode: 'branch' }, trust: { state: 'not-trusted' }, lock: { held: false }, node: { active: '20.15.1', pin: '20.15.1', matches: true }, warnings: [],
  })).map(x => x.text);
  assert.deepEqual(other, ['Detached at abcdef1', 'Clean', '2 ahead, 1 behind of origin/main', '1 stash · 0 on this branch · untouched',
    'Branch mode', 'Not trusted', 'No lock', 'Checks use Node 20.15.1 · Example pins 20.15.1']);
  assert.deepEqual(factsBadges(project({ git: { error: 'not a git repository' }, lock: { error: 'x' }, node: null, warnings: [] })).map(x => x.text),
    ['Git could not read the checkout', 'Trusted']);
  assert.deepEqual(factsBadges({ git: null, trust: { state: 'unknown' }, lock: { held: false } }).map(x => x.text), ['No lock'],
    'no trust badge before the checkout is linked');
});

test('the quick row disables editing pipelines until the run worktree is ready', () => {
  const list = ['explain', 'check', 'fix', 'refactor', 'review', 'architecture', 'debug', 'feature'].map(id => ({
    id, label: id, disabledReason: '', isolation: ['fix', 'refactor', 'debug', 'feature'].includes(id) ? 'tree' : 'none',
  }));
  const ready = quickRow(list, project());
  assert.deepEqual(ready.map(q => q.pipeline), ['fix', 'refactor', 'debug', 'feature', 'review', 'architecture', 'explain', 'check']);
  assert.ok(ready.every(q => !q.disabledReason));
  const notReady = quickRow(list, project({ isolation: { mode: 'worktree', worktree: { name: 'run-tree', state: 'none' } } }));
  assert.deepEqual(notReady.filter(q => q.disabledReason).map(q => [q.pipeline, q.disabledReason]),
    ['fix', 'refactor', 'debug', 'feature'].map(id => [id, 'needs run-tree: Set up first']));
  assert.ok(quickRow(list, project({ isolation: { mode: 'branch', worktree: { state: 'none' } } })).every(q => !q.disabledReason), 'branch mode needs no worktree');
  const noProfile = quickRow(list.map(p => ({ ...p, disabledReason: 'No profile yet.' })), null);
  assert.ok(noProfile.every(q => q.disabledReason === 'No profile yet.'));
  assert.deepEqual(quickRow([], project()), []);
});

const run = (id, status, extra = {}) => ({ id, project: 'example', status, title: `Run ${id}`, pipeline: 'explain', ...extra });

test('recentRuns: the five newest runs, the waiting ones first; older waiting runs never push a new run out', () => {
  // Five older runs wait (the store has them) and a run has just finished (the route's newest).
  const live = ['261022-100001', '261022-100002', '261022-100003', '261022-100004', '261022-100005'].map(id => run(id, 'waiting', { waiting: 'plan' }));
  const recent = [run('261023-090000', 'passed'), run('261022-100006', 'failed'), run('261022-100005', 'waiting', { waiting: 'review' })];
  const all = mergeRuns(recent, live);
  assert.equal(all.length, 7, 'a run in both lists counts once');
  assert.deepEqual(recentRuns(all).map(r => r.id), ['261022-100005', '261022-100004', '261022-100003', '261023-090000', '261022-100006'],
    'the five newest, waiting first, the rest newest first');
  assert.equal(recentRuns(all)[0].waiting, 'review', 'the route\'s row wins');
  assert.deepEqual(recentRuns(mergeRuns([run('261022-100001', 'passed'), run('261022-100002', 'running')])).map(r => r.status), ['running', 'passed']);
  assert.equal(mergeRuns(undefined, live), null, 'still loading');
  assert.equal(recentRuns(null), null);
  assert.deepEqual(mergeRuns([null, { id: 7 }, {}], [null, { status: 'waiting' }]), [], 'rows without an id are left out');
  assert.equal(recent.length, 3, 'the route\'s list is not changed');
});

const notes = { name: 'notes', label: 'Other', type: { id: 'generic', label: 'Plain project' }, tabs: ['overview', 'agents', 'assets', 'settings'],
  linked: false, realPath: 'C:\\ws\\projects\\notes', hasClaudeMd: true, launchable: true, agents: [], archived: [] };

test('aboutFacts: what a plain project is, in words, whatever git says', () => {
  const rows = new Map(aboutFacts(notes, { d: null }));
  assert.equal(rows.get('Type'), 'Plain project');
  assert.match(rows.get('CLAUDE.md'), /^Present/);
  assert.match(rows.get('Repository list'), /^Not listed/);
  assert.equal(rows.get('Folder'), 'projects/notes');
  assert.equal(rows.get('Git'), 'Loading…');
  assert.equal(rows.get('Agents'), 'No agents yet');
  assert.ok(!rows.has('Assets'), 'no asset pipeline: no Assets row');
  const art = { ...notes, name: 'art', label: 'Game', type: { id: 'assets', label: 'Asset pipeline' }, hasClaudeMd: false, linked: true, realPath: 'D:\\art',
    agents: [{ name: 'a' }, { name: 'b' }], archived: [{ name: 'c' }] };
  const r2 = new Map(aboutFacts(art, { d: { git: { branch: 'main', changed: 0, upstream: 'origin/main', ahead: 0, behind: 2 } }, listed: true, assets: 1 }));
  assert.equal(r2.get('Type'), 'Asset pipeline · Game');
  assert.match(r2.get('CLAUDE.md'), /^Missing/);
  assert.match(r2.get('Repository list'), /^Listed/);
  assert.equal(r2.get('Folder'), 'Linked: D:\\art');
  assert.equal(r2.get('Git'), 'main · clean · 2 behind with origin/main');
  assert.equal(r2.get('Agents'), '2 agents, 1 archived');
  assert.equal(r2.get('Assets'), '1 asset');
  assert.equal(new Map(aboutFacts({ ...notes, linked: true, realPath: '' })).get('Folder'), 'Link broken: its folder is gone');
  assert.match(new Map(aboutFacts(notes, { d: { git: { error: 'not a repo' } } })).get('Git'), /^Not a git repository/);
  assert.match(new Map(aboutFacts(notes, { d: { git: null } })).get('Git'), /not here/);
  assert.match(new Map(aboutFacts(notes, { askable: false })).get('Git'), /lowercase names only/);
  assert.equal(new Map(aboutFacts(notes, { d: null, error: 'timeout' })).get('Git'), 'Could not be read: timeout');
  assert.equal(new Map(aboutFacts(notes, { assets: 0 })).get('Assets'), 'No assets yet');
});

test('a plain project: About, then Start work here; a missing Claude says why its buttons are off', async () => {
  store.setState({ root: 'C:\\ws', tools: { claude: false }, projects: [notes], repos: { list: [] }, assets: [], catalog: { skills: [] } });
  const el = dom.document.createElement('div');
  const ctx = { state: store.state, project: notes, rest: '', go: store.go, refresh: () => {} };
  overview.render(el, ctx);
  const about = textOf(el);
  assert.match(about, /About this project/);
  assert.match(about, /Git\s*Loading…/);
  const start = el.querySelector('[data-key="ov:start"]');
  assert.equal(start.disabled, true);
  const why = el.querySelector(`#${start.getAttribute('aria-describedby')}`);
  assert.match(why.textContent, /Claude Code was not found/);
  assert.equal(el.querySelector('[data-key="ov:onboard"]'), null, 'a CLAUDE.md is there: no Onboard');
  overview.onShow(ctx);
  await settle(5);
  assert.ok(calls.some(c => c.path === '/api/project?name=notes'), 'the overview asks git about the project');
  overview.render(el, ctx);
  assert.match(textOf(el), /Git\s*main · 2 changed · 1 ahead with origin\/main/);
  overview.onHide();
});

test('a code project: facts, notes, the five newest runs with the waiting ones first, Health and Run <project>', async () => {
  const example = { name: 'example', type: { id: 'code', label: 'Code project' }, tabs: ['overview'], hasProfile: true, realPath: 'C:\\ws\\projects\\example' };
  store.setState({ root: 'C:\\ws', tools: { claude: true }, projects: [example], repos: { list: [] }, assets: [], catalog: { skills: [] } });
  const s = slot('example');
  s.project = { data: { ...project(), profile: { exists: false }, checklist: [{ id: 'linked', ok: true, text: 'Linked' }, { id: 'profile', ok: false, text: 'No profile', action: { kind: 'profile-init', label: 'Create from the example' } }],
    runTg: [{ id: 'web', label: 'Web', warn: '', disabledReason: '' }, { id: 'api', label: 'API', warn: '', disabledReason: 'Link the checkout first.' }], notCovered: ['Browser checks'] } };
  s.runs = { data: { runs: ['261022-100001', '261022-100002', '261022-100003', '261022-100004', '261022-100005', '261022-100006'].map((id, i) => ({
    id, project: 'example', pipeline: 'explain', title: `Run ${i}`, status: i === 4 ? 'waiting' : 'passed', waiting: i === 4 ? 'plan' : null, createdAt: new Date().toISOString(),
  })) } };
  s.metrics = { data: { score: { value: 72, delta: 3, trend: 'better', spark: [70, 72] }, latest: { id: 'scan-1' }, tiles: [{ id: 'deepImports', label: 'Deep imports', display: '11', trend: 'better', value: 11 }] } };
  const el = dom.document.createElement('div');
  overview.render(el, { state: store.state, project: example, rest: '', go: store.go, refresh: () => {} });
  const text = textOf(el);
  assert.equal(el.querySelector('.factsbar').getAttribute('aria-label'), 'Repository status');
  assert.match(text, /Even with origin\/main/);
  assert.match(text, /Setup 1\/2/);
  assert.match(text, /No profile yet\./, 'the missing profile gets a note with Create from the example');
  const rows = el.querySelectorAll('.cgrid .card')[0].querySelectorAll('li');
  assert.equal(rows.length, 5, 'five recent runs');
  assert.match(rows[0].textContent, /Run 4/, 'the waiting run comes first');
  assert.match(text, /Health score/);
  assert.match(text, /Run Example/);
  const api = el.querySelector('[data-key="runcmd:api"]');
  assert.equal(api.disabled, true);
  assert.equal(el.querySelector(`#${api.getAttribute('aria-describedby')}`).textContent, 'API: Link the checkout first.');
  // A second render with the same data keeps every card (the focus and typed text stay).
  const cards = el.querySelectorAll('.card');
  overview.render(el, { state: store.state, project: example, rest: '', go: store.go, refresh: () => {} });
  const after = el.querySelectorAll('.card');
  assert.equal(after.length, cards.length);
  assert.ok(after.every((c, i) => c === cards[i]), 'the same card elements, not rebuilt');
});

test('a code project with older runs waiting: the newest runs show, and a line under them counts the others', () => {
  const busy = { name: 'busy', type: { id: 'code', label: 'Code project' }, tabs: ['overview', 'tasks'], hasProfile: true, realPath: 'C:\\ws\\projects\\busy' };
  store.setState({ root: 'C:\\ws', tools: { claude: true }, projects: [busy], repos: { list: [] }, assets: [], catalog: { skills: [] } });
  const ids = ['261022-100001', '261022-100002', '261022-100003', '261022-100004', '261022-100005', '261022-100006', '261022-100007'];
  slot('busy').runs = { data: { runs: ids.map((id, i) => run(id, i < 2 ? 'waiting' : 'passed', { project: 'busy', waiting: i < 2 ? 'plan' : null })).reverse() } };
  const el = dom.document.createElement('div');
  overview.render(el, { state: store.state, project: busy, rest: '', go: store.go, refresh: () => {} });
  const card = el.querySelectorAll('.cgrid .card')[0];
  assert.deepEqual(card.querySelectorAll('li').map(li => li.querySelector('.run-link').textContent),
    ['Run 261022-100007', 'Run 261022-100006', 'Run 261022-100005', 'Run 261022-100004', 'Run 261022-100003']);
  assert.match(textOf(card), /2 older runs also wait for you\. See them in Tasks$/);
  dom.click(card.querySelector('[data-key="runs:older"]'));
  assert.equal(dom.location.hash, '#project/busy/tasks');
});
