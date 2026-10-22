// Live run (#run/<id>). A stub until wave 3b (UI-RUN) replaces this file. It already uses the
// shell's polling hook: onShow starts store.livePoll, which pulls GET /api/run?id&since every
// 2 s (every 10 s while the live stream is up, and at once on a signal for this run), and
// onHide stops it. It shows the run id from the route, the status and the number of timeline
// rows pulled so far. A 404 (no such run, or the route doesn't exist yet) stops the polling
// with a note; a dropped connection keeps polling (the heartbeat notices a stopped server).
import { api, h, keepFocus, qs } from '../lib.js';
import { atReviewGate, go, livePoll } from '../store.js';
import { statusPair } from '../parts/status.js';

const RUN_ID_RE = /^[0-9a-z-]{1,64}$/;
let section = null;
let stop = null;
let info = { id: '', run: null, rows: 0, since: 0, note: '' };

function paint() {
  if (!section) return;
  const { id, run } = info;
  const facts = [
    ['Run id', h('code', {}, id || 'none')],
    run && run.pipeline ? ['Pipeline', run.pipeline] : null,
    run && run.project ? ['Project', run.project] : null,
    run && run.current && run.current.stage ? ['Stage', run.current.stage] : null,
    run ? ['Timeline rows', String(info.rows)] : null,
  ].filter(Boolean);
  const atReview = run && run.status === 'waiting' && atReviewGate(run);
  keepFocus(section, () => section.replaceChildren(
    h('div', { class: 'view-head' }, h('div', {},
      h('p', { class: 'crumb' }, h('button', { class: 'link', type: 'button', on: { click: () => go('runs') } }, 'Runs'), ' / Run'),
      h('h2', {}, run && run.title ? run.title : 'Live run', run && run.status ? statusPair(run.status) : null),
      h('p', {}, 'Built in the next step.')),
    atReview ? h('button', { class: 'btn primary', type: 'button', on: { click: () => go('review', id) } }, 'Open the review gate') : null),
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        info.note ? h('p', { class: 'note mt-3' }, info.note) : null),
      h('div', { class: 'card-foot' }, 'Built in the next step: meters, gate cards, stages, the timeline and the run actions.'))));
}

function render(el, { sub }) {
  section = el;
  if (info.id !== sub) info = { id: sub, run: null, rows: 0, since: 0, note: 'Loading…' };
  paint();
}

async function pull() {
  const id = info.id;
  try {
    const r = await api(`/api/run?${qs({ id, since: info.since })}`);
    if (id !== info.id) return false;
    info.run = r.run || null;
    info.rows += Array.isArray(r.rows) ? r.rows.length : 0;
    if (r.next != null) info.since = r.next;
    info.note = '';
    paint();
    return true;
  } catch (e) {
    if (e.network) return true;
    info.note = e.status === 404 ? 'No run with this id, or the runs API is not there yet (404).' : e.message;
    paint();
    return e.status !== 404 && e.status !== 400;
  }
}

function onShow({ sub }) {
  info = { id: sub, run: null, rows: 0, since: 0, note: 'Loading…' };
  if (!RUN_ID_RE.test(sub)) {
    info.note = sub ? 'This is not a run id.' : 'No run chosen. Open one from Runs.';
    paint();
    return;
  }
  stop = livePoll(pull, { runId: sub });
}

function onHide() {
  if (stop) stop();
  stop = null;
}

export default {
  id: 'run',
  label: 'Live run',
  icon: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.5 3.5-5.5 3.5z"/>',
  render,
  onShow,
  onHide,
};
