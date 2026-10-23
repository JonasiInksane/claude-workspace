// Today (#today), the start screen (SPEC 5.2; mockup #v-today). It answers "what needs me, what
// runs, what next" across every project with a private profile, from GET /api/today: the runs
// waiting at a gate or stopped (plus a smaller baseline or a findings import to apply), the
// running ones, Next up from the findings board, health per project, the inbox, recent results,
// and Today so far with the handoff note. The intent box on top opens the launcher. Nothing runs
// from this screen except /inbox-triage (a hub session, through /api/skill) and the handoff note
// (POST /api/today/handoff, written by code from run folders and git, no Claude).
//
// Today replaces the old dashboard (views/home.js): the inbox and the active reports are cards
// here; hub sessions, tool status, projects, assets (with Inbox images) and flows are in the
// sidebar. Its links to a project open that project's page at the tab that shows the thing.
//
// Rendering: the screen is built once, then patched card by card. render() runs on every store
// change, and rebuilding everything would wipe the text typed into the intent box and move the
// focus, so a card (or row) is rebuilt only when the data it shows changed (SPEC 5.11). Each part
// of the answer may fail on its own ({ error }); that card shows the reason in a .note and the
// others still render.
//
// Refresh (SPEC 5.10): on show, on window focus, when the nav counts change, shortly after a live
// signal, and every 10 s while the screen is visible and something runs. "Waiting for you"
// changes are announced (lib.js announce), except the plain waiting runs main.js already announces.
import { act, api, announce, fmtAgo, fmtDay, h, icon, keepFocus, keyed, openPlace, plural } from '../lib.js';
import { go, goProject, onSignal, openLauncher, parseHash, refresh, runningCount, state, waitingCount } from '../store.js';
import { intentBox } from '../parts/intent.js';
import { spark } from '../parts/sparkline.js';
import { badge, dot } from '../parts/status.js';

const POLL_MS = 10_000; // while visible and something runs (SPEC 5.10)
const SIGNAL_DELAY_MS = 1500; // a burst of live signals gives one load
const FOCUS_STALE_MS = 5000; // window focus reloads data older than this
const SEARCH_ICON = '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>';
const PLACEHOLDER = 'e.g. refactor the money math · fix a finding · why does a test fail?';
// Finding severity -> badge text and class (the text says it, so colour is never alone).
const SEVERITY = { critical: ['Critical', 'red'], high: ['High', 'red'], medium: ['Medium', 'amber'], low: ['Low', ''] };

let data = null; // the last answer of GET /api/today
let loadError = ''; // why the last load failed ('' when it worked)
let loading = null; // the load in flight (a Promise), or null
let again = false; // a load was asked for while one was in flight
let loadedAt = 0;
let visible = false;
let pollTimer = null;
let signalTimer = null;
let offSignal = null;
let lastCounts = ''; // "waiting|running" from /api/state at the last render
let knownWaits = null; // waitKey -> waiting item at the last load; null before the first
const busy = { triage: false, handoff: false };

let section = null; // the view's <section>
let root = null; // the built screen inside it
const parts = {}; // named containers in root
let intentSig = '';
const keyOf = new WeakMap(); // card or row element -> its key in its container
const sigOf = new WeakMap(); // card or row element -> the JSON of the model it shows

// ---------------------------------------------------------------- pure helpers (tested)

// "9 things wait for you · 1 running", "Nothing waits for you · nothing running".
export function headline(waiting, running) {
  const w = waiting ? `${waiting} ${waiting === 1 ? 'thing waits' : 'things wait'} for you` : 'Nothing waits for you';
  return `${w} · ${running ? `${running} running` : 'nothing running'}`;
}

// A change as text with a real minus sign: "+3", "−2", "±0". '' for no number.
export function deltaText(d) {
  if (typeof d !== 'number' || !Number.isFinite(d)) return '';
  return d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : '±0';
}

// The health score's week change, "+3 this week" (the trend class adds the colour), or ''.
export function trendText(score) {
  if (!score || score.value == null) return '';
  return score.delta ? `${deltaText(score.delta)} this week` : 'same as last week';
}

// "Node for checks": "20.15.1 (pinned)", "24.11.1 (project pins 20.15.1)", or just the active
// version when the profile pins none.
export function nodeText(node) {
  if (!node || !node.active) return 'not known';
  if (!node.pin) return node.active;
  return node.matches ? `${node.active} (pinned)` : `${node.active} (project pins ${node.pin})`;
}

// A waiting item's identity across loads. A run's key includes its status and gate, so a run that
// moves from one stop to another counts as a change.
export function waitKey(w) {
  if (!w) return '';
  if (w.runId) return `run:${w.runId}:${w.status || ''}:${w.waiting || ''}`;
  return `${w.kind || 'item'}:${w.project || ''}:${w.key || ''}`;
}

// What to announce when the waiting list changed from `before` to `now` (Maps of waitKey ->
// item), or ''. Runs that simply start or stop waiting at a gate are left out: main.js already
// announces those, and two announcements for one change would be noise.
export function waitingAnnouncement(before, now) {
  const shell = w => w.kind === 'run' && w.status === 'waiting';
  const added = [...now.keys()].filter(k => !before.has(k)).map(k => now.get(k)).filter(w => !shell(w));
  const removed = [...before.keys()].filter(k => !now.has(k)).map(k => before.get(k)).filter(w => !shell(w));
  if (!added.length && !removed.length) return '';
  const count = now.size ? `${plural(now.size, 'thing')} waiting for you.` : 'Nothing waits for you now.';
  return added.length === 1 ? `${added[0].title}: ${added[0].badge || 'needs you'}. ${count}` : count;
}

// The Try chips: four generic ones, then examples from Next up and the latest recent run.
export function chipsFor(d) {
  const chips = [
    { label: 'Refactor something', text: 'Refactor ' },
    { label: 'Fix a finding', text: 'Fix ' },
    { label: 'Why does … fail?', text: 'Why does ' },
    { label: 'Explain …', text: 'Explain how ' },
  ];
  const next = d && d.nextUp && !d.nextUp.error && d.nextUp.id ? d.nextUp : null;
  if (next) chips.push({ label: `Fix ${next.id}`, text: `Fix ${next.id}: ${next.title || ''}`.trim() });
  const recent = d && Array.isArray(d.recent) ? d.recent.find(r => r && r.title && r.title !== r.runId) : null;
  if (recent) chips.push({ label: shorten(recent.title, 40), text: recent.title });
  return chips;
}

export function shorten(text, max) {
  const t = String(text || '');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// A running row's meta line: { bits, branch } (the branch shows as code). Stage, round (from the
// second fix round on, as the server does), turns, minutes and the tree; the server's own `sub`
// text when the row has none of these fields.
export function runningMeta(r, { withProject = false } = {}) {
  const lead = withProject && r.label ? [r.label] : [];
  const bits = [];
  if (r.stageLabel || r.stage) bits.push(r.stageLabel || r.stage);
  if (Number.isInteger(r.round) && r.round > 1) bits.push(`round ${r.round}`);
  if (Number.isFinite(r.turns)) bits.push(`turns ${r.turns}${Number.isFinite(r.maxTurns) ? `/${r.maxTurns}` : ''}`);
  if (Number.isFinite(r.minutes)) bits.push(`${r.minutes} min`);
  if (r.tree) bits.push(r.tree);
  if (!bits.length) return { bits: [...lead, r.sub || ''].filter(Boolean), branch: '' };
  return { bits: [...lead, ...bits], branch: r.branch || '' };
}

// A server action href ("#run/<id>", "#project/<name>/checks") as a route, or null when it isn't
// one. An old route ("#cockpit/<name>") reads as the route that replaced it (store.parseHash).
export function routeOfHref(href) {
  if (typeof href !== 'string' || !/^#[a-z][a-z0-9-]*(\/|$)/.test(href)) return null;
  return parseHash(href);
}

// ---------------------------------------------------------------- loading

async function load() {
  if (loading) { again = true; return loading; }
  loading = (async () => {
    try {
      const next = await api('/api/today');
      noteWaitingChanges(next);
      data = next;
      loadError = '';
    } catch (e) {
      loadError = e.message || 'Could not load Today.';
    }
    loadedAt = Date.now();
  })();
  await loading;
  loading = null;
  if (visible && section) keepFocus(section, update);
  if (again) { again = false; load(); }
}

// One load a moment later; more calls meanwhile join it.
function soon(ms = SIGNAL_DELAY_MS) {
  if (signalTimer) return;
  signalTimer = setTimeout(() => { signalTimer = null; if (visible) load(); }, ms);
}

function noteWaitingChanges(next) {
  const now = new Map((Array.isArray(next.waiting) ? next.waiting : []).map(w => [waitKey(w), w]));
  const before = knownWaits;
  knownWaits = now;
  if (!before || !visible) return;
  const text = waitingAnnouncement(before, now);
  if (text) announce(text);
}

const someRunning = () => (data && Array.isArray(data.running) && data.running.length > 0) || runningCount() > 0;

function onFocus() {
  if (visible && Date.now() - loadedAt > FOCUS_STALE_MS) load();
}

// ---------------------------------------------------------------- patching

// Puts items ([{ key, model, build(model) }]) into `box`. An element is built again only when
// its model changed; unchanged ones stay in place, so the focus and typed text stay put.
function patch(box, items) {
  const old = new Map();
  for (const c of box.children) if (keyOf.has(c)) old.set(keyOf.get(c), c);
  const next = items.map(it => {
    const sig = JSON.stringify(it.model);
    const prev = old.get(it.key);
    if (prev && sigOf.get(prev) === sig) return prev;
    const el = it.build(it.model);
    keyOf.set(el, it.key);
    sigOf.set(el, sig);
    if (prev) prev.replaceWith(el);
    return el;
  });
  const kids = [...box.children];
  if (kids.length !== next.length || next.some((n, i) => kids[i] !== n)) box.replaceChildren(...next);
}

// A part of the answer: undefined while loading, { error } when it failed, else the value.
function partOf(name) {
  if (!data) return loadError ? { error: 'Not loaded.' } : undefined;
  return data[name];
}
const isError = v => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.error === 'string';

// Goes where a server action points (only hash routes of this app).
function follow(href) {
  const r = routeOfHref(href);
  if (r) go(r.id, r.sub);
}

// ---------------------------------------------------------------- building blocks

const card = (title, headExtra, body, foot) => h('div', { class: 'card' },
  h('div', { class: 'card-head' }, h('h3', {}, title), headExtra || null),
  h('div', { class: 'card-body' }, body),
  foot ? h('div', { class: 'card-foot' }, foot) : null);

const loadingText = () => h('p', { class: 'muted' }, 'Loading…');
const errorNote = text => h('p', { class: 'note red' }, text);

// A count in a section heading: hidden from screen readers, which get their own words.
const headCount = (n, cls, words) => [h('span', { class: `badge ${cls}`, 'aria-hidden': 'true' }, String(n)), h('span', { class: 'sr-only' }, `, ${words}`)];

// A button whose disabled reason is visible text next to it (SPEC 5.11). Returns [button, reason].
// `busy`: the button's own request is under way. It stays focusable (aria-disabled) so the focus
// doesn't drop to the page while the card is redrawn; its click handler ignores the click.
let reasonIds = 0;
function withReason(button, reason, { busy = false } = {}) {
  if (!reason) return [button, null];
  const id = `today-why-${++reasonIds}`;
  if (busy) button.setAttribute('aria-disabled', 'true');
  else button.disabled = true;
  button.setAttribute('aria-describedby', id);
  return [button, h('span', { class: 'reason', id }, reason)];
}

// ---------------------------------------------------------------- the screen

function build(el) {
  if (root && root.parentNode === el) return;
  parts.date = h('p');
  parts.notices = h('div', { class: 'today-notices' });
  parts.intent = h('div');
  parts.waitCount = h('span', { class: 'today-count' });
  parts.waiting = h('ul', { class: 'rows' });
  parts.waitNone = h('p', { class: 'muted today-none' });
  parts.runCount = h('span', { class: 'today-count' });
  parts.running = h('ul', { class: 'rows' });
  parts.runNone = h('p', { class: 'muted today-none' });
  parts.grid3 = h('div', { class: 'grid3 mt-5 today-cards' });
  parts.grid2 = h('div', { class: 'grid2 mt-4 today-results' });
  parts.more = h('div', { class: 'grid2 mt-4 today-reports' });
  intentSig = '';
  root = h('div', { class: 'today' },
    h('div', { class: 'view-head' },
      h('div', {}, h('h2', { tabindex: '-1' }, 'Today'), parts.date),
      h('button', {
        class: 'btn', type: 'button', 'aria-keyshortcuts': 'Control+K',
        // Loaded on use: the palette pulls in the dialogs (and main.js has loaded it already).
        on: { click: () => import('../parts/palette.js').then(m => m.openPalette()) },
      }, icon(SEARCH_ICON), 'Jump to', h('kbd', {}, 'Ctrl K'))),
    parts.notices,
    parts.intent,
    h('h3', { class: 'sec' }, 'Waiting for you', parts.waitCount),
    parts.waiting, parts.waitNone,
    h('h3', { class: 'sec' }, 'Running', parts.runCount),
    parts.running, parts.runNone,
    parts.grid3,
    parts.grid2,
    parts.more);
  el.replaceChildren(root);
}

function update() {
  if (!root) return;
  const waiting = Array.isArray(partOf('waiting')) ? data.waiting : [];
  const running = Array.isArray(partOf('running')) ? data.running : [];
  const day = (data && data.date) || (state && state.today) || '';
  parts.date.textContent = [day ? fmtDay(day) : '', data ? headline(waiting.length, running.length) : ''].filter(Boolean).join(' · ');
  updateNotices();
  updateIntent();
  updateWaiting(waiting);
  updateRunning(running);
  patch(parts.grid3, [nextItem(), ...healthItems(), inboxItem()]);
  patch(parts.grid2, [recentItem(), soFarItem()]);
  patch(parts.more, [reportsItem()]);
}

// A failed load (with Try again), and a card for every profiled project whose checkout isn't here.
function updateNotices() {
  const items = [];
  if (loadError) {
    items.push({
      key: 'error', model: { loadError, had: !!data },
      build: m => h('div', { class: 'note red today-notice' },
        m.had ? `Could not refresh Today: ${m.loadError} What you see may be out of date. ` : `Could not load Today: ${m.loadError} `,
        keyed(h('button', { class: 'btn small', type: 'button', on: { click: () => load() } }, 'Try again'), 'retry')),
    });
  }
  const projects = data && Array.isArray(data.projects) ? data.projects : [];
  for (const p of projects.filter(x => x && x.present === false)) {
    items.push({
      key: `link:${p.name}`, model: { name: p.name, label: p.label || p.name },
      build: m => h('div', { class: 'card today-notice' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Link your existing checkout'), h('span', { class: 'badge amber' }, 'Setup')),
        h('div', { class: 'card-body' }, h('p', {}, `${m.label} has a profile, but projects/${m.name} is not in this workspace yet. `,
          'Link the checkout you already have (nothing in it changes), or clone it, in Projects.')),
        h('div', { class: 'card-foot' },
          keyed(h('button', { class: 'btn primary small', type: 'button', on: { click: () => go('projects') } }, 'Open Projects'), `link:${m.name}`))),
    });
  }
  patch(parts.notices, items);
}

// The intent box is kept while its chips stay the same; a new one takes over the typed text.
function updateIntent() {
  const chips = chipsFor(data);
  const sig = JSON.stringify(chips);
  if (sig === intentSig && parts.intent.firstChild) return;
  intentSig = sig;
  const old = parts.intent.querySelector('input');
  const typed = old ? old.value : '';
  const hadFocus = !!old && document.activeElement === old;
  const box = intentBox({ label: 'What do you want to do?', placeholder: PLACEHOLDER, chips });
  const input = box.querySelector('input');
  parts.intent.replaceChildren(box);
  if (typed) {
    input.value = typed;
    input.dispatchEvent(new Event('input'));
  }
  if (hadFocus) input.focus({ preventScroll: true });
}

function updateWaiting(list) {
  const p = partOf('waiting');
  parts.waitCount.replaceChildren(...(data && list.length ? headCount(list.length, 'amber', `${list.length} waiting`) : []));
  patch(parts.waiting, list.map(w => ({ key: waitKey(w), model: waitModel(w), build: waitRow })));
  parts.waiting.hidden = !list.length;
  parts.waitNone.hidden = !!list.length;
  parts.waitNone.textContent = p === undefined ? 'Loading…' : isError(p) ? `Could not load what waits: ${p.error}` : 'Nothing waits for you.';
}

function waitModel(w) {
  return {
    key: waitKey(w), status: w.kind === 'run' ? w.status || 'waiting' : 'waiting', title: w.title || w.runId || '',
    sub: [w.sub, w.since ? fmtAgo(w.since) : ''].filter(Boolean).join(' · '), badge: w.badge || 'Needs you',
    label: (w.action && w.action.label) || 'Open', href: (w.action && w.action.href) || '',
  };
}

function waitRow(m) {
  return keyed(h('li', { class: 'row waiting' },
    dot(m.status),
    h('div', { class: 'main' }, h('div', { class: 'title' }, m.title), h('div', { class: 'sub' }, m.sub)),
    badge(m.status, m.badge),
    m.href ? h('button', { class: 'btn small', type: 'button', 'aria-label': `${m.label}: ${m.title}`, on: { click: () => follow(m.href) } }, m.label) : null),
  `w:${m.key}`);
}

function updateRunning(list) {
  const p = partOf('running');
  const many = !!data && Array.isArray(data.projects) && data.projects.length > 1;
  parts.runCount.replaceChildren(...(data && list.length ? headCount(list.length, 'blue', `${list.length} running`) : []));
  patch(parts.running, list.map(r => ({
    key: r.runId || r.title,
    model: { id: r.runId || '', status: r.status || 'running', title: r.title || r.runId || '', meta: runningMeta(r, { withProject: many }), href: (r.action && r.action.href) || '' },
    build: runRow,
  })));
  parts.running.hidden = !list.length;
  parts.runNone.hidden = !!list.length;
  parts.runNone.textContent = p === undefined ? 'Loading…' : isError(p) ? `Could not load what runs: ${p.error}` : 'Nothing is running.';
}

function runRow(m) {
  const sub = h('div', { class: 'sub' }, m.meta.bits.join(' · '), m.meta.branch ? [m.meta.bits.length ? ' · ' : '', h('code', {}, m.meta.branch)] : null);
  return keyed(h('li', { class: 'row running' },
    dot(m.status),
    h('div', { class: 'main' }, h('div', { class: 'title' }, m.title), sub),
    badge(m.status),
    m.href ? h('button', { class: 'btn small', type: 'button', 'aria-label': `Open: ${m.title}`, on: { click: () => follow(m.href) } }, 'Open') : null),
  `r:${m.id || m.title}`);
}

// ---------------------------------------------------------------- the grid3 cards

function nextItem() {
  const n = partOf('nextUp');
  const projects = data && Array.isArray(data.projects) ? data.projects : [];
  const model = n === undefined ? { state: 'loading' }
    : isError(n) ? { state: 'error', error: n.error }
      : n ? { state: 'ok', id: n.id, title: n.title || '', severity: n.severity || '', meta: n.meta || n.estimateText || '', project: n.project, label: n.label || n.project, many: projects.length > 1 }
        : { state: 'none', project: (projects.find(p => p.present) || {}).name || '' };
  return { key: 'next', model, build: nextCard };
}

function nextCard(m) {
  if (m.state === 'loading') return card('Next up', null, loadingText());
  if (m.state === 'error') return card('Next up', null, errorNote(m.error));
  if (m.state === 'none') {
    return card('Next up', null,
      h('p', { class: 'muted' }, m.project ? 'Nothing is open on the findings board. Import an audit or reconcile on the project\'s Findings tab.'
        : 'Next up comes from a project\'s findings board, once a project has a private profile.'),
      m.project ? keyed(h('button', { class: 'link', type: 'button', on: { click: () => goProject(m.project, 'findings') } }, 'See the audit board'), 'next-board') : null);
  }
  const [label, cls] = SEVERITY[m.severity] || [m.severity || 'Severity unknown', ''];
  return card('Next up', h('span', { class: cls ? `badge ${cls}` : 'badge' }, label),
    [h('p', {}, h('code', {}, m.id), ' ', h('b', {}, m.title)),
      m.meta || m.many ? h('p', { class: 'muted small mt-2' }, [m.many ? m.label : '', m.meta].filter(Boolean).join(' · ')) : null],
    [keyed(h('button', {
      class: 'btn primary small', type: 'button',
      on: { click: () => openLauncher('fix', { project: m.project, findingId: m.id, what: `Fix ${m.id}: ${m.title}`.trim() }) },
    }, 'Start fix'), 'next-start'),
    keyed(h('button', { class: 'link push', type: 'button', on: { click: () => goProject(m.project, 'findings') } }, 'See the audit board'), 'next-board')]);
}

function healthItems() {
  const list = partOf('health');
  if (list === undefined) return [{ key: 'health', model: { state: 'loading' }, build: () => card('Health', null, loadingText()) }];
  if (isError(list)) return [{ key: 'health', model: { state: 'error', error: list.error }, build: m => card('Health', null, errorNote(m.error)) }];
  if (!Array.isArray(list) || !list.length) {
    return [{
      key: 'health', model: { state: 'none' },
      build: () => card('Health', null, h('p', { class: 'muted' }, 'Health shows here for every project with a private profile.')),
    }];
  }
  return list.map((x, i) => (isError(x)
    ? { key: `health:#${i}`, model: { state: 'error', error: x.error }, build: m => card('Health', null, errorNote(m.error)) }
    : { key: `health:${x.project}`, model: healthModel(x), build: healthCard }));
}

function healthModel(x) {
  const s = x.score || {};
  const kf = x.knownFailures;
  return {
    project: x.project, label: x.label || x.project, linked: x.linked !== false, valid: x.valid !== false,
    score: s.value ?? null, trend: s.trend || 'same', trendText: trendText(s), spark: Array.isArray(s.spark) ? s.spark : [],
    known: kf ? `${kf.value}${kf.new != null ? ` · ${kf.new} new` : ''}` : 'no checks yet',
    node: nodeText(x.node), scanned: x.lastScanAt ? fmtAgo(x.lastScanAt) : '',
  };
}

function healthCard(m) {
  const sp = m.spark;
  const body = [];
  if (m.score != null) {
    body.push(h('div', { class: 'big' }, String(m.score)));
    if (sp.length) body.push(spark(sp, `Health score over the last ${plural(sp.length, 'scan')}: ${sp[0]} to ${sp[sp.length - 1]}`));
  } else {
    body.push(h('p', { class: 'muted small today-noscan' }, 'No scan yet. Run the architecture check on the project\'s Architecture tab (free, 1-3 min).'));
  }
  body.push(
    h('div', { class: 'kv' }, h('span', { class: 'muted' }, 'Known test failures'), h('b', {}, m.known)),
    h('div', { class: 'kv' }, h('span', { class: 'muted' }, 'Node for checks'), h('b', {}, m.node)));
  if (!m.linked) body.push(h('p', { class: 'note mt-2' }, 'The checkout is not linked yet, so checks and scans can\'t run.'));
  if (!m.valid) body.push(h('p', { class: 'note mt-2' }, 'The profile has errors. The project\'s Overview and Settings tabs list them.'));
  return card(`${m.label} health`, m.trendText ? h('span', { class: `trend ${m.trend}` }, m.trendText) : null, body,
    [keyed(h('button', { class: 'link', type: 'button', on: { click: () => goProject(m.project, 'architecture') } }, 'Open Architecture'), `health:${m.project}`),
      m.scanned ? h('span', { class: 'push small' }, `Last scan ${m.scanned}`) : null]);
}

// The inbox: groups from /api/today, the scan error and agent images from /api/state.
function inboxItem() {
  const box = partOf('inbox');
  const s = state && state.inbox ? state.inbox : null;
  const libs = s && Array.isArray(s.libraries) ? s.libraries : [];
  const failed = isError(box) || !box;
  const model = box === undefined ? { state: 'loading' } : {
    state: 'ok', error: isError(box) ? box.error : '',
    total: failed ? (s ? s.total : 0) : box.total || 0, truncated: !!(failed ? s && s.truncated : box.truncated),
    groups: !failed && Array.isArray(box.groups) ? box.groups.map(g => ({ folder: g.folder, text: g.text, ago: g.newest ? fmtAgo(g.newest) : '' })) : [],
    scanError: (s && s.error) || '', libFiles: libs.reduce((n, l) => n + (Number(l.files) || 0), 0), libFolders: libs.length,
    claude: !!(state && state.tools && state.tools.claude), busy: busy.triage,
  };
  return { key: 'inbox', model, build: inboxCard };
}

function inboxCard(m) {
  if (m.state === 'loading') return card('Inbox', null, loadingText());
  const count = `${m.total}${m.truncated ? '+' : ''}`;
  const body = [];
  if (m.error) body.push(errorNote(`Could not group the inbox: ${m.error}`));
  if (m.scanError) body.push(errorNote(m.scanError));
  if (m.truncated) body.push(h('p', { class: 'muted small' }, 'Only part of the inbox was scanned (too deep or too many files).'));
  if (m.groups.length) {
    body.push(h('ul', { class: 'list' }, m.groups.map(g => h('li', {},
      h('div', { class: 'main' }, h('div', { class: 'title' }, g.text), h('div', { class: 'sub' }, [g.folder, g.ago].filter(Boolean).join(' · ')))))));
  } else if (!m.error && !m.total) {
    body.push(h('div', { class: 'empty' }, h('b', {}, 'Inbox zero'), 'Drop notes, links and screenshots in inbox/, or paste images in Inbox images (under Assets).'));
  }
  if (m.libFiles) body.push(h('p', { class: 'muted small mt-2' }, `Agent images (not triage items): ${plural(m.libFiles, 'file')} in ${plural(m.libFolders, 'folder')}.`));
  const why = !m.claude ? 'Claude Code was not found, so Triage is off.' : !m.total ? 'Nothing to triage.' : m.busy ? 'Starting /inbox-triage…' : '';
  const [triage, reason] = withReason(keyed(h('button', { class: 'btn small', type: 'button', on: { click: startTriage } }, 'Triage'), 'triage'), why,
    { busy: m.claude && !!m.total && m.busy });
  return card('Inbox', h('span', { class: 'badge' }, `${count} ${m.total === 1 ? 'item' : 'items'}`), body,
    [triage, reason,
      keyed(h('button', { class: 'btn small ghost push', type: 'button', on: { click: () => openPlace({ place: 'inbox' }) } }, 'Open folder'), 'inbox-folder')]);
}

// Starts /inbox-triage in a hub session (a new terminal); it proposes a filing plan and waits.
async function startTriage() {
  if (busy.triage) return;
  busy.triage = true;
  keepFocus(section, update);
  await act(api('/api/skill', { method: 'POST', body: { id: 'inbox-triage' } }));
  busy.triage = false;
  keepFocus(section, update);
}

// ---------------------------------------------------------------- the grid2 cards

function recentItem() {
  const list = partOf('recent');
  const nothing = !!data && !(Array.isArray(data.waiting) && data.waiting.length) && !(Array.isArray(data.running) && data.running.length);
  const model = list === undefined ? { state: 'loading' } : isError(list) ? { state: 'error', error: list.error } : {
    state: 'ok', nothing,
    rows: (Array.isArray(list) ? list : []).map(r => ({
      id: r.runId || '', title: r.title || r.runId || '', status: r.status || '', badge: r.badge || '',
      sub: [r.sub, r.at ? fmtAgo(r.at) : ''].filter(Boolean).join(' · '), href: (r.action && r.action.href) || '',
    })),
  };
  return { key: 'recent', model, build: recentCard };
}

function recentCard(m) {
  if (m.state === 'loading') return card('Recent results', null, loadingText());
  if (m.state === 'error') return card('Recent results', null, errorNote(m.error));
  if (!m.rows.length) {
    // SPEC 5.2 empty state: no runs at all yet.
    return card('Recent results', null, m.nothing
      ? h('div', { class: 'empty' }, h('b', {}, 'No runs yet.'), 'Try Explain: 3 minutes, read-only.',
        h('div', { class: 'mt-3' }, keyed(h('button', { class: 'btn small', type: 'button', on: { click: () => openLauncher('explain') } }, 'Try Explain'), 'try-explain')))
      : h('p', { class: 'muted' }, 'No finished runs yet.'));
  }
  return card('Recent results', null, h('ul', { class: 'list' }, m.rows.map(r => keyed(h('li', {},
    dot(r.status),
    h('div', { class: 'main' }, h('div', { class: 'title', title: r.title }, r.title), h('div', { class: 'sub', title: r.sub }, r.sub)),
    badge(r.status, r.badge),
    r.href ? h('button', { class: 'btn small ghost', type: 'button', 'aria-label': `Open: ${r.title}`, on: { click: () => follow(r.href) } }, 'Open') : null),
  `recent:${r.id}`))));
}

function soFarItem() {
  const t = partOf('todaySoFar');
  const win = data && data.lastWin && !isError(data.lastWin) ? data.lastWin : null;
  const many = !!data && Array.isArray(data.projects) && data.projects.length > 1;
  const model = t === undefined ? { state: 'loading' } : isError(t) ? { state: 'error', error: t.error } : !t ? { state: 'none' } : {
    state: 'ok', project: t.project, label: many ? t.label || t.project : '',
    slices: t.slicesCommitted ?? 0, runs: t.runs ?? 0, health: deltaText(t.healthDelta), newFailures: t.newFailures ?? null,
    win: (t.lastWin && t.lastWin.text) || (win && win.text) || '', warnings: Array.isArray(t.warnings) ? t.warnings : [], busy: busy.handoff,
  };
  return { key: 'sofar', model, build: soFarCard };
}

const stat = (value, label, sr = '') => h('div', {}, h('b', {}, value), h('span', {}, label, sr ? h('span', { class: 'sr-only' }, sr) : null));

function soFarCard(m) {
  const head = h('span', { class: 'muted small' }, m.label ? `${m.label} · from run folders and git` : 'from run folders and git');
  if (m.state === 'loading') return card('Today so far', head, loadingText());
  if (m.state === 'error') return card('Today so far', head, errorNote(m.error));
  if (m.state === 'none') {
    const [button, reason] = withReason(h('button', { class: 'btn small', type: 'button' }, 'Write handoff'), 'No project with a profile yet.');
    return card('Today so far', head, h('p', { class: 'muted' }, 'Today so far counts the work in a project with a private profile.'), [button, reason]);
  }
  const body = [
    h('div', { class: 'today-stats' },
      stat(String(m.slices), m.slices === 1 ? 'slice committed' : 'slices committed'),
      stat(String(m.runs), m.runs === 1 ? 'run' : 'runs'),
      m.health ? stat(m.health, 'health') : stat('–', 'health', ': no scan today'),
      m.newFailures == null ? stat('–', 'new failures', ': no checks yet') : stat(String(m.newFailures), m.newFailures === 1 ? 'new failure' : 'new failures')),
    h('p', { class: 'muted small mt-3' }, m.win ? `Last win: ${m.win}` : 'No wins recorded yet.'),
    m.warnings.map(w => h('p', { class: 'note small mt-2' }, w)),
  ];
  const [button, reason] = withReason(keyed(h('button', { class: 'btn small', type: 'button', on: { click: () => writeHandoff(m.project) } }, 'Write handoff'), 'handoff'),
    m.busy ? 'Writing the note…' : '', { busy: m.busy });
  return card('Today so far', head, body,
    [button, reason, h('span', { class: 'push small' }, 'Saved to inbox/handoffs/, written by code (no Claude).')]);
}

// Writes the end-of-day handoff note for the focus project; the toast names the file.
async function writeHandoff(project) {
  if (busy.handoff || !project) return;
  busy.handoff = true;
  keepFocus(section, update);
  const r = await act(api('/api/today/handoff', { method: 'POST', body: { project } }));
  busy.handoff = false;
  keepFocus(section, update);
  if (r) { refresh(); load(); }
}

// ---------------------------------------------------------------- active reports (from the old dashboard)

function reportsItem() {
  const reports = state && Array.isArray(state.reports) ? state.reports : [];
  const model = reports.map(r => ({ id: r.id, title: r.title, sub: [r.type, r.project || 'hub', r.updated ? `updated ${r.updated}` : ''].filter(Boolean).join(' · ') }));
  return {
    key: 'reports', model,
    build: rows => card('Active reports', rows.length ? h('span', { class: 'badge' }, plural(rows.length, 'report')) : null,
      rows.length ? h('ul', { class: 'list' }, rows.map(r => keyed(h('li', {},
        h('div', { class: 'main' }, h('div', { class: 'title', title: r.title }, r.title), h('div', { class: 'sub' }, r.sub)),
        h('button', { class: 'btn small', type: 'button', 'aria-label': `Open the folder of ${r.title}`, on: { click: () => openPlace({ place: 'report', report: r.id }) } }, 'Folder')),
      `report:${r.id}`)))
        : h('p', { class: 'muted' }, 'No active reports.')),
  };
}

// ---------------------------------------------------------------- the view

function render(el) {
  section = el;
  build(el);
  update();
  // A run started waiting, finished or began: the nav counts moved, so load Today again soon.
  const counts = `${waitingCount()}|${runningCount()}`;
  if (visible && lastCounts && counts !== lastCounts) soon();
  lastCounts = counts;
}

function onShow() {
  visible = true;
  load();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden && someRunning()) load(); }, POLL_MS);
  if (offSignal) offSignal();
  offSignal = onSignal(sig => { if (!sig.tick) soon(); });
  window.addEventListener('focus', onFocus);
}

function onHide() {
  visible = false;
  clearInterval(pollTimer);
  clearTimeout(signalTimer);
  pollTimer = null;
  signalTimer = null;
  if (offSignal) offSignal();
  offSignal = null;
  window.removeEventListener('focus', onFocus);
}

export default {
  id: 'today',
  label: 'Today',
  icon: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  render,
  onShow,
  onHide,
};
