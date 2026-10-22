// Tests for runs/events.mjs: the in-process signal hub behind GET /api/events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSignalHub } from './events.mjs';

test('emit gives every signal an increasing id and only the four signal fields', () => {
  const hub = createSignalHub();
  const got = [];
  hub.subscribe(s => got.push(s));
  const a = hub.emit({ run: 'r1', project: 'example', seq: 3, status: 'running', extra: 'dropped' });
  const b = hub.emit({ run: 'r2', project: 'example', seq: null, status: 'waiting' });
  assert.deepEqual(a, { id: 1, run: 'r1', project: 'example', seq: 3, status: 'running' });
  assert.equal(b.id, 2);
  assert.deepEqual(got, [a, b]);
});

test('emit without arguments still sends a signal with null fields', () => {
  const hub = createSignalHub();
  assert.deepEqual(hub.emit(), { id: 1, run: null, project: null, seq: null, status: null });
});

test('subscribe returns an unsubscribe function, and count follows it', () => {
  const hub = createSignalHub();
  const got = [];
  const off = hub.subscribe(s => got.push(s.id));
  const off2 = hub.subscribe(() => {});
  assert.equal(hub.count(), 2);
  hub.emit({ run: 'r1' });
  off();
  off(); // harmless twice
  assert.equal(hub.count(), 1);
  hub.emit({ run: 'r1' });
  assert.deepEqual(got, [1]);
  off2();
  assert.equal(hub.count(), 0);
});

test('a subscriber that throws does not stop the others or the caller', () => {
  const hub = createSignalHub();
  const got = [];
  hub.subscribe(() => { throw new Error('broken page stream'); });
  hub.subscribe(s => got.push(s.run));
  assert.doesNotThrow(() => hub.emit({ run: 'r1' }));
  assert.deepEqual(got, ['r1']);
});

test('a subscriber that unsubscribes during delivery does not skip the next one', () => {
  const hub = createSignalHub();
  const got = [];
  let off = null;
  off = hub.subscribe(() => { got.push('first'); off(); });
  hub.subscribe(() => got.push('second'));
  hub.emit({ run: 'r1' });
  hub.emit({ run: 'r1' });
  assert.deepEqual(got, ['first', 'second', 'second']);
});

test('subscribe refuses something that is not a function', () => {
  const hub = createSignalHub();
  assert.throws(() => hub.subscribe('nope'), /must be a function/);
});

test('two hubs keep separate ids and subscribers', () => {
  const a = createSignalHub();
  const b = createSignalHub();
  const got = [];
  a.subscribe(s => got.push(['a', s.id]));
  b.emit({ run: 'x' });
  a.emit({ run: 'x' });
  assert.deepEqual(got, [['a', 1]]);
  assert.equal(b.count(), 0);
});
