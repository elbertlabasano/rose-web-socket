import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { createStore } from '../src/store.js';
import { migrateMessageSources } from '../src/migrations.js';

// Opt in with: node --env-file=.env --test test/store.test.js
// All writes use connection-scoped temporary tables, never the real SMS queue.
test('source migration preserves legacy rows and real SQL stores metadata and deduplicates it', {
  skip: !process.env.DB_NAME
}, async t => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    socketPath: process.env.DB_SOCKET || undefined
  });
  t.after(() => connection.end());
  // Shadow messages on this connection to exercise the pre-upgrade layout.
  await connection.query(`CREATE TEMPORARY TABLE messages (
    id CHAR(36) PRIMARY KEY,
    request_id VARCHAR(200) NOT NULL UNIQUE,
    requested_device_id VARCHAR(100) NULL,
    recipient VARCHAR(16) NOT NULL,
    body TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'queued'
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await connection.execute(
    'INSERT INTO messages (id, request_id, recipient, body) VALUES (?, ?, ?, ?)',
    ['legacy-id', 'legacy', '+639171234567', 'Existing message']
  );
  await migrateMessageSources(connection);
  await migrateMessageSources(connection);
  const [legacyRows] = await connection.execute('SELECT * FROM messages WHERE id = ?', ['legacy-id']);
  assert.equal(legacyRows[0].body, 'Existing message');
  assert.equal(legacyRows[0].source, null);
  assert.equal(legacyRows[0].source_id, null);
  assert.equal(legacyRows[0].source_request_type, null);
  const [indexes] = await connection.query('SHOW INDEX FROM messages');
  assert.deepEqual(indexes.filter(index => index.Key_name === 'source_lookup')
    .sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(index => index.Column_name),
  ['source', 'source_id', 'source_request_type']);

  // Direct the production store to the same connection and temporary table.
  const poolMock = t.mock.method(mysql, 'createPool', () => connection);
  const store = createStore();
  poolMock.mock.restore();
  const payload = {
    requestId: 'source-test', to: '+639171234567', body: 'No SMS will be sent',
    source: 'branch_ordering', sourceId: '127', sourceRequestType: 'order_ready'
  };
  const result = await store.enqueue(payload);
  assert.equal(result.created, true);
  assert.equal(result.message.source, payload.source);
  assert.equal(result.message.source_id, payload.sourceId);
  assert.equal(result.message.source_request_type, payload.sourceRequestType);
  assert.equal((await store.enqueue(payload)).created, false);
  for (const field of ['source', 'sourceId', 'sourceRequestType']) {
    await assert.rejects(store.enqueue({ ...payload, [field]: 'changed' }), { status: 409 });
    await assert.rejects(store.enqueue({ ...payload, [field]: null }), { status: 409 });
  }
  const oldPayload = { requestId: 'legacy', to: '+639171234567', body: 'Existing message' };
  assert.equal((await store.enqueue(oldPayload)).created, false);
  assert.equal((await store.enqueue({ ...oldPayload, source: null, sourceId: null, sourceRequestType: null })).created, false);
  const empty = await store.enqueue({ ...oldPayload, requestId: 'no-source' });
  assert.equal(empty.message.source, null);
  assert.equal(empty.message.source_id, null);
  assert.equal(empty.message.source_request_type, null);
  const maximum = await store.enqueue({ ...payload, requestId: 'maximum', source: 'x'.repeat(100), sourceId: 'x'.repeat(200), sourceRequestType: 'x'.repeat(100) });
  assert.equal(maximum.message.source_id.length, 200);

  // Exercise a fresh schema too. Temporary tables cannot have foreign keys.
  await connection.query('DROP TEMPORARY TABLE messages');
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  for (const statement of schema.split(';').filter(sql => sql.trim())) {
    await connection.query(statement.replace('CREATE TABLE', 'CREATE TEMPORARY TABLE')
      .replace(/^\s*FOREIGN KEY[^\n]*\n/gm, '').replace(/,\s*\)/g, '\n)'));
  }
  await migrateMessageSources(connection);
  const fresh = await store.enqueue(payload);
  assert.equal(fresh.message.source_request_type, 'order_ready');
});
