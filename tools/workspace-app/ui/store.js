// The page's shared state: the last answer of GET /api/state, the view on screen, and the
// route to it. `state`, `view` and `sub` are live bindings: importers always read the current
// value, and only this module assigns them (setState, setView).
//
// Routing: the URL hash names the view, #<view> or #<view>/<sub>. go() changes the hash, which
// adds a history entry (so Back works); main.js listens for hashchange and shows the view.
import { api, checkServer, isStopped, toast } from './lib.js';

export let state = null; // GET /api/state; null until the first answer
export let view = 'home';
export let sub = ''; // what follows the view in the hash, '' for none

const listeners = new Set();
let lastRefresh = 0;

// Replaces the state and tells every subscriber.
export function setState(next) {
  state = next;
  for (const fn of listeners) fn(state);
}

// fn(state) runs after every setState. Returns a function that unsubscribes.
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Only main.js calls this, when it shows a view.
export function setView(id, subPath = '') {
  view = id;
  sub = subPath;
}

export const msSinceRefresh = () => Date.now() - lastRefresh;

// Loads the state again. Errors show as a toast (or the "not connected" overlay).
export async function refresh() {
  lastRefresh = Date.now();
  try {
    setState(await api('/api/state'));
  } catch (e) {
    if (e.network) checkServer();
    else if (!isStopped()) toast(e.message, true);
  }
}

// '#flows/hero-sprite' <-> { id: 'flows', sub: 'hero-sprite' }. `sub` may hold more slashes;
// each part is URL-encoded in the hash.
export const hashFor = (id, subPath = '') =>
  `#${id}${subPath ? `/${String(subPath).split('/').map(encodeURIComponent).join('/')}` : ''}`;
export function parseHash(hash = location.hash) {
  const [id = '', ...rest] = String(hash).replace(/^#/, '').split('/');
  let subPath = rest.join('/');
  try { subPath = decodeURIComponent(subPath); } catch { subPath = ''; }
  return { id, sub: subPath };
}

// Shows a view, as a new history entry. Going to the view already shown shows it again.
export function go(id, subPath = '') {
  const hash = hashFor(id, subPath);
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}
