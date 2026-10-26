import { readFile } from 'node:fs/promises';
import { createStore } from '../src/store.js';
const store = createStore();
try {
  const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  for (const statement of sql.split(';').filter(s => s.trim())) await store.pool.query(statement);
  console.log('Database tables ready');
} finally { await store.close(); }
