// Tests for the Ask panel (ui/parts/ask-panel.js): the pure helpers (subject keys, the reference the
// page sends, a question's state in words, path:line and `code` parts, why Ask is off), and the
// panel in a stand-in DOM (test/dom.mjs) against a scripted server: it opens as a labelled
// complementary landmark with the focus in the question box, a question posts only a reference,
// the run is followed through store signals from queued to running to its answer, a follow-up
// carries the previous question as `after`, a failed question offers Retry, Ask is off while a
// question runs, Esc closes it and stops listening (no more pulls), opening again brings back the
// thread and the draft, a finding is asked about by reference, a question that could not be sent
// can be sent again, and a route change closes the panel. Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEvent, fakeFetch, installDom, reply, settle, textOf } from '../../test/dom.mjs';

const dom = installDom({ hash: '#run/r-ctx' });
after(() => dom.uninstall());

// The scripted server: each question's run answers GET /api/run with the next state of its script
// (the last one repeats); POST /api/runs gives q1, q2 … unless `refuse` says why not.
const scripts = new Map();
let refuse = '';
let n = 0;
const calls = fakeFetch((path, { method, body }) => {
  if (method === 'POST' && path === '/api/runs') {
    if (refuse) return reply(400, { ok: false, error: refuse });
    const id = `q${++n}`;
    if (!scripts.has(id)) scripts.set(id, [states.passed(id)]);
    return { ok: true, runId: id };
  }
  if (method === 'POST' && path === '/api/runs/retry') return { ok: true, message: 'Retrying the stage.', run: states.running(body.id) };
  const m = /^\/api\/run\?id=([a-z0-9-]+)&limit=1$/.exec(path);
  if (m) {
    const list = scripts.get(m[1]);
    if (!list) return reply(404, { ok: false, error: 'There is no run.' });
    const run = list.length > 1 ? list.shift() : list[0];
    return { ok: true, run, rows: [], next: 0, more: false };
  }
  return { ok: true };
});
const store = await import('../store.js');
const ask = await import('./ask-panel.js');

const A = (action, enabled = true, reason = '') => ({ action, label: action, enabled, reason });
const states = {
  queued: id => ({ id, status: 'running', createdAt: new Date(Date.now() - 3000).toISOString(), stages: [{ id: 'answer', status: 'pending' }], actions: [] }),
  running: id => ({ id, status: 'running', createdAt: new Date().toISOString(), stages: [{ id: 'answer', status: 'running', startedAt: new Date(Date.now() - 12_000).toISOString() }], actions: [] }),
  passed: (id, text = 'total() calls sumCents in apps/web/src/features/cart/total.mjs:3, so money stays in `cents`.') => ({
    id, status: 'passed', durationMs: 42_000, stages: [{ id: 'answer', status: 'done' }], actions: [A('report')],
    outputs: { answer: { answer: text, sources: [{ path: 'apps/web/src/features/cart/total.mjs', line: 3, note: 'the call' }], openQuestions: [], suggestedNote: '' } },
  }),
  failed: id => ({ id, status: 'failed', statusReason: 'Claude returned no structured result.', stages: [{ id: 'answer', status: 'failed' }], actions: [A('retry')] }),
  capped: id => ({ id, status: 'capped', statusReason: 'Turn cap reached', stages: [{ id: 'answer', status: 'capped' }], actions: [A('resume', false, 'No session.')] }),
};

const panel = () => dom.document.getElementById('ask-panel');
const input = () => dom.document.getElementById('ask-input');
const sendButton = () => panel().querySelector('.ask-send');
const posts = () => calls.filter(c => c.method === 'POST' && c.path === '/api/runs');
const pulls = id => calls.filter(c => c.path === `/api/run?id=${id}&limit=1`).length;
function type(text) {
  input().value = text;
  input().dispatchEvent(fakeEvent('input'));
}
const signal = async id => { store.emitSignal({ run: id, project: 'example', seq: null, status: null }); await settle(5); };

const runSubject = ask.runSubject({ id: 'r-ctx', project: 'example', title: 'Refactor: Move cart totals into a cents helper' });

test('pure helpers: keys, the reference sent, titles, chips and why Ask is off', () => {
  assert.equal(ask.subjectKey(runSubject), 'run:r-ctx');
  const finding = ask.findingSubject('example', { id: 'EX-3', title: 'Totals in floats' });
  assert.equal(ask.subjectKey(finding), 'finding:example:EX-3');
  assert.equal(ask.subjectKey(null), '');
  assert.deepEqual(ask.contextRef(runSubject), { run: 'r-ctx' });
  assert.deepEqual(ask.contextRef(runSubject, 'q1'), { run: 'r-ctx', after: 'q1' });
  assert.deepEqual(ask.contextRef(finding, 'q2'), { finding: { project: 'example', id: 'EX-3' }, after: 'q2' });
  assert.equal(ask.panelTitle(runSubject), 'Ask about this run');
  assert.equal(ask.panelTitle(ask.runSubject({ id: 'r', project: 'p', title: 't' }, { review: true })), 'Ask about this review gate');
  assert.equal(ask.panelTitle(finding), 'Ask about EX-3');
  assert.equal(ask.chipText(runSubject), 'Run · Refactor: Move cart totals into a cents helper');
  assert.equal(ask.chipText(finding), 'EX-3 · Totals in floats');
  assert.deepEqual(ask.runSubject({ id: 'r', project: 'p', title: 't' }, { review: true }).route, ['review', 'r']);
  assert.deepEqual(finding.route, ['project', 'example/findings']);
  assert.equal(ask.runSubject(null), null);
  assert.equal(ask.findingSubject('example', {}), null);
  assert.equal(ask.askBlock([], '  '), 'Type a question first.');
  assert.equal(ask.askBlock([{ id: 'q1', run: states.queued('q1') }], 'x'), 'Wait for the answer to the last question first.');
  assert.equal(ask.askBlock([{ id: '', sending: true }], 'x'), 'Wait for the answer to the last question first.');
  assert.equal(ask.askBlock([{ id: 'q1', run: states.failed('q1') }, { id: '', error: 'nope' }], 'x'), '');
  assert.equal(ask.lastAsked([{ id: 'q1' }, { id: '', error: 'x' }]).id, 'q1');
});

test('pure helpers: a question\'s state in words, and the parts an answer shows as code', () => {
  const st = (e, kind, text) => {
    const s = ask.questionState(e);
    assert.equal(s.kind, kind);
    if (text) assert.match(s.text, text);
    return s;
  };
  st({ sending: true }, 'sending', /Sending/);
  st({ id: 'q', error: 'The project has no profile.' }, 'error', /no profile/);
  st({ id: 'q', missing: true }, 'gone', /gone/);
  assert.ok(st({ id: 'q', run: null, at: 5 }, 'queued').since === 5);
  st({ id: 'q', run: states.queued('q') }, 'queued', /Queued: waiting for a free Claude slot/);
  assert.ok(st({ id: 'q', run: states.running('q') }, 'running', /reading the code/).since < Date.now() - 11_000);
  st({ id: 'q', run: states.passed('q') }, 'answered');
  assert.equal(st({ id: 'q', run: states.failed('q') }, 'failed', /Failed: Claude returned no structured result\./).action, 'retry');
  assert.equal(st({ id: 'q', run: states.capped('q') }, 'capped', /Turn cap reached: Turn cap reached/).action, 'resume');
  st({ id: 'q', run: { status: 'paused-limit', stages: [] } }, 'paused', /usage limit/);
  st({ id: 'q', run: { status: 'interrupted', statusReason: 'The app closed.', stages: [] } }, 'interrupted', /The app closed/);
  st({ id: 'q', run: { status: 'cancelled', stages: [] } }, 'cancelled');
  const parts = ask.refParts('See apps/web/x.mjs:12-14 and total.mjs:3, not e.g. this and/or that; `sumCents()` too.');
  assert.deepEqual(parts.filter(p => p.code).map(p => p.text), ['apps/web/x.mjs:12-14', 'total.mjs:3', 'sumCents()']);
  assert.equal(parts.map(p => p.text).join(''), 'See apps/web/x.mjs:12-14 and total.mjs:3, not e.g. this and/or that; sumCents() too.');
  assert.deepEqual(ask.refParts('Plain text.'), [{ text: 'Plain text.', code: false }]);
  assert.deepEqual(ask.refParts('src/app.js'), [{ text: 'src/app.js', code: true }]);
});

test('the panel: opens labelled, asks by reference, follows the run to its answer, and a follow-up carries the thread', async () => {
  const opener = ask.askButton(runSubject);
  dom.document.body.append(opener);
  assert.deepEqual([opener.getAttribute('aria-controls'), opener.getAttribute('aria-expanded'), opener.textContent], ['ask-panel', 'false', 'Ask']);
  dom.click(opener);
  const p = panel();
  assert.ok(p && !p.hidden, 'the panel shows');
  assert.equal(p.tagName, 'ASIDE');
  assert.equal(p.getAttribute('role'), 'complementary');
  assert.equal(dom.document.getElementById(p.getAttribute('aria-labelledby')).textContent, 'Ask about this run');
  assert.equal(dom.document.activeElement, input(), 'the focus moves into the panel');
  assert.equal(opener.getAttribute('aria-expanded'), 'true');
  assert.equal(p.querySelector('.ask-chip').textContent, 'Run · Refactor: Move cart totals into a cents helper');
  assert.match(textOf(p), /Claude gets what the app knows about it/);
  assert.equal(p.querySelector('ol'), null, 'no list before the first question');
  assert.equal(p.querySelector('.ask-label').textContent, 'Your question');
  assert.match(input().getAttribute('placeholder'), /what did this run change/);

  dom.click(sendButton());
  assert.equal(posts().length, 0, 'an empty question sends nothing');
  assert.equal(p.querySelector('#ask-why').textContent, 'Type a question first.');
  type('Why a cents helper?');
  assert.equal(p.querySelector('#ask-why').hidden, true, 'typing clears the reason');

  scripts.set('q1', [states.queued('q1'), states.running('q1'), states.passed('q1')]);
  dom.key(input(), 'Enter', { ctrlKey: true });
  await settle(5);
  assert.deepEqual(posts()[0].body, { project: 'example', pipeline: 'explain', values: { what: 'Why a cents helper?' }, context: { run: 'r-ctx' } });
  assert.equal(input().value, '', 'the box is empty again');
  assert.equal(p.querySelector('ol.ask-list').getAttribute('aria-label'), 'Questions and answers');
  assert.match(textOf(p), /You Why a cents helper\? Queued: waiting for a free Claude slot\. \d+ s/);
  assert.equal(sendButton().getAttribute('aria-disabled'), 'true', 'Ask is off while the question runs');
  assert.match(p.querySelector('#ask-why').textContent, /Wait for the answer/);
  type('Too soon');
  dom.click(sendButton());
  assert.equal(posts().length, 1, 'no second question while one runs');

  await signal('q1');
  assert.match(textOf(p), /Claude is reading the code\. 1[2-4] s/);
  assert.equal(p.querySelector('[role="status"]').textContent, 'Claude is reading the code.');
  await signal('q1');
  const a = p.querySelector('.ask-a');
  assert.ok(a, 'the answer shows');
  assert.match(textOf(a), /total\(\) calls sumCents in apps\/web\/src\/features\/cart\/total\.mjs:3, so money stays in cents\./);
  assert.deepEqual(a.querySelectorAll('code').map(c => c.textContent), ['apps/web/src/features/cart/total.mjs:3', 'cents']);
  assert.match(textOf(p), /apps\/web\/src\/features\/cart\/total\.mjs:3 the call Answered in 42 s · Open the full answer/);
  assert.equal(p.querySelector('[role="status"]').textContent, 'The answer is there.');
  assert.equal(sendButton().getAttribute('aria-disabled'), null, 'Ask is on again');
  const done = pulls('q1');
  await signal('q1');
  assert.equal(pulls('q1'), done, 'an answered question is no longer followed');

  // The follow-up: the previous question goes along as `after`; it fails, and Retry runs it again.
  assert.equal(p.querySelector('.ask-label').textContent, 'Follow-up question');
  scripts.set('q2', [states.failed('q2')]);
  type('And the pin test?');
  dom.click(sendButton());
  await settle(5);
  assert.deepEqual(posts()[1].body.context, { run: 'r-ctx', after: 'q1' });
  assert.match(textOf(p), /Failed: Claude returned no structured result\. Retry ?Open the run/);
  scripts.set('q2', [states.running('q2'), states.passed('q2', 'Yes, it pins total([1, 2, 3]).')]);
  dom.click(p.querySelectorAll('button').find(b => b.textContent === 'Retry'));
  await settle(5);
  assert.deepEqual(calls.filter(c => c.path === '/api/runs/retry').map(c => c.body), [{ id: 'q2' }]);
  await signal('q2');
  assert.match(textOf(p), /Yes, it pins total\(\[1, 2, 3\]\)\./);
  assert.match(textOf(p), /Why a cents helper\?.*And the pin test\?/, 'the thread keeps both, oldest first');

  dom.click(p.querySelectorAll('button').find(b => b.textContent === 'Open the full answer'));
  assert.equal(dom.location.hash, '#run/q1', 'the full Explain run opens');
  dom.location.hash = '#run/r-ctx';
});

test('the panel: Esc closes it, puts the focus back and stops listening; opening again keeps the thread and the draft', async () => {
  const opener = dom.document.body.querySelector('.ask-open-btn');
  scripts.set('q3', [states.running('q3')]);
  type('A third one');
  dom.click(sendButton());
  await settle(5);
  assert.match(textOf(panel()), /A third one Claude is reading the code/);
  type('my unsent draft');
  dom.key(input(), 'Escape');
  assert.equal(panel().hidden, true, 'Esc closes the panel');
  assert.equal(dom.document.activeElement, opener, 'the focus is back on the Ask button');
  assert.equal(opener.getAttribute('aria-expanded'), 'false');
  const before = pulls('q3');
  await signal('q3');
  await signal('q3');
  assert.equal(pulls('q3'), before, 'closed: no more pulls');

  scripts.set('q3', [states.passed('q3', 'Third answer.')]);
  dom.click(opener);
  await settle(5);
  assert.equal(panel().hidden, false);
  assert.equal(input().value, 'my unsent draft', 'the draft is kept');
  assert.match(textOf(panel()), /Why a cents helper\?.*And the pin test\?.*A third one Third answer\./, 'the thread is kept, and the open question caught up');
  dom.click(panel().querySelector('.ask-close'));
  assert.equal(panel().hidden, true, 'the close button closes it too');
  assert.equal(dom.document.activeElement, opener);
});

test('the panel: a finding is asked about by reference; a question that could not be sent can be sent again', async () => {
  const card = ask.askButton(ask.findingSubject('example', { id: 'EX-3', title: 'Totals in floats' }), { cls: 'btn small ghost', ariaLabel: 'Ask about EX-3' });
  dom.document.body.append(card);
  assert.equal(card.dataset.askKey, 'finding:example:EX-3');
  dom.click(card);
  assert.equal(panel().querySelector('.ask-title').textContent, 'Ask about EX-3');
  assert.equal(panel().querySelector('.ask-chip').textContent, 'EX-3 · Totals in floats');
  assert.doesNotMatch(textOf(panel()), /Why a cents helper/, 'each subject has its own thread');
  refuse = 'This project has no profile yet. Create one from the example first.';
  type('Is this real?');
  dom.click(sendButton());
  await settle(5);
  assert.deepEqual(posts()[posts().length - 1].body.context, { finding: { project: 'example', id: 'EX-3' } });
  assert.match(textOf(panel()), /Is this real\? This project has no profile yet\. Create one from the example first\. Ask again/);
  refuse = '';
  dom.click(panel().querySelectorAll('button').find(b => b.textContent === 'Ask again'));
  await settle(5);
  assert.deepEqual(posts()[posts().length - 1].body, { project: 'example', pipeline: 'explain', values: { what: 'Is this real?' }, context: { finding: { project: 'example', id: 'EX-3' } } });
  assert.match(textOf(panel()), /Is this real\?.*Answered/);
  assert.equal(card.getAttribute('aria-expanded'), 'true');
  dom.click(card);
  assert.equal(panel().hidden, true, 'the Ask button toggles the panel');
});

test('the panel: a route change closes it without moving the focus; a button that is not ready does nothing', async () => {
  const opener = dom.document.body.querySelector('.ask-open-btn');
  dom.click(opener);
  assert.equal(panel().hidden, false);
  dom.window.dispatchEvent(fakeEvent('hashchange'));
  assert.equal(panel().hidden, false, 'the same route again keeps it open');
  dom.location.hash = '#today';
  dom.window.dispatchEvent(fakeEvent('hashchange'));
  assert.equal(panel().hidden, true, 'another route closes it');
  assert.notEqual(dom.document.activeElement, opener);
  const notReady = ask.askButton(() => null);
  dom.document.body.append(notReady);
  dom.click(notReady);
  assert.equal(panel().hidden, true, 'no subject yet: nothing opens');
  assert.equal(ask.isAskOpen(), false);
});
