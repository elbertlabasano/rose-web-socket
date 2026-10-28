import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createServer } from '../server.js';
import { hash } from '../src/store.js';

test('authenticated API queues, rate-limits, resumes dispatch, persists results, and deduplicates requests', { timeout: 30000 }, async t => {
  const messages = []; const registered = new Map();
  const store = {
    async ping() {}, async recover() {}, async expire() {}, async seen() {},
    async device(id) { return registered.get(id); },
    async devices() { return [...registered.values()]; },
    async register(id, name, token) { registered.set(id, { id, name, token_hash: hash(token) }); },
    async get(id) { return messages.find(m => m.id === id); },
    async enqueue(i) {
      const existing = messages.find(m => m.request_id === i.requestId);
      if (existing) {
        if (existing.body !== i.body) throw Object.assign(new Error('Conflict'), { status: 409 });
        return { message: existing, created: false };
      }
      const message = { id: randomUUID(), request_id: i.requestId, recipient: i.to, body: i.body, requested_device_id: i.deviceId ?? null, status: 'queued' };
      messages.push(message); return { message, created: true };
    },
    async claim(id) {
      if (messages.some(m => m.device_id === id && m.status === 'dispatched')) return;
      const m = messages.find(m => m.status === 'queued' && (!m.requested_device_id || m.requested_device_id === id));
      if (m) Object.assign(m, { device_id: id, status: 'dispatched' }); return m;
    },
    async result(id, mid, status, error) {
      const m = messages.find(m => m.id === mid && m.device_id === id);
      if (!m || !['dispatched', 'unknown', status].includes(m.status)) return;
      m.status = status; m.error = error; return m;
    },
    async disconnect(id) { for (const m of messages) if (m.device_id === id && m.status === 'dispatched') m.status = 'unknown'; }
  };
  const apiToken = 'a'.repeat(32);
  const app = await createServer({ apiToken, store });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await fetch(base + '/devices')).status, 401);
  assert.equal((await call('/sms', { body: 'invalid' })).status, 400);
  const device = await (await call('/devices', { id: 'tablet-1', name: 'Test' })).json();
  const payload = { requestId: 'request-1', to: '+639171234567', body: 'Test' };
  const response = await call('/sms', payload);
  assert.equal(response.status, 202);
  const message = await response.json(); assert.equal(message.status, 'queued');
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/device?deviceId=tablet-1', { headers: { Authorization: `Bearer ${device.token}` } });
  const inbox = []; const waiting = [];
  ws.on('message', raw => { const event = JSON.parse(raw); if (waiting.length) waiting.shift()(event); else inbox.push(event); });
  const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise(resolve => waiting.push(resolve));
  await once(ws, 'open');
  assert.equal((await next()).type, 'device.ready');
  const command = await next(); assert.equal(command.messageId, message.id);
  ws.send(JSON.stringify({ type: 'sms.result', messageId: message.id, status: 'sent' }));
  assert.equal((await next()).type, 'sms.result.ack');
  assert.equal((await (await call('/sms/' + message.id)).json()).status, 'sent');
  assert.equal((await call('/sms', payload)).status, 200);
  assert.equal(messages.length, 1);
  assert.equal((await call('/sms', { ...payload, body: 'different' })).status, 409);
  ws.send(JSON.stringify({ type: 'sms.result', messageId: message.id, status: 'failed' }));
  assert.equal((await next()).type, 'error');
  const second = await (await call('/sms', { ...payload, requestId: 'request-2' })).json();
  // Result acknowledgment and a new API request must not bypass the cooldown.
  assert.equal((await (await call('/sms/' + second.id)).json()).status, 'queued');
  // No additional API request is needed: the dispatcher wakes this job itself.
  assert.equal((await next()).messageId, second.id);
  ws.send(JSON.stringify({ type: 'sms.result', messageId: second.id, status: 'unknown', error: 'Modem send timed out' }));
  assert.equal((await next()).status, 'unknown');
  assert.equal((await store.get(second.id)).error, 'Modem send timed out');
  // Unknown results are replayable, and later positive confirmation resolves them.
  ws.send(JSON.stringify({ type: 'sms.result', messageId: second.id, status: 'unknown', error: 'Modem send timed out' }));
  assert.equal((await next()).status, 'unknown');
  ws.send(JSON.stringify({ type: 'sms.result', messageId: second.id, status: 'sent' }));
  assert.equal((await next()).status, 'sent');
  ws.send(JSON.stringify({ type: 'sms.result', messageId: second.id, status: 'sent' }));
  assert.equal((await next()).status, 'sent');
  ws.send(JSON.stringify({ type: 'sms.result', messageId: second.id, status: 'unknown' }));
  assert.equal((await next()).type, 'error');
  assert.equal((await store.get(second.id)).status, 'sent');
  const third = await (await call('/sms', { ...payload, requestId: 'request-3' })).json();
  assert.equal((await next()).messageId, third.id);
  ws.close(); await once(ws, 'close');
  // Close-event reconciliation is asynchronous.
  for (let i = 0; i < 20 && (await store.get(third.id)).status !== 'unknown'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await store.get(third.id)).status, 'unknown');
});
