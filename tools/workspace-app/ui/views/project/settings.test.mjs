// Tests for the project page's Settings tab (views/project/settings.js): the profile's status in
// words (valid, with warnings, with problems, missing, not loaded), the --check command, and the
// tab in a stand-in DOM (test/dom.mjs): the project-rules note, a code project's profile with its
// problems and the command, and a plain project's Create from the example (or why it can't).
// Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, settle, textOf } from '../../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
const calls = fakeFetch(() => ({ ok: true, message: 'Created.', pipelines: [], routes: [], projects: [] }));
const store = await import('../../store.js');
const { slot } = await import('../../parts/project-data.js');
const { checkCommand, profileStatus, default: settings } = await import('./settings.js');

test('profileStatus: valid, with warnings, with problems, missing and not loaded', () => {
  assert.deepEqual(profileStatus({ exists: true, valid: true, errors: [], warnings: [] }), { state: 'valid', text: 'Present and valid.', items: [] });
  assert.deepEqual(profileStatus({ exists: true, valid: true, warnings: ['Old field'] }), { state: 'valid', text: 'Present and valid, with 1 warning.', items: ['Old field'] });
  assert.deepEqual(profileStatus({ exists: true, valid: false, errors: ['a', 'b'] }), { state: 'invalid', text: 'The profile has 2 problems.', items: ['a', 'b'] });
  assert.equal(profileStatus({ exists: false }).state, 'missing');
  assert.equal(profileStatus(null).state, 'unknown');
  assert.equal(profileStatus('x').state, 'unknown');
  assert.equal(checkCommand('example'), 'node tools/workspace-app/profile/profile.mjs --check example');
});

const ctx = p => ({ state: store.state, project: p, rest: '', go: store.go, refresh: () => {} });
const example = { name: 'example', type: { id: 'code', label: 'Code project' }, tabs: ['overview', 'settings'], realPath: 'C:\\x' };

test('a code project: the rules note, the profile with its problems, and the --check command', () => {
  store.setState({ root: 'C:\\ws', tools: {}, projects: [example], assets: [] });
  const el = dom.document.createElement('div');
  settings.render(el, ctx(example));
  assert.match(textOf(el), /Project rules arrive with project settings/);
  assert.match(textOf(el), /Profile.*Loading…/);
  slot('example').project = { data: { profile: { exists: true, valid: false, errors: ['commands.test is missing'], warnings: [], path: 'C:\\data\\profiles\\example.json' } } };
  settings.render(el, ctx(example));
  const text = textOf(el);
  assert.match(text, /Has problems The profile has 1 problem\./);
  assert.match(text, /commands\.test is missing/);
  assert.match(text, /C:\\data\\profiles\\example\.json/);
  assert.match(text, /node tools\/workspace-app\/profile\/profile\.mjs --check example/);
  assert.equal(el.querySelector('[data-key="st:create"]'), null, 'a profile that exists is never created again');
});

test('a plain project: Create from the example makes it a code project; an uppercase name can not have one', async () => {
  const notes = { name: 'notes', type: { id: 'generic', label: 'Plain project' }, tabs: ['overview', 'settings'], realPath: 'C:\\y' };
  store.setState({ root: 'C:\\ws', tools: {}, projects: [notes], assets: [] });
  const el = dom.document.createElement('div');
  settings.render(el, ctx(notes));
  assert.match(textOf(el), /No profile\. With one, this becomes a code project/);
  dom.click(el.querySelector('[data-key="st:create"]'));
  await settle(5);
  assert.deepEqual(calls.find(c => c.path === '/api/project/profile-init').body, { project: 'notes' });
  assert.ok(calls.some(c => c.path === '/api/state'), 'the state loads again (the type, and so the tabs, change)');
  const upper = { ...notes, name: 'Tattoo' };
  settings.render(el, ctx(upper));
  assert.equal(el.querySelector('[data-key="st:create"]'), null);
  assert.match(textOf(el), /A profile needs a lowercase folder name/);
});
