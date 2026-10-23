// Unsaved work on a screen that is not a dialog (the project Settings tab): while a guard is set,
// leaving that screen asks first, the way an editor dialog's guard does (dialog.js, `guard`):
// main.js asks mayLeave() before it shows another route (a nav click, a tab, the palette, Back),
// and the window asks before it closes or reloads (beforeunload). One guard at a time: the screen
// on show sets it in its onShow and clears it in its onHide.
//
//   setLeaveGuard({ hash, dirty, message, onDiscard })
//     hash       the guarded screen's address ('#project/example/settings'); showing it again is
//                never leaving
//     dirty()    true while there is something to lose
//     message    the question confirm() asks ("Discard your changes to ...?")
//     onDiscard  runs when the person chose to leave anyway (drop the draft)
//
// A refused route puts the guarded address back without a hashchange, so the screen and what was
// typed stay as they were, and without losing a history entry. A link, a tab, the palette or a
// typed address made a new entry for the refused route: history.replaceState turns it back into
// the guarded address (no entry added). Back or Forward moved to an entry the page showed before:
// that entry stays, and history.pushState puts the guarded address after it (the entries that were
// ahead of it go, as with any new route). To tell the two apart, every entry the page shows gets a
// mark in history.state; a new entry has none yet.

let guard = null;

const MARK = 'wsShown';
// The stand-in DOM of the tests has a history without state: no marks there.
const canMark = () => typeof history !== 'undefined' && !!history && 'state' in history;

function isMarked() {
  try { return canMark() && !!history.state && history.state[MARK] === true; } catch { return false; }
}

// Marks the current entry, keeping what else its state holds.
function markEntry() {
  if (!canMark() || isMarked()) return;
  try {
    const s = history.state;
    history.replaceState({ ...(s && typeof s === 'object' ? s : {}), [MARK]: true }, '');
  } catch { /* a browser that refuses: the old replaceState behaviour is all that is lost */ }
}

// After the route's own handler: main.js corrects a route's address with replaceState(null), which
// would drop a mark made before it.
const markSoon = () => { if (canMark()) queueMicrotask(markEntry); };

export function setLeaveGuard(g) {
  guard = g && typeof g.hash === 'string' && typeof g.dirty === 'function' ? { ...g } : null;
}

// Clears the guard (only the one for `hash`, when given).
export function clearLeaveGuard(hash = '') {
  if (guard && (!hash || guard.hash === hash)) guard = null;
}

export const guardedHash = () => (guard ? guard.hash : '');

function isDirty() {
  try { return !!(guard && guard.dirty()); } catch { return false; }
}

// True when the page may show `hash` (main.js asks on every hashchange, after the browser moved).
// Leaving the guarded screen with unsaved work asks first: OK drops the guard, runs onDiscard and
// lets the route through; Cancel puts the guarded address back and keeps the screen. `ask` is
// window.confirm (tests pass their own).
export function mayLeave(hash, ask = q => window.confirm(q)) {
  const shownBefore = isMarked(); // Back or Forward, not a new entry
  if (!guard || hash === guard.hash || !isDirty()) { markSoon(); return true; }
  if (ask(guard.message || 'Discard your unsaved changes?')) {
    const g = guard;
    guard = null;
    if (g.onDiscard) g.onDiscard();
    markSoon();
    return true;
  }
  if (shownBefore) history.pushState({ [MARK]: true }, '', guard.hash);
  else history.replaceState({ [MARK]: true }, '', guard.hash);
  return false;
}

// The window's beforeunload: with unsaved work, the browser asks "Leave site?" before it closes
// or reloads the page.
export function beforeUnload(e) {
  if (!isDirty()) return undefined;
  e.preventDefault();
  e.returnValue = '';
  return '';
}

if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', beforeUnload);
}
// The entry the page opened on (marked after main.js has shown its first screen).
markSoon();
