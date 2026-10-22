// The live run's stage list and timeline (SPEC 5.6, mockup #v-run: ol.stages and ol.log).
//
// The stage list shows every stage of the pipeline with an icon, its name, a meta line (who,
// model and effort, turns, how long) and its state in words ("Done", "Needs you"). Each stage is
// a toggle button: picking one filters the timeline to that stage, picking it again shows all.
//
// The timeline is one row per event, "time · kind · message", built only from text. Rows come
// in order from GET /api/run?since (each has a seq), so the list only grows: append() adds the
// new ones, and a tool's end row updates the row its start row made (same tool id) instead of
// adding a second line. The toggles hide Claude's text, the tool rows (with denials) and the
// gate rows; Follow keeps the newest row in view unless you are reading a row (focus on it).
// Replay (finished runs) re-renders the stored rows up to the scrubber's position, and Play
// steps through them at ten times the recorded pace. Raw events never reach the page: the
// server sends redacted, capped rows. The pure helpers at the top are exported for tests.
import { fmtClock, fmtDuration, h, keyed } from '../lib.js';

const asList = x => (Array.isArray(x) ? x : []);

// ---------------------------------------------------------------- pure helpers

// Row kind -> the word in the kind column (runs/store.mjs ROW_KINDS).
export const KIND_LABELS = {
  text: 'Claude', tool: 'Tool', deny: 'Denied', result: 'Result', gate: 'Gate', stage: 'Stage',
  you: 'You', status: 'Status', info: 'Info', error: 'Error',
};
export const kindLabel = kind => (Object.prototype.hasOwnProperty.call(KIND_LABELS, kind) ? KIND_LABELS[kind] : String(kind || 'Info'));

// The filter group a row belongs to: the toggles hide 'text', 'tool' (tools and denials) and
// 'gate'; every other kind always shows.
export function kindGroup(kind) {
  if (kind === 'text') return 'text';
  if (kind === 'tool' || kind === 'deny') return 'tool';
  if (kind === 'gate') return 'gate';
  return 'other';
}

// The state word after a row's message: a tool still at work, or anything that failed. The
// colour of a row is never the only sign: the word says it too.
export function rowState(row) {
  if (!row) return '';
  if (row.tool && row.tool.phase === 'start') return 'running';
  if (row.ok === false) return 'failed';
  return '';
}

// Folds rows for display: a tool's end row takes the place of its start row (same tool id),
// so each tool call is one line. Returns new row objects in display order.
export function foldRows(rows) {
  const out = [];
  const at = new Map();
  for (const row of asList(rows)) {
    if (!row || typeof row !== 'object') continue;
    const id = row.tool && row.tool.id;
    if (id && at.has(id)) { out[at.get(id)] = row; continue; }
    if (id) at.set(id, out.length);
    out.push(row);
  }
  return out;
}

// How long Play waits before the next row: the recorded gap divided by `speed`, kept between
// 40 ms and 1.5 s so a long stage doesn't stall the replay and a burst stays readable.
export function replayDelay(prev, next, speed = 10) {
  const a = Date.parse(prev && prev.t);
  const b = Date.parse(next && next.t);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 120;
  return Math.max(40, Math.min(1500, Math.round((b - a) / speed)));
}

// Stage status -> [state word, class, icon]. The icon is decoration; the word is the state.
const STAGE_STATES = {
  done: ['Done', 'done', '✓'],
  running: ['Running', 'running', '▶'],
  waiting: ['Needs you', 'waiting', '●'],
  pending: ['Not started', 'pending', '○'],
  failed: ['Failed', 'stopped', '✕'],
  cancelled: ['Stopped', 'stopped', '■'],
  skipped: ['Skipped', 'skipped', '–'],
  capped: ['Capped', 'waiting', '◐'],
  interrupted: ['Interrupted', 'waiting', '‖'],
  'paused-limit': ['Paused', 'waiting', '‖'],
};
// The state of one stage as the list shows it; a waiting stage of a parked run says "Parked".
export function stageState(stage, runStatus = '') {
  const s = stage && Object.prototype.hasOwnProperty.call(STAGE_STATES, stage.status) ? stage.status : 'pending';
  const [text, cls, mark] = STAGE_STATES[s];
  if (s === 'waiting' && runStatus === 'parked') return { text: 'Parked', cls: 'pending', mark: '‖' };
  return { text, cls, mark };
}

const WHO = { claude: 'Claude', code: 'code', you: 'you' };
// The meta line under a stage name: who, model/effort and attempt (Claude), the server's meta
// text, and how long it took.
export function stageMeta(stage, now = Date.now()) {
  if (!stage) return '';
  const parts = [];
  if (stage.who && WHO[stage.who]) parts.push(WHO[stage.who]);
  const att = asList(stage.attempts);
  const last = att[att.length - 1];
  if (last && last.model) parts.push(`${last.model}${last.effort ? `/${last.effort}` : ''}`);
  if (att.length > 1) parts.push(`attempt ${att.length}`);
  if (stage.meta) parts.push(String(stage.meta));
  const start = Date.parse(stage.startedAt || '');
  if (Number.isFinite(start) && stage.status !== 'waiting' && stage.status !== 'pending') {
    const end = stage.endedAt ? Date.parse(stage.endedAt) : now;
    const took = fmtDuration(Number.isFinite(end) ? end - start : NaN);
    if (took) parts.push(took);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------- the stage list

// ol.stages for a run. `selected` is the stage id the timeline is filtered to ('' for none);
// onSelect(id) gets the new choice ('' when the same stage is picked again).
export function stageList(run, { selected = '', onSelect = () => {} } = {}) {
  const stages = asList(run && run.stages);
  if (!stages.length) return h('p', { class: 'muted small st-empty' }, 'No stages yet.');
  return h('ol', { class: 'stages' }, stages.map(s => {
    const st = stageState(s, run.status);
    const on = selected === s.id;
    const name = s.label || s.id;
    return keyed(h('li', { class: `st ${st.cls}` },
      h('button', {
        class: 'st-btn', type: 'button', 'aria-pressed': on ? 'true' : 'false',
        title: on ? 'Show every stage in the timeline' : 'Show only this stage in the timeline',
        on: { click: () => onSelect(on ? '' : s.id) },
      },
      h('span', { class: 'st-icon', 'aria-hidden': 'true' }, st.mark),
      h('span', { class: 'st-name' }, h('b', {}, name), h('small', {}, stageMeta(s))),
      h('span', { class: 'st-state' }, st.text))), `st-${s.id}`);
  }));
}

// ---------------------------------------------------------------- the timeline

const FILTERS = [['text', 'Claude'], ['tool', 'Tools'], ['gate', 'Gates']];
let tlCount = 0;

// The timeline card. Returns { el, append(rows), reset(), setStage(id, label), setReplayable(on),
// move(delta), stop(), count, rows }: append() returns how many rows were new; stop() halts Play.
export function createTimeline() {
  const n = ++tlCount;
  const headId = `tl-h-${n}`;
  const all = []; // every row received, in seq order
  let lastSeq = 0;
  let toolRows = new Map(); // tool id -> its li
  let stage = '';
  let follow = true;
  let shown = 0; // rows of `all` on screen (less than all.length only while replaying)
  let replaying = false;
  let playTimer = null;

  const log = h('ol', { class: 'log', 'aria-labelledby': headId, tabindex: '0' });
  const empty = h('p', { class: 'muted small tl-empty' }, 'No events yet.');
  const only = h('p', { class: 'tl-only small', hidden: true });
  const followBtn = h('button', { class: 'tog', type: 'button', 'aria-pressed': 'true', on: { click: () => setFollow(!follow) } }, 'Follow');
  const toggles = FILTERS.map(([group, label]) => h('button', {
    class: 'tog', type: 'button', 'aria-pressed': 'true', dataset: { filter: group },
    on: {
      click: e => {
        const b = e.currentTarget;
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        log.classList.toggle(`hide-${group}`, !on);
      },
    },
  }, label));

  // Replay controls (finished runs only).
  const scrub = h('input', { type: 'range', min: '0', max: '0', value: '0', step: '1', 'aria-label': 'Replay position', on: { input: () => scrubTo(Number(scrub.value)) } });
  const scrubText = h('span', { class: 'small muted tl-pos', 'aria-live': 'off' });
  const playBtn = h('button', { class: 'btn small', type: 'button', on: { click: () => (playTimer ? pause() : play()) } }, 'Play ×10');
  const replayBox = h('div', { class: 'tl-replay', hidden: true }, h('span', { class: 'small' }, 'Replay'), scrub, playBtn, scrubText);

  const el = h('div', { class: 'card tl-card' },
    h('div', { class: 'card-head' }, h('h3', { id: headId }, 'Timeline'),
      h('div', { class: 'toggles', role: 'group', 'aria-label': 'Timeline filters' }, toggles, followBtn)),
    only, empty, log,
    h('div', { class: 'card-foot' }, h('span', {}, 'Shown as text only. Raw events stay in the run folder.'), replayBox));

  function setFollow(on) {
    follow = on;
    followBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    scrollEnd();
  }

  // Keeps the newest row in view while Follow is on, unless the reader has a row focused.
  function scrollEnd() {
    if (!follow) return;
    const active = document.activeElement;
    if (active && active !== log && log.contains(active)) return;
    log.scrollTop = log.scrollHeight;
  }

  function rowEl(row, fresh) {
    const group = kindGroup(row.kind);
    const state = rowState(row);
    const li = h('li', {
      class: `k-${row.kind} g-${group}${fresh ? ' new' : ''}${state ? ` is-${state}` : ''}`,
      tabindex: '-1', dataset: { seq: String(row.seq || ''), stage: row.stage || '' },
    },
    h('time', { datetime: row.t || null }, fmtClock(row.t, true)),
    h('span', { class: 'kind' }, kindLabel(row.kind)),
    h('span', { class: 'msg' }, String(row.msg || ''), state ? h('span', { class: 'tl-state' }, ` · ${state}`) : null));
    if (stage && row.stage !== stage) li.hidden = true;
    return li;
  }

  // Shows one row: a tool's end row replaces the line its start row made.
  function show(row, fresh) {
    const id = row.tool && row.tool.id;
    const li = rowEl(row, fresh && !id);
    const prev = id ? toolRows.get(id) : null;
    if (prev && prev.parentNode === log) {
      const hadFocus = document.activeElement === prev;
      prev.replaceWith(li);
      if (hadFocus) li.focus({ preventScroll: true });
    } else log.append(li);
    if (id) toolRows.set(id, li);
  }

  function updateEmpty() {
    empty.hidden = log.children.length > 0;
    if (!replayBox.hidden) {
      scrub.max = String(all.length);
      scrub.value = String(shown);
      const at = shown > 0 ? fmtClock(all[shown - 1].t, true) : '';
      scrubText.textContent = `${shown} of ${all.length} events${at ? ` · ${at}` : ''}`;
    }
  }

  // New rows from a pull. Rows at or below the last seq are skipped, so a repeated pull can
  // never add a row twice.
  function append(rows) {
    const fresh = asList(rows).filter(r => r && typeof r === 'object' && Number(r.seq) > lastSeq);
    if (!fresh.length) return 0;
    for (const r of fresh) {
      all.push(r);
      lastSeq = Math.max(lastSeq, Number(r.seq) || 0);
      if (!replaying) { show(r, true); shown = all.length; }
    }
    updateEmpty();
    scrollEnd();
    return fresh.length;
  }

  function reset() {
    pause();
    all.length = 0;
    lastSeq = 0;
    shown = 0;
    replaying = false;
    toolRows = new Map();
    log.replaceChildren();
    setStage('', '');
    updateEmpty();
  }

  // Filters the rows to one stage ('' for all). `label` names it in the "showing only" line.
  function setStage(id, label = '') {
    stage = id || '';
    for (const li of log.children) li.hidden = !!stage && li.dataset.stage !== stage;
    only.replaceChildren();
    only.hidden = !stage;
    if (stage) only.append(`Showing ${label || stage} only. `, h('span', { class: 'muted' }, 'Pick the stage again to show every stage.'));
    scrollEnd();
  }

  // Rebuilds the list from the first `count` stored rows (the scrubber).
  function scrubTo(count) {
    pause();
    replaying = count < all.length;
    shown = Math.max(0, Math.min(all.length, count));
    toolRows = new Map();
    log.replaceChildren();
    for (const r of all.slice(0, shown)) show(r, false);
    updateEmpty();
    scrollEnd();
  }

  function play() {
    if (shown >= all.length) scrubTo(0);
    replaying = true;
    playBtn.textContent = 'Pause';
    const step = () => {
      if (shown >= all.length) { pause(); replaying = false; return; }
      show(all[shown], true);
      shown++;
      updateEmpty();
      scrollEnd();
      playTimer = setTimeout(step, shown < all.length ? replayDelay(all[shown - 1], all[shown]) : 0);
    };
    playTimer = setTimeout(step, 150);
  }

  function pause() {
    clearTimeout(playTimer);
    playTimer = null;
    playBtn.textContent = 'Play ×10';
  }

  // Replay is offered on finished runs; turning it off shows every row again.
  function setReplayable(on) {
    if (replayBox.hidden === !on) return;
    replayBox.hidden = !on;
    if (!on && replaying) scrubTo(all.length);
    updateEmpty();
  }

  // j and k: the next or previous visible row takes the focus.
  function move(delta) {
    const rows = [...log.children].filter(li => !li.hidden && li.getClientRects().length);
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement);
    const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + delta));
    rows[next].focus({ preventScroll: true });
    rows[next].scrollIntoView({ block: 'nearest' });
  }

  updateEmpty();
  return { el, append, reset, setStage, setReplayable, move, stop: pause, get count() { return all.length; }, get rows() { return all; } };
}
