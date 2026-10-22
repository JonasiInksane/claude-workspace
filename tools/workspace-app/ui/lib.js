// Shared helpers for the page: building elements, calling the API, toasts, and formatting.
// Data is always rendered as text (h() below), never as HTML: names, descriptions and file
// names come from repos and the inbox. No other module of the page is imported here.

export const $ = sel => document.querySelector(sel);

// h('div', { class, on: { click }, dataset, ...attributes }, ...children). Children are nodes,
// strings (added as text), arrays (flattened) or null/false (skipped).
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
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

// Fixed icon markup (no data inside), parsed once per call.
export function icon(markup) {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${markup}</svg>`;
  return t.content.firstChild;
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

// ---------------------------------------------------------------- feedback

export function toast(message, isError = false) {
  const t = h('div', { class: `toast${isError ? ' err' : ''}`, role: isError ? 'alert' : 'status' }, message);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), isError ? 7000 : 3500);
}

export function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast(`Copied: ${text}`), () => toast('Could not copy to the clipboard', true));
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
// rejects with the server's error message. A network failure has `network: true`.
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
  if (res.status === 403 && !isJson) { showStopped(data.error); throw new Error(data.error); }
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
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
