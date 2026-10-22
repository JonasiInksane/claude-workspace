// The run engine's signal hub: a tiny in-process publish/subscribe for "something changed in run X".
//
// A signal carries no data beyond { run, project, seq, status }; the page always pulls the real
// rows (GET /api/run?since=...). The SSE route (GET /api/events, W3-WIRING) subscribes once per
// open stream and writes each signal as `id: <n>\ndata: {...}`, so every signal gets an
// increasing id here. A subscriber that throws is dropped from that one delivery only; it can
// never stop the engine or the other subscribers.

// Returns { emit(signal), subscribe(fn) -> unsubscribe, count() }.
export function createSignalHub() {
  const subscribers = new Set();
  let lastId = 0;

  // Sends a signal to every subscriber and returns it with its id.
  function emit({ run = null, project = null, seq = null, status = null } = {}) {
    const signal = { id: ++lastId, run, project, seq, status };
    for (const fn of [...subscribers]) {
      try { fn(signal); } catch { /* a broken subscriber must not break the engine */ }
    }
    return signal;
  }

  // Adds a subscriber; the returned function removes it (calling it twice is harmless).
  function subscribe(fn) {
    if (typeof fn !== 'function') throw new Error('A signal subscriber must be a function.');
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
  }

  return { emit, subscribe, count: () => subscribers.size };
}
