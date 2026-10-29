import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { migrateAdmin } from '../src/admin-schema.js';
import { createAdminStore } from '../src/admin-store.js';

test('SQL admin identities, bootstrap, session expiry, token hashes and revocation', { skip: !process.env.DB_NAME }, async t => {
  const connection = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, socketPath: process.env.DB_SOCKET || undefined, timezone: 'Z' });
  t.after(() => connection.end());
  // Convert only CREATE TABLE to temporary tables so real tables are shadowed.
  // Every operation stays on this one connection and is discarded on disconnect.
  const pool = {
    query(sql, args) { return connection.query(sql.replace(/^CREATE TABLE IF NOT EXISTS /, 'CREATE TEMPORARY TABLE IF NOT EXISTS '), args); },
    execute: (...args) => connection.execute(...args),
    async getConnection() { return { execute: (...args) => connection.execute(...args), beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(), rollback: () => connection.rollback(), release() {} }; }
  };
  await migrateAdmin(pool);
  const store = createAdminStore(pool);
  assert.equal((await store.admins()).length, 1);
  assert.equal(await store.login('unapproved', 'issuer', 'sub', 'Other'), undefined);
  assert.equal((await store.login('20260211', 'issuer', 'sub', 'Admin')).idcode, '20260211');
  assert.equal(await store.login('20260211', 'issuer', 'replacement-sub', 'Other'), undefined);
  await assert.rejects(store.revokeAdmin('20260211', '20260211'));
  await store.addAdmin('000234');
  await store.saveSession('valid', { idcode: '000234', csrf: 'csrf' }, new Date(Date.now() + 60000));
  await store.saveSession('expired', { idcode: '000234' }, new Date(Date.now() - 10000));
  assert.equal((await store.session('valid')).idcode, '000234');
  assert.equal(await store.session('expired'), undefined);
  await store.saveSession('pending', { state: 'abc' }, new Date(Date.now() + 60000));
  assert.equal((await store.consumeSession('pending')).state, 'abc');
  assert.equal(await store.consumeSession('pending'), undefined);
  const token = await store.createToken('Orders', null, '20260211');
  const [rows] = await connection.query('SELECT * FROM sms_api_tokens');
  assert.notEqual(rows[0].token_hash, token.secret);
  assert.equal(JSON.stringify(await store.tokens()).includes(token.secret), false);
  assert.equal(await store.authenticateToken(token.secret), true);
  await store.revokeToken(token.id);
  assert.equal(await store.authenticateToken(token.secret), false);
  const expired = await store.createToken('Expired', new Date(Date.now() - 10000), '20260211');
  assert.equal(await store.authenticateToken(expired.secret), false);
  await store.revokeAdmin('000234', '20260211');
  assert.equal(await store.session('valid'), undefined);
  // Re-running deployment must not resurrect a revoked bootstrap admin.
  await store.revokeAdmin('20260211', 'different-admin');
  await migrateAdmin(pool);
  assert.equal((await store.admins()).find(admin => admin.idcode === '20260211').active, 0);
});
