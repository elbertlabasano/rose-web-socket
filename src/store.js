import mysql from 'mysql2/promise';
import { createHash, randomUUID } from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('hex');
export function createStore(env = process.env) {
  const pool = mysql.createPool({ host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME || 'rose_sms', socketPath: env.DB_SOCKET || undefined, timezone: 'Z', connectionLimit: 5 });
  const query = async (sql, args = []) => (await pool.execute(sql, args))[0];
  return {
    pool,
    async device(id) { return (await query('SELECT * FROM devices WHERE id = ?', [id]))[0]; },
    async register(id, name, token) { await query('INSERT INTO devices (id, name, token_hash) VALUES (?, ?, ?)', [id, name, hash(token)]); },
    async devices() { return query('SELECT id, name, last_seen_at FROM devices'); },
    async seen(id) { await query('UPDATE devices SET last_seen_at = UTC_TIMESTAMP(3) WHERE id = ?', [id]); },
    async get(id) { return (await query('SELECT * FROM messages WHERE id = ?', [id]))[0]; },
    async enqueue(input) {
      try {
        const id = randomUUID();
        await query('INSERT INTO messages (id, request_id, requested_device_id, recipient, body) VALUES (?, ?, ?, ?, ?)', [id, input.requestId, input.deviceId ?? null, input.to, input.body]);
        return { message: await this.get(id), created: true };
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        const message = (await query('SELECT * FROM messages WHERE request_id = ?', [input.requestId]))[0];
        if (!message || message.recipient !== input.to || message.body !== input.body || message.requested_device_id !== (input.deviceId ?? null)) throw Object.assign(new Error('requestId already used for another message'), { status: 409 });
        return { message, created: false };
      }
    },
    async claim(deviceId) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        // Lock the device so concurrent dispatches cannot assign it two messages.
        await connection.execute('SELECT id FROM devices WHERE id = ? FOR UPDATE', [deviceId]);
        const [busy] = await connection.execute("SELECT id FROM messages WHERE device_id = ? AND status = 'dispatched' LIMIT 1", [deviceId]);
        if (busy.length) { await connection.commit(); return; }
        // The device lock above serializes claims for a device. A plain locking
        // read also works on MariaDB 10.4, which does not support SKIP LOCKED.
        const [rows] = await connection.execute("SELECT id FROM messages WHERE status = 'queued' AND (requested_device_id IS NULL OR requested_device_id = ?) ORDER BY created_at, id LIMIT 1 FOR UPDATE", [deviceId]);
        if (!rows.length) { await connection.commit(); return; }
        await connection.execute("UPDATE messages SET device_id = ?, status = 'dispatched', dispatched_at = UTC_TIMESTAMP(3) WHERE id = ?", [deviceId, rows[0].id]);
        await connection.commit();
        return this.get(rows[0].id);
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
    async result(deviceId, id, status, error) {
      await query("UPDATE messages SET status = ?, error = ?, sent_at = IF(? = 'sent', UTC_TIMESTAMP(3), NULL) WHERE id = ? AND device_id = ? AND status IN ('dispatched', 'unknown')", [status, error, status, id, deviceId]);
      const message = await this.get(id);
      return message?.device_id === deviceId && message.status === status ? message : undefined;
    },
    async disconnect(id) { await query("UPDATE messages SET status = 'unknown', error = 'Device disconnected before confirmation' WHERE device_id = ? AND status = 'dispatched'", [id]); },
    async recover() { await query("UPDATE messages SET status = 'unknown', error = 'Server restarted before confirmation' WHERE status = 'dispatched'"); },
    async expire(seconds) { await query("UPDATE messages SET status = 'unknown', error = 'Confirmation timed out' WHERE status = 'dispatched' AND dispatched_at < TIMESTAMPADD(SECOND, -?, UTC_TIMESTAMP(3))", [seconds]); },
    async ping() { await query('SELECT 1'); },
    async close() { await pool.end(); }
  };
}
