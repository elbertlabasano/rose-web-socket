import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from './store.js';

// Dashboard queries deliberately never select message recipients or bodies.
export function createAdminStore(pool) {
  const query = async (sql, values = []) => (await pool.execute(sql, values))[0];
  return {
    async login(idcode, issuer, subject, name) {
      await query('UPDATE sms_admins SET issuer = ?, subject = ?, display_name = ? WHERE idcode = ? AND active = 1 AND (subject IS NULL OR (issuer = ? AND subject = ?))', [issuer, subject, name, idcode, issuer, subject]);
      return (await query('SELECT idcode, display_name FROM sms_admins WHERE idcode = ? AND active = 1 AND issuer = ? AND subject = ?', [idcode, issuer, subject]))[0];
    },
    async admins() { return query('SELECT idcode, display_name, active, created_at FROM sms_admins ORDER BY created_at, idcode'); },
    async addAdmin(idcode) {
      await query('INSERT INTO sms_admins (idcode) VALUES (?) ON DUPLICATE KEY UPDATE active = 1', [idcode]);
    },
    async revokeAdmin(idcode, actor) {
      if (idcode === actor) throw Object.assign(new Error('You cannot revoke your own access.'), { status: 400 });
      await query('UPDATE sms_admins SET active = 0 WHERE idcode = ?', [idcode]);
      await query('DELETE FROM sms_sessions WHERE idcode = ?', [idcode]);
    },
    async saveSession(id, data, expires) {
      await query('DELETE FROM sms_sessions WHERE expires_at < UTC_TIMESTAMP(3)');
      await query('INSERT INTO sms_sessions (id_hash, data, idcode, expires_at) VALUES (?, ?, ?, ?)', [hash(id), JSON.stringify(data), data.idcode ?? null, expires]);
    },
    async session(id) {
      const row = (await query('SELECT s.data FROM sms_sessions s LEFT JOIN sms_admins a ON a.idcode = s.idcode WHERE s.id_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) AND (s.idcode IS NULL OR a.active = 1)', [hash(id)]))[0];
      return row ? JSON.parse(row.data) : undefined;
    },
    async deleteSession(id) { await query('DELETE FROM sms_sessions WHERE id_hash = ?', [hash(id)]); },
    async consumeSession(id) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.execute('SELECT data FROM sms_sessions WHERE id_hash = ? AND idcode IS NULL AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE', [hash(id)]);
        await connection.execute('DELETE FROM sms_sessions WHERE id_hash = ? AND idcode IS NULL', [hash(id)]);
        await connection.commit();
        return rows[0] ? JSON.parse(rows[0].data) : undefined;
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
    async tokens() { return query('SELECT id, name, prefix, created_by, created_at, expires_at, revoked_at, last_used_at FROM sms_api_tokens ORDER BY created_at DESC'); },
    async createToken(name, expires, actor) {
      const secret = 'sms_' + randomBytes(32).toString('hex');
      const id = randomUUID();
      await query('INSERT INTO sms_api_tokens (id, name, prefix, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [id, name, secret.slice(0, 12), hash(secret), actor, expires]);
      return { id, secret };
    },
    async revokeToken(id) { await query('UPDATE sms_api_tokens SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(3)) WHERE id = ?', [id]); },
    async authenticateToken(secret) {
      const result = await query('UPDATE sms_api_tokens SET last_used_at = UTC_TIMESTAMP(3) WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))', [hash(secret)]);
      return result.affectedRows > 0;
    },
    async status() {
      const rows = await query('SELECT status, COUNT(*) AS count FROM messages GROUP BY status');
      return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
    }
  };
}
