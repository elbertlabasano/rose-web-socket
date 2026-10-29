import { readFile } from 'node:fs/promises';
import { createStore } from '../src/store.js';
import { migrateMessageSources } from '../src/migrations.js';
import { migrateAdmin } from '../src/admin-schema.js';
const store = createStore();
try {
  const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  for (const statement of sql.split(';').filter(s => s.trim())) await store.pool.query(statement);
  await migrateMessageSources(store.pool);
  await migrateAdmin(store.pool, process.env.SSO_BOOTSTRAP_ADMIN_IDCODE || '20260211');
  console.log('Database tables ready');
} finally { await store.close(); }
