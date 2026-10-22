// Shared helpers for the page: building elements, calling the API, toasts, formatting, run
// status badges, focus keeping, the polite announcer and a small confirm dialog.
// Data is always rendered as text (h() below), never as HTML: names, descriptions, file names
// and run output come from repos, the inbox and Claude. The CSP (style-src 'self') also blocks
// style attributes, so h() refuses a `style` prop: use a class, or set el.style.width (the
// CSSOM) for a computed size. No other module of the page is imported here.

export const $ = sel => document.querySelector(sel);

// h('div', { class, on: { click }, dataset, ...attributes }, ...children). Children are nodes,
// strings (added as text), arrays (flattened) or null/false (skipped). A boolean prop sets the
// DOM property (hidden, disabled, checked); an aria-* value that must read "false" is passed
// as the string 'false'.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'style') throw new Error('h(): no style attribute (the CSP blocks it). Use a class, or el.style for a computed size.');
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (typeof v === 'boolean') el[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Fixed icon markup (no data inside), parsed once per call. This is the only place on the page
// that parses markup; callers pass constant SVG inner markup, never names or text from data.
export function icon(markup) {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${markup}</svg>`;
  return t.content.firstChild;
}

// Sets data-key on an interactive row, so restoreFocus() can find it again after a re-render.
export function keyed(el, key) {
  el.dataset.key = String(key);
  return el;
}

// The data-key of the row that holds the focus inside `container`, or '' (call before a render).
export function focusedKey(container) {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return '';
  const row = active.closest('[data-key]');
  return row && container.contains(row) ? row.dataset.key : '';
}

// After a render: puts the focus back on the row with this data-key (or on its first control).
export function restoreFocus(container, key) {
  if (!key) return;
  const row = [...container.querySelectorAll('[data-key]')].find(el => el.dataset.key === key);
  if (!row) return;
  const target = row.matches('button, a, input, select, textarea, [tabindex]') ? row
    : row.querySelector('button, a, input, select, textarea, [tabindex]');
  if (target) target.focus({ preventScroll: true });
}

// Re-renders `container` with fn() and keeps the focus where it was: on the same data-key row,
// or on the view heading (the h2 that takes the focus after a navigation, SPEC 5.11). main.js
// wraps every view render in it; a view that repaints itself (after a poll) uses it too.
export function keepFocus(container, fn) {
  const key = focusedKey(container);
  const active = document.activeElement;
  const onHeading = !!active && active.tagName === 'H2' && container.contains(active);
  fn();
  if (key) restoreFocus(container, key);
  if (onHeading && !container.contains(document.activeElement)) {
    const heading = container.querySelector('h2');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }
}

// True when a key press is typing (an input, textarea, select or editable element has it).
// Checkboxes, radios and button inputs take no text, so a shortcut letter there is not typing.
const NO_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset']);
export function isTyping(target) {
  if (!target || !target.closest) return false;
  const el = target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  return !!el && !(el.tagName === 'INPUT' && NO_TEXT_INPUTS.has(String(el.type).toLowerCase()));
}

// ---------------------------------------------------------------- formatting

export const qs = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)).toString();
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export const fmtDay = ymd => new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const fmtTime = iso => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// "10:42", or "10:42:07" with seconds (24-hour, local time). '' for a missing or bad date.
export function fmtClock(iso, seconds = false) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}${seconds ? `:${p(d.getSeconds())}` : ''}`;
}

// "12 s", "4 m 12 s", "1 h 05 m". A negative or missing duration gives ''.
export function fmtDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
}

// "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then the date. `now` is for tests.
export function fmtAgo(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (!iso || Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hours = Math.round(m / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Run status -> the badge's label and class (SPEC 5.1). The label is the text that sits next to
// every coloured dot, so a status is never shown by colour alone. Unknown statuses show as-is.
export const STATUS_BADGES = {
  running: ['Running', 'blue'],
  waiting: ['Needs you', 'amber'],
  'in-terminal': ['In terminal', 'violet'],
  passed: ['Passed', 'ok'],
  committed: ['Committed', 'ok'],
  failed: ['Failed', 'red'],
  'gates-red': ['Checks red', 'red'],
  capped: ['Cap reached', 'amber'],
  'paused-limit': ['Paused: usage limit', 'amber'],
  interrupted: ['Interrupted', 'amber'],
  parked: ['Parked', ''],
  cancelled: ['Cancelled', ''],
};
export function statusBadge(status) {
  const known = Object.prototype.hasOwnProperty.call(STATUS_BADGES, status) ? STATUS_BADGES[status] : null;
  return known ? { label: known[0], cls: known[1] } : { label: String(status || 'Unknown'), cls: '' };
}

// ---------------------------------------------------------------- feedback

// At most three toasts show at once; the oldest goes first.
export function toast(message, isError = false) {
  const box = $('#toasts');
  const t = h('div', { class: `toast${isError ? ' err' : ''}`, role: isError ? 'alert' : 'status' }, message);
  box.append(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => t.remove(), isError ? 7000 : 3500);
}

export function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast(`Copied: ${text}`), () => toast('Could not copy to the clipboard', true));
}

// Says `text` through the polite live region (#announcer in index.html). Only for "waiting for
// you" changes (SPEC 5.11): everything else on the page stays quiet for screen readers.
export function announce(text) {
  const region = $('#announcer');
  if (!region) return;
  region.textContent = '';
  // Set a moment later, so the same sentence twice in a row is still read out.
  setTimeout(() => { region.textContent = text; }, 50);
}

// A small modal question in its own <dialog>, so it can open on top of the main dialog.
// Resolves true for OK, and false for Cancel, Esc or a click on the backdrop.
let confirmCount = 0;
export function confirmDialog(title, text, okLabel = 'OK') {
  return new Promise(resolveP => {
    const id = `confirm-${++confirmCount}`;
    let answer = false;
    const dlg = h('dialog', { class: 'confirm', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-text`, 'aria-modal': 'true' });
    const ok = h('button', { class: 'btn primary', type: 'button', on: { click: () => { answer = true; dlg.close(); } } }, okLabel);
    dlg.append(
      h('div', { class: 'card-head' }, h('h3', { id: `${id}-title` }, title)),
      h('div', { class: 'card-body' }, h('p', { id: `${id}-text` }, text)),
      h('div', { class: 'card-foot' }, h('button', { class: 'btn ghost', type: 'button', on: { click: () => dlg.close() } }, 'Cancel'), ok));
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => { dlg.remove(); resolveP(answer); });
    document.body.append(dlg);
    dlg.showModal();
    ok.focus();
  });
}

// ---------------------------------------------------------------- the server

let stopped = false;
export const isStopped = () => stopped;

// Covers the page when the server is gone or the sign-in no longer holds.
export function showStopped(message) {
  if (stopped) return;
  stopped = true;
  document.body.append(h('div', { class: 'overlay' }, h('div', {},
    h('h2', {}, 'The workspace app is not connected'),
    h('p', { class: 'muted' }, message || ''),
    h('p', {}, 'Close this window and start the app again (', h('code', {}, 'Workspace App.cmd'), ' or the Claude Workspace shortcut).'))));
}

// After a network error on the heartbeat or a refresh: is the server really gone?
export function checkServer() {
  fetch('/health').then(r => { if (!r.ok) showStopped('The app server is not answering.'); },
    () => showStopped('The app server has stopped.'));
}

// GET, or POST with a JSON `body` or a `raw` body (an upload). Resolves with the JSON answer;
// rejects with the server's error message and the HTTP `status` (a 404 lets a caller fall back
// quietly while a route doesn't exist yet). A network failure has `network: true`.
export async function api(path, { method = 'GET', body, raw, contentType } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') opts.headers['X-Workspace-App'] = '1';
  if (raw) { opts.body = raw; opts.headers['Content-Type'] = contentType || 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch(path, opts); } catch {
    // Also happens when a dropped file can't be read, so this alone doesn't mean "stopped".
    throw Object.assign(new Error('Could not reach the app server (or read the file).'), { network: true });
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : { ok: false, error: await res.text() };
  if (res.status === 403 && !isJson) { showStopped(data.error); throw Object.assign(new Error(data.error), { status: 403 }); }
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// Awaits an API call and shows its message (or error) as a toast. Resolves with the answer,
// or null after an error.
export async function act(promise) {
  try {
    const r = await promise;
    toast((r && r.message) || 'Done');
    return r;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}
export const launch = body => act(api('/api/launch', { method: 'POST', body }));
export const openPlace = body => act(api('/api/open', { method: 'POST', body }));
