// GET /api/events: live update signals as Server-Sent Events (SPEC 5.10, plan P6).
//
// The page opens one EventSource('/api/events') and pulls the real data itself; a signal only
// says "run X changed": `id: <n>\ndata: {"run","project","seq","status"}\n\n`, where n is the
// signal hub's own counter (runs/events.mjs). The stream starts with `retry: 3000` (reconnect
// after 3 s) and sends a `: ping` comment every 15 s so a dead connection is noticed.
//
// At most 4 streams are open at once (one per app window, with room for a reload); a fifth gets
// 429. Closing a stream unsubscribes it and clears its timer. A stream never counts as work in
// progress (it doesn't touch isBusy), and its timer doesn't keep Node alive, so an open window's
// stream never stops the idle shutdown. The access checks (Host, cookie) run in app.mjs first.
import { HttpError } from '../http.mjs';

export const PING_MS = 15_000;
export const MAX_STREAMS = 4;
export const RETRY_MS = 3000;

// Exported for tests: the text of one signal.
export function signalText(signal) {
  const { id, run = null, project = null, seq = null, status = null } = signal || {};
  return `id: ${Number(id) || 0}\ndata: ${JSON.stringify({ run, project, seq, status })}\n\n`;
}

// routes(ctx, { pingMs, maxStreams }): the options are for tests.
export function routes({ getEngine }, { pingMs = PING_MS, maxStreams = MAX_STREAMS } = {}) {
  let open = 0;
  return {
    'GET /api/events': async (req, res) => {
      if (open >= maxStreams) {
        throw new HttpError(429, `At most ${maxStreams} live update streams can be open; close another app window.`);
      }
      if (typeof getEngine !== 'function') throw new HttpError(503, 'The run engine is not available in this app.');
      open++; // counted before the await, so streams that arrive together can't pass the limit
      let closed = false;
      let unsubscribe = () => {};
      let ping = null;
      const close = () => {
        if (closed) return;
        closed = true;
        open--;
        unsubscribe();
        if (ping) clearInterval(ping);
      };
      // The response's close: the page went away (or the server is closing). Not req's, which
      // Node emits once the (empty) request body has been read.
      res.on('close', close);
      let manager;
      try {
        manager = await getEngine();
      } catch (err) {
        close();
        throw new HttpError(503, `Live updates are not available: ${err.message}`);
      }
      if (closed) return undefined;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        Connection: 'keep-alive',
      });
      const write = text => { if (!closed && !res.writableEnded) res.write(text); };
      write(`retry: ${RETRY_MS}\n\n`);
      unsubscribe = manager.signals.subscribe(signal => write(signalText(signal)));
      ping = setInterval(() => write(': ping\n\n'), pingMs);
      ping.unref?.();
      res.on('error', close);
      return undefined;
    },
  };
}
