// Port probes: is something listening on a local TCP port right now?
//
// Used before branch mode (a project's dev servers must be stopped before the app switches its
// main checkout) and before the integration check group (it runs only when the containers the
// user started already answer). A probe is one TCP connect with a short timeout; nothing is sent
// and the socket is closed at once. The app never starts or stops a server itself.
import net from 'node:net';

export const PROBE_MS = 300;
// A dev server may listen on IPv4 only, IPv6 only (Node resolves "localhost" to ::1 first) or
// both, so anyListening asks both loopback addresses by default.
export const LOOPBACK = ['127.0.0.1', '::1'];

function checkPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`"${port}" is not a port number (1 to 65535).`);
  return n;
}

// True when a TCP connect to host:port succeeds within `ms` milliseconds. Rejects a value that
// is not a port number.
export async function listening(port, host = '127.0.0.1', ms = PROBE_MS) {
  const p = checkPort(port);
  return new Promise(resolveP => {
    let done = false;
    const socket = net.connect({ port: p, host });
    const finish = ok => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolveP(ok);
    };
    const timer = setTimeout(() => finish(false), ms);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// The ports from `ports` that answer on any of `hosts`, in the order given, without duplicates.
export async function anyListening(ports, { hosts = LOOPBACK, ms = PROBE_MS } = {}) {
  const unique = [...new Set((ports || []).map(checkPort))];
  const answers = await Promise.all(unique.map(async p => {
    for (const ok of await Promise.all(hosts.map(h => listening(p, h, ms)))) if (ok) return true;
    return false;
  }));
  return unique.filter((_, i) => answers[i]);
}
