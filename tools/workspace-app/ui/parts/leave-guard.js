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
// A refused route puts the guarded address back with history.replaceState (no new history entry,
// no hashchange), so the screen and what was typed stay as they were.

let guard = null;

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

// True when the page may show `hash`. Leaving the guarded screen with unsaved work asks first:
// OK drops the guard, runs onDiscard and lets the route through; Cancel puts the guarded address
// back and keeps the screen. `ask` is window.confirm (tests pass their own).
export function mayLeave(hash, ask = q => window.confirm(q)) {
  if (!guard || hash === guard.hash || !isDirty()) return true;
  if (ask(guard.message || 'Discard your unsaved changes?')) {
    const g = guard;
    guard = null;
    if (g.onDiscard) g.onDiscard();
    return true;
  }
  history.replaceState(null, '', guard.hash);
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
