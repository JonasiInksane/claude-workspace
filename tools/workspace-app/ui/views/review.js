// Review gate (#review/<id>). A stub until wave 3b (UI-REVIEW) replaces this file: it shows
// the run id from the route and, when GET /api/run-review answers, the verdict and how many
// findings and changed files there are. A 404 (no such run, or the route doesn't exist yet)
// shows a note instead. Approve, send back and commit come in the next step.
import { api, h, keepFocus, plural, qs } from '../lib.js';
import { go } from '../store.js';

const RUN_ID_RE = /^[0-9a-z-]{1,64}$/;
let section = null;
let info = { id: '', review: null, note: '' };

function paint() {
  if (!section) return;
  const { id, review } = info;
  const facts = [
    ['Run id', h('code', {}, id || 'none')],
    review && review.verdict ? ['Verdict', String(review.verdict)] : null,
    review && Array.isArray(review.findings) ? ['Findings', plural(review.findings.length, 'finding')] : null,
    review && Array.isArray(review.files) ? ['Changed files', plural(review.files.length, 'file')] : null,
  ].filter(Boolean);
  keepFocus(section, () => section.replaceChildren(
    h('div', { class: 'view-head' }, h('div', {},
      h('p', { class: 'crumb' }, h('button', { class: 'link', type: 'button', on: { click: () => go('run', id) } }, 'Run'), ' / Review gate'),
      h('h2', {}, 'Review gate'),
      h('p', {}, 'Built in the next step.'))),
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        info.note ? h('p', { class: 'note mt-3' }, info.note) : null),
      h('div', { class: 'card-foot' }, 'Built in the next step: proof, checks, findings, the diff, and Approve and commit. There is no push or merge button.'))));
}

function render(el, { sub }) {
  section = el;
  if (info.id !== sub) info = { id: sub, review: null, note: '' };
  paint();
}

async function onShow({ sub }) {
  info = { id: sub, review: null, note: 'Loading…' };
  if (!RUN_ID_RE.test(sub)) {
    info.note = sub ? 'This is not a run id.' : 'No run chosen. Open one from Runs.';
    paint();
    return;
  }
  try {
    const r = await api(`/api/run-review?${qs({ id: sub })}`);
    if (info.id !== sub) return;
    info.review = r;
    info.note = '';
  } catch (e) {
    if (info.id !== sub) return;
    info.note = e.status === 404 ? 'No review for this run yet, or the review API is not there yet (404).' : e.message;
  }
  paint();
}

export default {
  id: 'review',
  label: 'Review gate',
  icon: '<path d="m5 12 5 5L20 7"/>',
  render,
  onShow,
};
