export async function migrateAdmin(pool, bootstrapIdcode = '20260211') {
  const statements = [
    `CREATE TABLE IF NOT EXISTS sms_admin_settings (name VARCHAR(50) PRIMARY KEY, value VARCHAR(200) NOT NULL) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS sms_admins (
      idcode VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      issuer VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
      subject VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
      display_name VARCHAR(200) NULL, active BOOLEAN NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY sso_identity (issuer, subject)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS sms_sessions (
      id_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      data TEXT NOT NULL, idcode VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
      expires_at DATETIME(3) NOT NULL, INDEX session_expiry (expires_at), INDEX session_admin (idcode)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS sms_api_tokens (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      name VARCHAR(100) NOT NULL, prefix VARCHAR(12) NOT NULL,
      token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
      created_by VARCHAR(100) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      expires_at DATETIME(3) NULL, revoked_at DATETIME(3) NULL, last_used_at DATETIME(3) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  ];
  for (const sql of statements) await pool.query(sql);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(bootstrapIdcode)) throw new Error('Invalid bootstrap admin idcode');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.execute("INSERT IGNORE INTO sms_admin_settings (name, value) VALUES ('bootstrap_admin', ?)", [bootstrapIdcode]);
    if (result.affectedRows) await connection.execute('INSERT IGNORE INTO sms_admins (idcode) VALUES (?)', [bootstrapIdcode]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}
