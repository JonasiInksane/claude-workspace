// Runs (#runs). A stub until wave 3b (UI-LISTS) replaces this file: it lists the runs that wait
// for you and the ones running, from the shell's GET /api/runs pull (store.runs), each with its
// status dot and badge and an Open button. Filters, history and Load more come in the next step.
import { fmtAgo, h, keyed } from '../lib.js';
import { atReviewGate, go, loadRuns, runs } from '../store.js';
import { statusPair } from '../parts/status.js';

function row(r) {
  const atReview = atReviewGate(r);
  return keyed(h('li', { class: `row ${r.status === 'waiting' ? 'waiting' : 'running'}` },
    statusPair(r.status, atReview ? 'Review gate' : ''),
    h('div', { class: 'main' },
      h('div', { class: 'title' }, r.title || r.id),
      h('div', { class: 'sub' }, [r.project, r.pipeline, r.stage, r.at ? fmtAgo(r.at) : ''].filter(Boolean).join(' · '))),
    h('button', { class: 'btn small', type: 'button', on: { click: () => go(atReview ? 'review' : 'run', r.id) } }, 'Open')), r.id);
}

function render(el) {
  const list = [...runs.waiting, ...runs.running];
  // replaceChildren() would print a null as text, so the optional parts are filtered out.
  el.replaceChildren(...[
    h('div', { class: 'view-head' }, h('div', {}, h('h2', {}, 'Runs'), h('p', {}, 'Waiting and running now. The full list is built in the next step.'))),
    !runs.loaded ? h('p', { class: 'note info' }, 'The runs list is not available yet.') : null,
    runs.loaded && !list.length ? h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', {}, 'Nothing is running'), 'No run waits for you.')) : null,
    list.length ? h('ul', { class: 'rows' }, list.map(row)) : null,
  ].filter(Boolean));
}

export default {
  id: 'runs',
  label: 'Runs',
  icon: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.5 3.5-5.5 3.5z"/>',
  render,
  onShow: () => { loadRuns(); },
};
