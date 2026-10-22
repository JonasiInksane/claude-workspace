// Tests for core/ports.mjs. Run: node --test tools/workspace-app/core/ports.test.mjs
// Each test listens on a random free loopback port (port 0) and closes it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { anyListening, listening, LOOPBACK } from './ports.mjs';

function listen(t, host = '127.0.0.1') {
  return new Promise((resolveP, rejectP) => {
    const server = net.createServer(socket => socket.destroy());
    server.once('error', rejectP);
    server.listen(0, host, () => {
      t.after(() => new Promise(r => server.close(() => r())));
      resolveP({ server, port: server.address().port });
    });
  });
}

const close = server => new Promise(r => server.close(() => r()));

// A port that was free a moment ago: listen on 0, note the port, close.
async function freePort(t) {
  const { server, port } = await listen(t);
  await close(server);
  return port;
}

test('listening is true for a listening port and false once it closes', async t => {
  const { server, port } = await listen(t);
  assert.equal(await listening(port), true);
  assert.equal(await listening(port, '127.0.0.1', 1000), true);
  await close(server);
  assert.equal(await listening(port), false);
});

test('listening gives up after the timeout', async t => {
  // 10.255.255.1 is not routed on a normal network: the connect either hangs (timeout) or fails.
  const started = Date.now();
  assert.equal(await listening(9, '10.255.255.1', 150), false);
  assert.ok(Date.now() - started < 2000);
});

test('listening and anyListening refuse values that are not port numbers', async () => {
  for (const bad of [0, -1, 65536, 1.5, 'abc', null]) await assert.rejects(listening(bad), /not a port number/, String(bad));
  await assert.rejects(anyListening([80, 'x']), /not a port number/);
});

test('anyListening returns the ports that answer, in order and without duplicates', async t => {
  const a = await listen(t);
  const b = await listen(t);
  const free = await freePort(t);
  assert.deepEqual(await anyListening([b.port, free, a.port, b.port]), [b.port, a.port]);
  assert.deepEqual(await anyListening([]), []);
  assert.deepEqual(await anyListening(null), []);
  assert.deepEqual(await anyListening([a.port], { hosts: ['127.0.0.1'], ms: 500 }), [a.port]);
});

test('anyListening also finds a server that listens on IPv6 loopback only', async t => {
  assert.deepEqual(LOOPBACK, ['127.0.0.1', '::1']);
  let six;
  try { six = await listen(t, '::1'); } catch {
    t.skip('this machine has no IPv6 loopback');
    return;
  }
  assert.equal(await listening(six.port), false, 'not on 127.0.0.1');
  assert.equal(await listening(six.port, '::1'), true);
  assert.deepEqual(await anyListening([six.port]), [six.port]);
});
