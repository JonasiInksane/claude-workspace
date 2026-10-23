// Small builders the project page's tabs share, moved from the cockpit and health views: a button
// with its own data-key (so keepFocus() finds it again after a card is rebuilt), a card head, the
// loading body, an error note with Try again, a whole-card state ("No project named x"), badges and
// check results with their icons, the label of a pipeline, a POST helper and a dialog's Cancel.
// Everything renders data as text (lib.js h()).
import { api, h, icon, keyed } from '../lib.js';
import { dialog } from '../dialog.js';
import { pipelineDef } from '../store.js';
import { reload } from './project-data.js';

export const ICONS = {
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 8"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  pass: '<path d="m5 12 4 4 10-10"/>',
  fail: '<path d="M6 6l12 12M18 6 6 18"/>',
  warn: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
};

export const short = sha => String(sha || '').slice(0, 7);
// The current minute: a memo dependency, so "5 min ago" texts move on while nothing else changes.
export const minute = () => Math.floor(Date.now() / 60_000);

// A button with its own data-key. `describedBy` names the visible reason of a disabled one.
export function btn(key, label, onClick, { cls = 'btn small', disabled = false, describedBy = null, title = null } = {}) {
  return keyed(h('button', { class: cls, type: 'button', disabled, title, 'aria-describedby': describedBy, on: { click: onClick } }, label), key);
}

export function cardHead(title, ...extra) {
  const actions = extra.flat().filter(Boolean);
  return h('div', { class: 'card-head' }, h('h3', {}, title), actions.length ? h('div', { class: 'row-actions' }, actions) : null);
}

export const loadingBody = () => h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Loading…'));

// An error in a .note, with Try again (loads the tab's data again).
export function errorNote(text, key) {
  return h('div', { class: 'note red ck-error' }, h('span', {}, text), ' ',
    keyed(h('button', { class: 'link', type: 'button', on: { click: () => reload() } }, 'Try again'), `retry:${key}`));
}

// A card that is the whole answer: a bold title, a line of text and an optional action.
export function stateCard(title, text, action = null) {
  return h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', {}, title), text,
    action ? h('div', { class: 'mt-4' }, action) : null));
}

// { text, cls, icon?, wrap? } as a badge; the class only adds the colour.
export function badgeEl(b) {
  return h('span', { class: `badge${b.cls ? ` ${b.cls}` : ''}${b.wrap ? ' wrap' : ''}` }, b.icon ? icon(ICONS[b.icon]) : null, b.text);
}

// { cls, text, icon } as a check result ("Pass · 0 new · 61 known").
export function resEl(r) {
  return h('span', { class: `res ${r.cls}` }, r.icon ? icon(ICONS[r.icon]) : null, r.text);
}

// "Refactor" for refactor: the catalog's label once loaded, else the id with a capital.
export const pipeLabel = id => (pipelineDef(id) || {}).label || (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Run');

export const post = (path, body) => api(path, { method: 'POST', body });
export const closeButton = () => h('button', { class: 'btn', type: 'button', on: { click: () => dialog.close() } }, 'Cancel');
