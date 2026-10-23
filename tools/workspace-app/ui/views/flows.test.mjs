// Tests for the pure helpers of the Flows view (views/flows.js): where a flow runs (its label and
// the editor's select value, "Any project" included), the run dialog's project choices and its
// Start button, and the text of a recorded run in the editor's "Recent runs". The view needs a
// browser to render; dialog.js looks up #dialog when it loads, so a minimal `document` stands in
// for it before the view loads.
// Run: node tools/run-tests.mjs workspace-app
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { querySelector: () => ({ addEventListener() {} }) };
const { flowTargetLabel, flowTargetValue, parseTargetValue, projectChoices, runVersionParts, runWhere, startState } = await import('./flows.js');

const hub = { target: 'hub', project: '', agent: '' };
const any = { target: 'project', project: '*', agent: '' };
const fixed = { target: 'project', project: 'example', agent: '' };
const agent = { target: 'agent', project: 'example', agent: 'artist' };

test('flows: a flow for any project reads "Any project"; the select value round-trips for every target', () => {
  assert.deepEqual([hub, any, fixed, agent].map(flowTargetLabel), ['Hub', 'Any project', 'example', 'example · artist']);
  assert.deepEqual([hub, any, fixed, agent].map(flowTargetValue), ['hub', 'project:*', 'project:example', 'agent:example/artist']);
  for (const f of [hub, any, fixed, agent]) assert.deepEqual(parseTargetValue(flowTargetValue(f)), f);
  // "*" is only "any project" for a project flow.
  assert.equal(flowTargetLabel({ target: 'agent', project: '*', agent: 'artist' }), '* · artist');
});

test('flows: the run dialog offers the projects the app can start in, the open one chosen', () => {
  const projects = [{ name: 'example', launchable: true }, { name: 'we;ird', launchable: false }, { name: 'notes', launchable: true }];
  assert.deepEqual(projectChoices(projects, 'notes'), { choices: ['example', 'notes'], value: 'notes' });
  // The open project is not one it can start in, or there is none: nothing is chosen.
  assert.deepEqual(projectChoices(projects, 'we;ird'), { choices: ['example', 'notes'], value: '' });
  assert.deepEqual(projectChoices(projects, ''), { choices: ['example', 'notes'], value: '' });
  assert.deepEqual(projectChoices(undefined, 'example'), { choices: [], value: '' });
  assert.deepEqual(projectChoices([null, { name: 'x' }], 'x'), { choices: [], value: '' });
});

test('flows: Start says where it starts, and why it is off', () => {
  assert.deepEqual(startState({ place: 'Hub' }), { disabled: false, text: 'Start in Hub', reason: '' });
  assert.deepEqual(startState({ needAnswer: true, place: 'example · artist' }),
    { disabled: true, text: 'Start in example · artist', reason: 'Start is off until you answer the question.' });
  // A flow for any project: the chosen project, or off until there is one.
  assert.deepEqual(startState({ project: 'notes', place: 'Any project' }), { disabled: false, text: 'Start in notes', reason: '' });
  assert.deepEqual(startState({ project: '', place: 'Any project' }), { disabled: true, text: 'Start', reason: 'Start is off until you choose a project.' });
  assert.deepEqual(startState({ project: '', needAnswer: true }),
    { disabled: true, text: 'Start', reason: 'Start is off until you choose a project and answer the question.' });
  assert.deepEqual(startState({ project: 'notes', needAnswer: true }),
    { disabled: true, text: 'Start in notes', reason: 'Start is off until you answer the question.' });
});

test('flows: a recorded run says where it started, its short version and what changed since', () => {
  const version = { sha256: 'abcdef0123456789'.repeat(4), hubCommit: '0123456789abcdef0123456789abcdef01234567', committed: true, images: [], captions: '' };
  assert.deepEqual([runWhere({ target: 'hub' }), runWhere({ target: 'project', project: 'notes' }), runWhere({ target: 'agent', project: 'example', agent: 'artist' }),
    runWhere({ target: 'project', project: '' })], ['Hub', 'notes', 'example · artist', 'a project']);
  assert.deepEqual(runVersionParts({ version, changes: [] }),
    { before: 'Version ', hash: 'abcdef01', after: ' · in hub commit 0123456', edited: false });
  assert.deepEqual(runVersionParts({ version: { ...version, committed: false }, changes: ['prompt'] }),
    { before: 'Version ', hash: 'abcdef01', after: ' · not committed in the hub · since then the prompt changed', edited: true });
  assert.equal(runVersionParts({ version, changes: ['prompt', 'images'] }).after, ' · in hub commit 0123456 · since then the prompt and the images changed');
  assert.deepEqual(runVersionParts({ version: null, changes: ['unknown'] }), { before: 'The version was not recorded', hash: '', after: '', edited: false });
  // Without `changes` (an older answer) nothing is marked.
  assert.equal(runVersionParts({ version }).edited, false);
});
