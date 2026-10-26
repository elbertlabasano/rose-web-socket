import http from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createStore, hash } from './src/store.js';
const devicePattern = /^[a-zA-Z0-9_-]{1,100}$/;
const equal = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export function publicMessage(m) {
  return { id: m.id, requestId: m.request_id, deviceId: m.device_id ?? m.requested_device_id, to: m.recipient, body: m.body, status: m.status, error: m.error, createdAt: m.created_at, updatedAt: m.updated_at, sentAt: m.sent_at };
}
export async function createServer({ apiToken, store, ackTimeoutSeconds = 120 } = {}) {
  if (!apiToken || apiToken.length < 24) throw new Error('API_TOKEN must contain at least 24 characters');
  await store.ping();
  await store.recover();
  const devices = new Map();
  const dispatching = new Set();
  const pending = new Set();
  const track = promise => { pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}); return promise; };
  let stopping = false;
  const report = error => console.error('SMS service error:', error.code || error.message);
  async function dispatch(id) {
    if (stopping || dispatching.has(id)) return;
    const ws = devices.get(id);
    if (ws?.readyState !== WebSocket.OPEN) return;
    dispatching.add(id);
    try {
      const m = await store.claim(id);
      if (m) {
        if (ws.readyState !== WebSocket.OPEN) await store.disconnect(id);
        else ws.send(JSON.stringify({ type: 'sms.send', messageId: m.id, to: m.recipient, body: m.body }));
      }
    } finally { dispatching.delete(id); }
  }
  const dispatchAll = () => Promise.all([...devices.keys()].map(dispatch));
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health' && req.method === 'GET') { await store.ping(); return send(res, 200, { ok: true }); }
      if (!equal(req.headers.authorization || '', `Bearer ${apiToken}`)) return send(res, 401, { error: 'Unauthorized' });
      if (url.pathname === '/devices' && req.method === 'GET') return send(res, 200, { devices: (await store.devices()).map(d => ({ id: d.id, name: d.name, lastSeenAt: d.last_seen_at, connected: devices.has(d.id) })) });
      if (url.pathname.startsWith('/sms/') && req.method === 'GET') {
        const m = await store.get(url.pathname.slice(5));
        return send(res, m ? 200 : 404, m ? publicMessage(m) : { error: 'Message not found' });
      }
      if (!['/sms', '/devices'].includes(url.pathname) || req.method !== 'POST') return send(res, 404, { error: 'Not found' });
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 16384) return send(res, 413, { error: 'Request too large' }); chunks.push(chunk); }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(res, 400, { error: 'Expected a JSON object' });
      if (url.pathname === '/devices') {
        if (!devicePattern.test(input.id ?? '') || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) return send(res, 400, { error: 'Provide device id and name' });
        const token = randomBytes(32).toString('hex');
        try { await store.register(input.id, input.name, token); } catch (e) { if (e.code === 'ER_DUP_ENTRY') return send(res, 409, { error: 'Device already exists' }); throw e; }
        return send(res, 201, { id: input.id, token });
      }
      const { deviceId, to, body, requestId } = input;
      if (typeof requestId !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(requestId) || typeof to !== 'string' || !/^\+[1-9]\d{6,14}$/.test(to) || typeof body !== 'string' || !body.trim() || body.length > 1600 || (deviceId !== undefined && (typeof deviceId !== 'string' || !devicePattern.test(deviceId)))) return send(res, 400, { error: 'Provide requestId (1–200 printable ASCII characters), to (+ international number), body (1–1600 characters), and optional deviceId' });
      if (deviceId && !await store.device(deviceId)) return send(res, 404, { error: 'Device not found' });
      const result = await store.enqueue(input);
      send(res, result.created ? 202 : 200, publicMessage(result.message));
      track(dispatchAll()).catch(report);
    } catch (error) { report(error); if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' }); }
  });
  server.requestTimeout = 15000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    (async () => {
      const url = new URL(req.url, 'http://localhost');
      const id = url.searchParams.get('deviceId');
      const d = devicePattern.test(id ?? '') ? await store.device(id) : undefined;
      const auth = req.headers.authorization || '';
      if (stopping || url.pathname !== '/device' || !d || !auth.startsWith('Bearer ') || !equal(hash(auth.slice(7)), d.token_hash)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
      if (devices.has(id)) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        devices.set(id, ws); ws.alive = true;
        ws.on('pong', () => { ws.alive = true; store.seen(id).catch(report); });
        ws.on('error', report);
        // Serialize device events so disconnect reconciliation follows outstanding results.
        let events = Promise.resolve();
        ws.on('message', raw => { events = events.then(async () => {
          let event;
          try { event = JSON.parse(raw.toString()); } catch { ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' })); return; }
          if (event?.type !== 'sms.result' || typeof event.messageId !== 'string' || !['sent', 'failed'].includes(event.status)) { ws.send(JSON.stringify({ type: 'error', error: 'Invalid result' })); return; }
          const m = await store.result(id, event.messageId, event.status, event.status === 'failed' ? String(event.error ?? 'Device reported failure').slice(0, 1000) : null);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m ? { type: 'sms.result.ack', messageId: m.id, status: m.status } : { type: 'error', error: 'Invalid message or status transition' }));
          await dispatchAll();
        }).catch(report); });
        ws.on('close', () => { events = track(events.then(async () => { await store.disconnect(id); devices.delete(id); })).catch(report); });
        ws.send(JSON.stringify({ type: 'device.ready', deviceId: id }));
        track(store.seen(id).then(dispatchAll)).catch(report);
      });
    })().catch(error => { report(error); socket.destroy(); });
  });
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking || stopping) return;
    ticking = true;
    try {
      for (const ws of devices.values()) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
      await store.expire(ackTimeoutSeconds); await dispatchAll();
    } catch (error) { report(error); } finally { ticking = false; }
  }, 10000);
  timer.unref();
  return { server, async close() {
    stopping = true; clearInterval(timer);
    const closed = [...devices.values()].map(ws => new Promise(resolve => { ws.once('close', resolve); ws.terminate(); }));
    await Promise.all(closed);
    await new Promise(resolve => server.close(resolve));
    while (pending.size) await Promise.allSettled([...pending]);
    wss.close();
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const store = createStore();
  try {
    const app = await createServer({ apiToken: process.env.API_TOKEN, store });
    app.server.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0', () => console.log('SMS service listening on port', process.env.PORT || 3000));
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); await store.close(); });
  } catch (error) { console.error('Startup failed:', error.code || error.message); await store.close(); process.exitCode = 1; }
}
