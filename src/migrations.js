// Run migrations once during deployment, before starting the service.
export async function migrateMessageSources(connection) {
  const [columns] = await connection.query('SHOW COLUMNS FROM messages');
  const existingColumns = new Set(columns.map(column => column.Field));
  const additions = [
    ['source', 'VARCHAR(100) NULL'],
    ['source_id', 'VARCHAR(200) NULL'],
    ['source_request_type', 'VARCHAR(100) NULL']
  ].filter(([name]) => !existingColumns.has(name))
    .map(([name, definition]) => `ADD COLUMN ${name} ${definition}`);

  const [indexes] = await connection.query('SHOW INDEX FROM messages');
  if (!indexes.some(index => index.Key_name === 'source_lookup')) {
    additions.push('ADD INDEX source_lookup (source, source_id, source_request_type)');
  }
  if (additions.length) {
    await connection.query(`ALTER TABLE messages ${additions.join(', ')}`);
  }
}
