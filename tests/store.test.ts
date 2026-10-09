import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/client/event-store';

test('callbacks from a stopped socket cannot change the replacement connection', async () => {
  const all: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onclose?: (event: { code: number }) => void;
    onmessage?: (event: { data: string }) => void;
    constructor(_url: string) { all.push(this); }
    close() { this.readyState = 3; }
    send(json: string) {
      const message = JSON.parse(json);
      if (message.type === 'cmd') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'ack', id: message.id, result: { ok: true } }) }));
    }
  }
  const originalSocket = globalThis.WebSocket;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.assign(globalThis, { WebSocket: FakeSocket, location: { protocol: 'http:', host: 'localhost' } });
  const store = new EventStore('ev');
  try {
    store.start(); store.stop(); store.start();
    all[1].readyState = FakeSocket.OPEN;
    all[1].onopen?.();
    const command = store.send({ type: 'REACT', reaction: 'love' });
    all[0].onclose?.({ code: 1000 });
    assert.equal((await command).ok, true);
    assert.equal(store.conn, 'live');
  } finally {
    store.stop();
    globalThis.WebSocket = originalSocket;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else delete (globalThis as any).location;
  }
});
