// The Ask panel (hub spec plan A7): an assistant next to the active work. On a run, its review
// gate or a finding, Ask opens this side panel; a question starts a read-only Explain run with
// that context, and the answer shows here as soon as it is there.
//
//   askButton(subject, opts)  the Ask button a view puts in its header or on a card. `subject` is
//       what is asked about, or a function that returns it at click time (null while the view is
//       still loading). It toggles the panel; aria-controls and aria-expanded follow it.
//   openAsk(subject, opener)  shows the panel for `subject` and moves the focus to the question box.
//   closeAsk()               hides it, stops following the run, and puts the focus back on the
//       button that opened it. Esc inside the panel and its close button do this, and a route
//       change closes it too (the panel belongs to the screen it was opened on).
//
// A subject is { kind: 'run', project, run, title, label: 'run' | 'review gate', route } or
// { kind: 'finding', project, finding, title, route }, where route is [view, sub] for the chip's
// link (runSubject and findingSubject build them). The page sends only a reference: POST /api/runs
// with { run } or { finding: { project, id } }, plus `after` (the previous question) for a
// follow-up; the server builds what Claude reads from its own records (runs/context.mjs).
//
// The thread (each question, its run and answer) and the text being typed are kept per subject
// while the page is open, so closing and opening the panel again loses nothing. The current
// question is followed with store.livePoll (GET /api/run, at once on a live signal for that run)
// until it ends; a one-second ticker moves its elapsed time. Closing stops both.
//
// The panel is one <aside> inside .app next to <main> (css/ask.css gives .app a third column while
// it is open), outside every view's section, so a view that repaints its header never takes the
// panel with it. Answers are text: `code` spans and path:line references become <code>, nothing
// else is parsed. The helpers above the DOM part are pure, for ui/parts/ask-panel.test.mjs.
import { api, fmtDuration, h, icon, keepFocus, keyed, qs, toast } from '../lib.js';
import { go, livePoll } from '../store.js';

export const PANEL_ID = 'ask-panel';
export const QUESTION_MAX = 600; // the Explain question's limit (runs/catalog.mjs)
export const SOURCES_SHOWN = 6;
const CHAT_ICON = '<path d="M20 12a8 8 0 0 1-11.5 7.2L4 20l1-4.3A8 8 0 1 1 20 12z"/><path d="M8.5 10.5h7M8.5 13.5h4.5"/>';
const PLACEHOLDERS = {
  run: 'e.g. what did this run change, and why?',
  'review gate': 'e.g. what could this change break?',
  finding: 'e.g. is this finding still real in the current code?',
};
const CLOSE_ICON = '<path d="M6 6l12 12M18 6 6 18"/>';
const asList = x => (Array.isArray(x) ? x : []);

// ---------------------------------------------------------------- pure helpers (tested)

export function runSubject(run, { review = false } = {}) {
  if (!run || !run.id) return null;
  return { kind: 'run', project: run.project, run: run.id, title: run.title || run.id, label: review ? 'review gate' : 'run', route: [review ? 'review' : 'run', run.id] };
}

export function findingSubject(project, f) {
  if (!project || !f || !f.id) return null;
  return { kind: 'finding', project, finding: f.id, title: f.title || '', route: ['project', `${project}/findings`] };
}

// The key a thread is kept under: "run:<id>" or "finding:<project>:<id>" ('' for no subject).
export function subjectKey(s) {
  if (!s) return '';
  if (s.kind === 'run' && s.run) return `run:${s.run}`;
  if (s.kind === 'finding' && s.project && s.finding) return `finding:${s.project}:${s.finding}`;
  return '';
}

// What the page sends: the reference alone, plus the previous question for a follow-up.
export function contextRef(s, after = '') {
  const ref = s.kind === 'finding' ? { finding: { project: s.project, id: s.finding } } : { run: s.run };
  return after ? { ...ref, after } : ref;
}

// The panel's heading ("Ask about this run", "Ask about EX-3") and the chip's words.
export const panelTitle = s => (s.kind === 'finding' ? `Ask about ${s.finding}` : `Ask about this ${s.label || 'run'}`);
export function chipText(s) {
  if (s.kind === 'finding') return s.title ? `${s.finding} · ${s.title}` : s.finding;
  return `${s.label === 'review gate' ? 'Review gate' : 'Run'} · ${s.title || s.run}`;
}

// The last question that reached the server (its run id is the next follow-up's `after`).
export const lastAsked = entries => [...asList(entries)].reverse().find(e => e && e.id) || null;

// A question still on its way: sending, or its run still running.
export const isMoving = e => !!e && (e.sending || (!!e.id && !e.missing && !e.error && (!e.run || e.run.status === 'running')));

// Why Ask can't send now ('' when it can): a question still on its way, or no text.
export function askBlock(entries, text) {
  const last = asList(entries)[asList(entries).length - 1];
  if (isMoving(last)) return 'Wait for the answer to the last question first.';
  if (!String(text || '').trim()) return 'Type a question first.';
  return '';
}

const actionOf = (run, name) => asList(run && run.actions).find(a => a && a.action === name) || null;
const reasonOf = run => String((run && (run.statusReason || (run.error && run.error.message))) || '').trim();

// Where a question is: { kind, text, since, action }. kind is sending, error, gone, queued,
// running, answered, failed, capped, paused, interrupted, cancelled or other; `since` is the time
// its clock counts from (queued and running); `action` the run action its button offers.
export function questionState(e) {
  if (!e) return { kind: 'none', text: '' };
  if (e.sending) return { kind: 'sending', text: 'Sending the question…' };
  if (e.error) return { kind: 'error', text: e.error };
  if (e.missing) return { kind: 'gone', text: 'This question\'s run is gone.' };
  const run = e.run;
  if (!run) return { kind: 'queued', text: 'Queued: waiting for a free Claude slot.', since: e.at };
  const stage = asList(run.stages)[0] || {};
  const why = reasonOf(run);
  switch (run.status) {
    case 'running':
      return stage.status === 'running'
        ? { kind: 'running', text: 'Claude is reading the code.', since: Date.parse(stage.startedAt || '') || Date.parse(run.createdAt || '') || e.at }
        : { kind: 'queued', text: 'Queued: waiting for a free Claude slot.', since: Date.parse(run.createdAt || '') || e.at };
    case 'passed': return { kind: 'answered', text: 'Answered.' };
    case 'failed': return { kind: 'failed', text: `Failed: ${why || 'the run failed.'}`, action: 'retry' };
    // The reason names the cap (turns, time or the budget backstop) itself.
    case 'capped': return { kind: 'capped', text: why ? `${why}${/[.!?]$/.test(why) ? '' : '.'}` : 'Stopped at a cap.', action: 'resume' };
    case 'paused-limit': return { kind: 'paused', text: `Paused: usage limit${why ? `. ${why}` : '.'} Resume it once the window has reset.`, action: 'resume' };
    case 'interrupted': return { kind: 'interrupted', text: `Interrupted${why ? `: ${why}` : '.'}`, action: 'retry' };
    case 'cancelled': return { kind: 'cancelled', text: 'Cancelled.' };
    default: return { kind: 'other', text: `The run is ${run.status}.` };
  }
}

// What the polite live region says when a question gets to a new state.
const LIVE_WORDS = {
  sending: 'Sending your question.', queued: 'Your question is queued.', running: 'Claude is reading the code.', answered: 'The answer is there.',
  failed: 'The question failed.', capped: 'The question stopped at a cap.', paused: 'The question is paused by the usage limit.',
  interrupted: 'The question was interrupted.', cancelled: 'The question was cancelled.', error: 'The question could not be sent.', gone: 'The question\'s run is gone.',
};

// Text split into plain parts and parts shown as code: `backtick` spans and path:line references
// (a path with a folder and a file extension, or a file name with :line). [{ text, code }].
const REF_RE = /`([^`\n]{1,300})`|((?:[\w@.-]+\/)+[\w@-][\w@.-]*\.[A-Za-z0-9]{1,8}(?::\d+(?:[-–]\d+)?)?|[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,7}:\d+(?:[-–]\d+)?)/g;
export function refParts(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  let at = 0;
  for (const m of s.matchAll(REF_RE)) {
    if (m.index > at) out.push({ text: s.slice(at, m.index), code: false });
    out.push({ text: m[1] !== undefined ? m[1] : m[2], code: true });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at), code: false });
  return out;
}

// ---------------------------------------------------------------- state

const threads = new Map(); // subject key -> { entries: [{ id, question, run, at, sending, error, missing }], draft }
let ui = null; // the panel's parts, built on the first open
let current = null; // { subject, key, opener, hash }
let stopPoll = null;
let ticker = null;
let following = null; // the entry being followed
let acting = ''; // a run action in flight ("retry:<id>")
let why = ''; // why the last Ask click sent nothing, until the next keystroke
const lastLive = new Map(); // entry -> the live words said last

function threadOf(key) {
  if (!threads.has(key)) threads.set(key, { entries: [], draft: '' });
  return threads.get(key);
}

export const isAskOpen = (key = '') => !!current && (!key || current.key === key);

// ---------------------------------------------------------------- building

function host() {
  return document.querySelector('.app') || document.body;
}

function build() {
  const title = h('h2', { id: 'ask-title', class: 'ask-title', tabindex: '-1' }, 'Ask');
  const close = h('button', { class: 'icon-btn ask-close', type: 'button', 'aria-label': 'Close the Ask panel', on: { click: () => closeAsk() } },
    icon(CLOSE_ICON), 'Close');
  const chip = h('p', { class: 'ask-about' });
  const thread = h('div', { class: 'ask-thread' }); // scrolls; holds the hint or the list of questions
  const live = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const label = h('label', { for: 'ask-input', class: 'ask-label' }, 'Your question');
  const input = h('textarea', {
    id: 'ask-input', rows: '3', maxlength: String(QUESTION_MAX), 'aria-describedby': 'ask-hint ask-why',
    on: { input: e => { if (current) threadOf(current.key).draft = e.target.value; why = ''; paintForm(); }, keydown: onInputKey },
  });
  const sendBtn = h('button', { class: 'btn primary ask-send', type: 'button', 'aria-describedby': 'ask-why', on: { click: () => ask() } }, 'Ask');
  const whyLine = h('p', { class: 'reason ask-why', id: 'ask-why', hidden: true });
  const form = h('div', { class: 'ask-form' }, label, input,
    h('div', { class: 'ask-actions' }, h('span', { class: 'muted small', id: 'ask-hint' }, 'Ctrl+Enter asks. Read-only: Claude reads, it changes nothing.'), sendBtn),
    whyLine);
  const root = h('aside', { id: PANEL_ID, class: 'ask-panel', role: 'complementary', 'aria-labelledby': 'ask-title', hidden: true },
    h('div', { class: 'ask-head' }, title, close), chip, thread, live, form);
  root.addEventListener('keydown', onPanelKey);
  window.addEventListener('hashchange', onRoute);
  host().append(root);
  ui = { root, title, chip, thread, live, label, input, send: sendBtn, why: whyLine };
}

function onPanelKey(e) {
  if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  closeAsk();
}

function onInputKey(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    ask();
  }
}

// A route change closes the panel; going to the same route again (store.go) does not.
function onRoute() {
  if (current && location.hash !== current.hash) closeAsk({ focus: false });
}

// ---------------------------------------------------------------- open and close

function setExpanded(key, on) {
  for (const b of document.querySelectorAll('[data-ask-key]')) b.setAttribute('aria-expanded', on && b.dataset.askKey === key ? 'true' : 'false');
  if (current && current.opener) current.opener.setAttribute('aria-expanded', on ? 'true' : 'false');
}

export function openAsk(subject, opener = null) {
  const key = subjectKey(subject);
  if (!key) return;
  if (!ui) build();
  if (current && current.key !== key) { stopFollowing(); setExpanded(current.key, false); }
  if (opener) opener.dataset.askKey = key;
  current = { subject, key, opener, hash: location.hash };
  ui.root.hidden = false;
  host().classList.add('ask-open');
  setExpanded(key, true);
  const thread = threadOf(key);
  ui.input.value = thread.draft;
  paint({ scroll: true });
  const last = thread.entries[thread.entries.length - 1];
  if (last && last.id && isMoving(last)) follow(last);
  ui.input.focus();
}

export function closeAsk({ focus = true } = {}) {
  if (!current) return;
  stopFollowing();
  const { key, opener } = current;
  setExpanded(key, false);
  current = null;
  if (ui) ui.root.hidden = true;
  host().classList.remove('ask-open');
  if (!focus) return;
  const target = opener && opener.isConnected ? opener : [...document.querySelectorAll('[data-ask-key]')].find(b => b.dataset.askKey === key);
  if (target) target.focus();
}

// The Ask button: toggles the panel for its subject.
export function askButton(subject, { label = 'Ask', cls = 'btn', ariaLabel = '' } = {}) {
  const get = typeof subject === 'function' ? subject : () => subject;
  const known = typeof subject === 'function' ? '' : subjectKey(subject);
  const b = h('button', {
    class: `${cls} ask-open-btn`, type: 'button', 'aria-controls': PANEL_ID, 'aria-expanded': known && isAskOpen(known) ? 'true' : 'false',
    'aria-label': ariaLabel || null, dataset: known ? { askKey: known } : null,
    on: { click: () => { const s = get(); if (!s) return; if (isAskOpen(subjectKey(s))) closeAsk(); else openAsk(s, b); } },
  }, icon(CHAT_ICON), label);
  return b;
}

// ---------------------------------------------------------------- asking and following

async function ask() {
  if (!current) return;
  const { subject, key } = current;
  const thread = threadOf(key);
  const question = ui.input.value.trim().slice(0, QUESTION_MAX);
  const block = askBlock(thread.entries, question);
  if (block) { why = block; paintForm(); ui.input.focus(); return; }
  why = '';
  const prev = lastAsked(thread.entries);
  const entry = { id: '', question, run: null, at: Date.now(), sending: true, error: '', missing: false };
  thread.entries.push(entry);
  thread.draft = '';
  ui.input.value = '';
  paint({ scroll: true });
  await send(entry, subject, prev ? prev.id : '');
  if (current && current.key === key) {
    paint({ scroll: true });
    if (entry.id) follow(entry);
  }
}

// POSTs one question (also again, after it could not be sent).
async function send(entry, subject, after) {
  entry.sending = true;
  entry.error = '';
  try {
    const r = await api('/api/runs', { method: 'POST', body: { project: subject.project, pipeline: 'explain', values: { what: entry.question }, context: contextRef(subject, after) } });
    entry.id = String(r.runId || '');
  } catch (e) {
    entry.error = e.message;
  }
  entry.sending = false;
  entry.at = Date.now();
}

function follow(entry) {
  stopFollowing();
  following = entry;
  stopPoll = livePoll(() => pull(entry), { runId: entry.id });
  ticker = setInterval(tick, 1000);
}

function stopFollowing() {
  if (stopPoll) stopPoll();
  stopPoll = null;
  clearInterval(ticker);
  ticker = null;
  following = null;
}

// One GET /api/run for the followed question. Resolves false to stop (it ended, or it is gone).
async function pull(entry) {
  if (following !== entry) return false;
  try {
    const r = await api(`/api/run?${qs({ id: entry.id, limit: 1 })}`);
    if (following !== entry) return false;
    if (r.run) entry.run = r.run;
  } catch (e) {
    if (following !== entry) return false;
    if (e.network) return true;
    if (e.status === 404 || e.status === 400) entry.missing = true;
    else { paint(); return true; }
  }
  const moving = isMoving(entry);
  if (!moving) { clearInterval(ticker); ticker = null; }
  paint({ scroll: !moving });
  return moving;
}

// Retry stage or Resume on the latest question's run, then follow it again (if its panel is still open).
async function runAction(entry, name) {
  if (acting || !current) return;
  const { key } = current;
  acting = `${name}:${entry.id}`;
  paint();
  try {
    const r = await api(`/api/runs/${name}`, { method: 'POST', body: { id: entry.id } });
    if (r.run) entry.run = r.run;
    toast(r.message || 'Done.');
  } catch (e) {
    toast(e.message, true);
  }
  acting = '';
  if (current && current.key === key) {
    paint();
    if (isMoving(entry)) follow(entry);
  }
}

// The question could not be sent: send it again as it was.
async function sendAgain(entry) {
  if (!current) return;
  const { subject, key } = current;
  const thread = threadOf(key);
  const before = thread.entries.slice(0, thread.entries.indexOf(entry));
  const prev = lastAsked(before);
  entry.sending = true;
  paint();
  await send(entry, subject, prev ? prev.id : '');
  if (current && current.key === key) {
    paint();
    if (entry.id) follow(entry);
  }
}

// ---------------------------------------------------------------- painting

// The question box: its label, and Ask off (still focusable, with its reason) while a question is
// on its way; the reason of a click that sent nothing shows until the next keystroke.
function paintForm() {
  if (!ui || !current) return;
  const entries = threadOf(current.key).entries;
  const busy = isMoving(entries[entries.length - 1]);
  ui.label.textContent = entries.length ? 'Follow-up question' : 'Your question';
  if (busy) ui.send.setAttribute('aria-disabled', 'true');
  else ui.send.removeAttribute('aria-disabled');
  const text = busy ? askBlock(entries, 'x') : why;
  ui.why.textContent = text;
  ui.why.hidden = !text;
}

function paint({ scroll = false } = {}) {
  if (!ui || !current) return;
  const { subject } = current;
  ui.title.textContent = panelTitle(subject);
  ui.input.setAttribute('placeholder', PLACEHOLDERS[subject.kind === 'finding' ? 'finding' : subject.label] || PLACEHOLDERS.run);
  ui.chip.replaceChildren(h('span', { class: 'muted small' }, 'About'), ' ',
    keyed(h('button', { class: 'chip ask-chip', type: 'button', title: chipText(subject), on: { click: () => go(...subject.route) } }, chipText(subject)), 'ask-chip'));
  const entries = threadOf(current.key).entries;
  keepFocus(ui.thread, () => ui.thread.replaceChildren(entries.length
    ? h('ol', { class: 'ask-list', 'aria-label': 'Questions and answers' }, entries.map((e, i) => item(e, i === entries.length - 1)))
    : h('p', { class: 'ask-empty muted' }, 'Ask about this ', subject.kind === 'finding' ? 'finding' : subject.label || 'run',
      ': Claude gets what the app knows about it and reads the code to answer. Follow-ups keep the thread.')));
  paintForm();
  announce(entries[entries.length - 1]);
  if (scroll) ui.thread.scrollTop = ui.thread.scrollHeight || 0;
}

// Says the latest question's state in the live region when it changed.
function announce(entry) {
  if (!entry) return;
  const words = LIVE_WORDS[questionState(entry).kind] || '';
  if (!words || lastLive.get(entry) === words) return;
  lastLive.set(entry, words);
  ui.live.textContent = words;
}

const elapsed = since => fmtDuration(Math.max(0, Date.now() - since)) || '0 s';

// Moves the clocks of the questions still on their way.
function tick() {
  if (!ui) return;
  for (const span of ui.thread.querySelectorAll('.ask-clock')) {
    const since = Number(span.dataset.since);
    if (Number.isFinite(since)) span.textContent = elapsed(since);
  }
}

// A path in <code> that may wrap after each "/" (and only there), so a long path:line keeps whole
// file names on a line.
const codeNode = text => h('code', {}, String(text).split('/').flatMap((s, i, all) => (i < all.length - 1 ? [`${s}/`, h('wbr')] : [s])));

function answerNodes(text) {
  return refParts(String(text || '').trim()).map(p => (p.code ? codeNode(p.text) : p.text));
}

// One question with its answer or its state; the buttons only on the latest one.
function item(e, latest) {
  const st = questionState(e);
  const parts = [h('p', { class: 'ask-q' }, h('span', { class: 'ask-who' }, 'You'), ' ', h('span', { class: 'ask-q-text' }, e.question))];
  const answer = e.run && e.run.outputs && e.run.outputs.answer;
  if (st.kind === 'answered') {
    const sources = asList(answer && answer.sources);
    parts.push(h('div', { class: 'ask-a' }, answerNodes(answer && answer.answer ? answer.answer : '(Claude gave no answer text.)')));
    if (sources.length) {
      parts.push(h('div', { class: 'ask-sources-box' }, h('p', { class: 'ask-sources-h' }, 'Sources'),
        h('ul', { class: 'ask-sources', 'aria-label': 'Sources' }, sources.slice(0, SOURCES_SHOWN).map(s => h('li', {},
          codeNode(`${s.path}${Number(s.line) > 0 ? `:${s.line}` : ''}`), s.note ? h('span', { class: 'muted' }, ` ${s.note}`) : null)),
        sources.length > SOURCES_SHOWN ? h('li', { class: 'muted' }, `+ ${sources.length - SOURCES_SHOWN} more in the full answer`) : null)));
    }
    const took = e.run && Number.isFinite(e.run.durationMs) ? ` in ${fmtDuration(e.run.durationMs)}` : '';
    parts.push(h('p', { class: 'ask-meta' }, `Answered${took} · `, openLink(e, 'Open the full answer')));
  } else {
    parts.push(stateNode(e, st, latest));
  }
  return h('li', { class: `ask-item is-${st.kind}` }, parts);
}

function openLink(e, text) {
  return keyed(h('button', { class: 'link', type: 'button', on: { click: () => go('run', e.id) } }, text), `ask-open:${e.id}`);
}

// The state line of a question that has no answer (yet): words, a clock, and its buttons.
function stateNode(e, st, latest) {
  if (st.kind === 'queued' || st.kind === 'running' || st.kind === 'sending') {
    return h('p', { class: 'ask-state' }, h('span', { class: 'ask-spin', 'aria-hidden': 'true' }), st.text,
      st.since ? [' ', h('span', { class: 'ask-clock muted', dataset: { since: String(st.since) } }, elapsed(st.since))] : null);
  }
  const cls = ['failed', 'error', 'gone', 'interrupted'].includes(st.kind) ? 'note red ask-state' : st.kind === 'cancelled' ? 'muted ask-state' : 'note ask-state';
  const buttons = [];
  if (latest && st.kind === 'error') {
    buttons.push(keyed(h('button', { class: 'btn small', type: 'button', on: { click: () => sendAgain(e) } }, 'Ask again'), `ask-again:${e.at}`));
  }
  if (latest && st.action && e.run) {
    const a = actionOf(e.run, st.action);
    const label = st.action === 'retry' ? 'Retry' : 'Resume';
    const busy = acting === `${st.action}:${e.id}`;
    if (a && a.enabled) buttons.push(keyed(h('button', { class: 'btn small', type: 'button', disabled: !!acting, on: { click: () => runAction(e, st.action) } }, busy ? `${label}…` : label), `ask-${st.action}:${e.id}`));
    else if (a && a.reason) buttons.push(h('span', { class: 'reason' }, `${label} is off: ${a.reason}`));
  }
  if (e.id && !e.missing) buttons.push(openLink(e, 'Open the run'));
  return h('div', { class: cls }, h('p', {}, st.text), buttons.length ? h('div', { class: 'row-actions ask-state-actions' }, buttons) : null);
}
