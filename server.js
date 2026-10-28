import http from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createStore, hash } from './src/store.js';
import { createDispatchLimiter } from './src/dispatch-limiter.js';

const devicePattern = /^[a-zA-Z0-9_-]{1,100}$/;
const requestIdPattern = /^[\x21-\x7e]{1,200}$/;
const phonePattern = /^\+[1-9]\d{6,14}$/;
const resultStatuses = ['sent', 'failed', 'unknown'];
const maxPayloadBytes = 16384;

function equal(a, b) {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}

function report(error) {
  console.error('SMS service error:', error.code || error.message);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendEvent(socket, event) {
  socket.send(JSON.stringify(event));
}

async function readJsonBody(request, response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxPayloadBytes) {
      sendJson(response, 413, { error: 'Request too large' });
      return;
    }
    chunks.push(chunk);
  }

  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    sendJson(response, 400, { error: 'Invalid JSON' });
    return;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    sendJson(response, 400, { error: 'Expected a JSON object' });
    return;
  }
  return input;
}

function validOptionalSource(value, maxLength) {
  return value === undefined || value === null ||
    (typeof value === 'string' && value.trim().length > 0 && [...value].length <= maxLength);
}

function validSmsRequest({ deviceId, to, body, requestId }) {
  return (
    typeof requestId === 'string' && requestIdPattern.test(requestId) &&
    typeof to === 'string' && phonePattern.test(to) &&
    typeof body === 'string' && body.trim() && body.length <= 1600 &&
    (deviceId === undefined || (typeof deviceId === 'string' && devicePattern.test(deviceId)))
  );
}

export function publicMessage(message) {
  return {
    id: message.id,
    requestId: message.request_id,
    source: message.source ?? null,
    sourceId: message.source_id ?? null,
    sourceRequestType: message.source_request_type ?? null,
    deviceId: message.device_id ?? message.requested_device_id,
    to: message.recipient,
    body: message.body,
    status: message.status,
    error: message.error,
    createdAt: message.created_at,
    updatedAt: message.updated_at,
    sentAt: message.sent_at
  };
}

export async function createServer({
  apiToken,
  store,
  ackTimeoutSeconds = 120,
  dispatchLimiter = createDispatchLimiter()
} = {}) {
  if (!apiToken || apiToken.length < 24) {
    throw new Error('API_TOKEN must contain at least 24 characters');
  }
  await store.ping();
  await store.recover();

  const devices = new Map();
  const dispatching = new Set();
  const pending = new Set();
  let stopping = false;
  let ticking = false;

  function track(promise) {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  }

  async function dispatch(deviceId) {
    if (stopping || dispatching.has(deviceId) || !dispatchLimiter.ready(deviceId)) return;
    const socket = devices.get(deviceId);
    if (socket?.readyState !== WebSocket.OPEN) return;

    dispatching.add(deviceId);
    try {
      const message = await store.claim(deviceId);
      if (!message) return;
      if (socket.readyState !== WebSocket.OPEN) {
        await store.disconnect(deviceId);
        return;
      }

      // Failed/unknown attempts consume a rate-limit slot too.
      dispatchLimiter.dispatched(deviceId);
      sendEvent(socket, {
        type: 'sms.send',
        messageId: message.id,
        to: message.recipient,
        body: message.body
      });
    } finally {
      dispatching.delete(deviceId);
    }
  }

  function dispatchAll() {
    return Promise.all([...devices.keys()].map(dispatch));
  }

  async function listDevices(response) {
    const registered = await store.devices();
    sendJson(response, 200, {
      devices: registered.map(device => ({
        id: device.id,
        name: device.name,
        lastSeenAt: device.last_seen_at,
        connected: devices.has(device.id)
      }))
    });
  }

  async function registerDevice(input, response) {
    if (
      !devicePattern.test(input.id ?? '') ||
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 200
    ) {
      return sendJson(response, 400, { error: 'Provide device id and name' });
    }
    const token = randomBytes(32).toString('hex');
    try {
      await store.register(input.id, input.name, token);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return sendJson(response, 409, { error: 'Device already exists' });
      }
      throw error;
    }
    sendJson(response, 201, { id: input.id, token });
  }

  async function enqueueSms(input, response) {
    if (!validOptionalSource(input.source, 100) || !validOptionalSource(input.sourceId, 200) ||
        !validOptionalSource(input.sourceRequestType, 100)) {
      return sendJson(response, 400, {
        error: 'source, sourceId, and sourceRequestType must be null or non-blank strings of at most 100, 200, and 100 characters respectively'
      });
    }
    if (!validSmsRequest(input)) {
      return sendJson(response, 400, {
        error: 'Provide requestId (1–200 printable ASCII characters), to (+ international number), body (1–1600 characters), and optional deviceId'
      });
    }
    if (input.deviceId && !await store.device(input.deviceId)) {
      return sendJson(response, 404, { error: 'Device not found' });
    }
    const result = await store.enqueue(input);
    sendJson(response, result.created ? 202 : 200, publicMessage(result.message));
    track(dispatchAll()).catch(report);
  }

  async function handleHttpRequest(request, response) {
    try {
      const { pathname } = new URL(request.url, 'http://localhost');
      const method = request.method;
      if (pathname === '/health' && method === 'GET') {
        await store.ping();
        return sendJson(response, 200, { ok: true });
      }
      if (!equal(request.headers.authorization || '', 'Bearer ' + apiToken)) {
        return sendJson(response, 401, { error: 'Unauthorized' });
      }
      if (pathname === '/devices' && method === 'GET') {
        return await listDevices(response);
      }
      if (pathname.startsWith('/sms/') && method === 'GET') {
        const message = await store.get(pathname.slice(5));
        return sendJson(
          response,
          message ? 200 : 404,
          message ? publicMessage(message) : { error: 'Message not found' }
        );
      }
      if (!['/sms', '/devices'].includes(pathname) || method !== 'POST') {
        return sendJson(response, 404, { error: 'Not found' });
      }

      const input = await readJsonBody(request, response);
      if (!input) return;
      if (pathname === '/devices') {
        return await registerDevice(input, response);
      }
      await enqueueSms(input, response);
    } catch (error) {
      report(error);
      if (!response.headersSent) {
        sendJson(response, error.status || 500, {
          error: error.status ? error.message : 'Internal server error'
        });
      }
    }
  }

  async function handleDeviceResult(deviceId, socket, raw) {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return sendEvent(socket, { type: 'error', error: 'Invalid JSON' });
    }
    if (
      event?.type !== 'sms.result' ||
      typeof event.messageId !== 'string' ||
      !resultStatuses.includes(event.status)
    ) {
      return sendEvent(socket, { type: 'error', error: 'Invalid result' });
    }

    const error = event.status === 'sent'
      ? null
      : String(event.error ?? 'Device could not confirm sending').slice(0, 1000);
    const message = await store.result(deviceId, event.messageId, event.status, error);
    if (socket.readyState === WebSocket.OPEN) {
      sendEvent(socket, message
        ? { type: 'sms.result.ack', messageId: message.id, status: message.status }
        : { type: 'error', error: 'Invalid message or status transition' });
    }
    await dispatchAll();
  }

  function connectDevice(deviceId, socket) {
    devices.set(deviceId, socket);
    socket.alive = true;
    socket.on('error', report);
    socket.on('pong', () => {
      socket.alive = true;
      store.seen(deviceId).catch(report);
    });

    // Process results before reconciling a following disconnect.
    let events = Promise.resolve();
    socket.on('message', raw => {
      events = events.then(() => handleDeviceResult(deviceId, socket, raw)).catch(report);
    });
    socket.on('close', () => {
      events = track(events.then(async () => {
        await store.disconnect(deviceId);
        devices.delete(deviceId);
      })).catch(report);
    });
    sendEvent(socket, { type: 'device.ready', deviceId });
    track(store.seen(deviceId).then(dispatchAll)).catch(report);
  }

  async function handleUpgrade(request, socket, head) {
    const url = new URL(request.url, 'http://localhost');
    const deviceId = url.searchParams.get('deviceId');
    const device = devicePattern.test(deviceId ?? '')
      ? await store.device(deviceId)
      : undefined;
    const authorization = request.headers.authorization || '';
    if (
      stopping || url.pathname !== '/device' || !device ||
      !authorization.startsWith('Bearer ') ||
      !equal(hash(authorization.slice(7)), device.token_hash)
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    if (devices.has(deviceId)) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, client => connectDevice(deviceId, client));
  }

  async function checkConnections() {
    if (ticking || stopping) return;
    ticking = true;
    try {
      for (const socket of devices.values()) {
        if (!socket.alive) {
          socket.terminate();
        } else {
          socket.alive = false;
          socket.ping();
        }
      }
      await store.expire(ackTimeoutSeconds);
      await dispatchAll();
    } catch (error) {
      report(error);
    } finally {
      ticking = false;
    }
  }

  const server = http.createServer(handleHttpRequest);
  server.requestTimeout = 15000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    handleUpgrade(request, socket, head).catch(error => {
      report(error);
      socket.destroy();
    });
  });

  const heartbeatTimer = setInterval(checkConnections, 10000);
  heartbeatTimer.unref();

  // Resume queued jobs after their cooldown, independently of the heartbeat.
  const dispatchTimer = setInterval(() => {
    if (!stopping) track(dispatchAll()).catch(report);
  }, 1000);
  dispatchTimer.unref();

  async function close() {
    stopping = true;
    clearInterval(heartbeatTimer);
    clearInterval(dispatchTimer);
    const closed = [...devices.values()].map(socket => new Promise(resolve => {
      socket.once('close', resolve);
      socket.terminate();
    }));
    await Promise.all(closed);
    await new Promise(resolve => server.close(resolve));
    while (pending.size) await Promise.allSettled([...pending]);
    wss.close();
  }

  return { server, close };
}

async function startServer() {
  const store = createStore();
  try {
    const app = await createServer({ apiToken: process.env.API_TOKEN, store });
    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || '0.0.0.0';
    app.server.listen(port, host, () => console.log('SMS service listening on port', port));

    let closing = false;
    async function shutdown() {
      if (closing) return;
      closing = true;
      await app.close();
      await store.close();
    }
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, shutdown);
    }
  } catch (error) {
    console.error('Startup failed:', error.code || error.message);
    await store.close();
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer();
}
