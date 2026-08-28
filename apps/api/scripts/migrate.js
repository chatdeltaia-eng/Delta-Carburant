const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const sqlDirectory = path.resolve(__dirname, '../../../sql');
// 003/004 sont des scripts historiques d'import ponctuel, pas des migrations
// rejouables. Toutes les autres migrations numérotées sont découvertes
// automatiquement afin qu'une nouvelle migration ne puisse plus être oubliée
// lors d'un déploiement Render.
const excludedOneOffImports = new Set([
  '003_import_najib.sql',
  '004_finalize_najib_import.sql',
]);
const migrations = fs.readdirSync(sqlDirectory)
  .filter((filename) => /^\d{3}_[a-z0-9_]+\.sql$/i.test(filename))
  .filter((filename) => !excludedOneOffImports.has(filename))
  .sort((left, right) => Number(left.slice(0, 3)) - Number(right.slice(0, 3)) || left.localeCompare(right));

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (process.env.NODE_ENV === 'production') {
    const required = ['CARD_ENCRYPTION_KEY', 'CARD_HMAC_KEY', 'PIN_ENCRYPTION_KEY'];
    const missing = required.filter((name) => !process.env[name]?.trim());
    if (missing.length) {
      throw new Error(`Missing production secrets: ${missing.join(', ')}`);
    }
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const filename of migrations) {
      const applied = await client.query(
        'SELECT 1 FROM schema_migration WHERE filename = $1',
        [filename],
      );
      if (applied.rowCount) continue;
      const sqlPath = path.join(sqlDirectory, filename);
      const sql = fs.readFileSync(sqlPath, 'utf8');
      if (['025_total_card_reference.sql', '027_complete_total_card_reference.sql', '030_replace_card_reference_41.sql', '082_materialize_total_transaction_cards.sql'].includes(filename)) {
        // node-postgres cannot use the extended (parameterized) protocol for a
        // migration containing several SQL commands. Escape the two server-side
        // secrets, then execute the migration through PostgreSQL's simple query
        // protocol without ever logging their values.
        const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
        const migrationSql = sql
          .replaceAll('$1', literal(process.env.CARD_ENCRYPTION_KEY ?? 'delta-development-card-key'))
          .replaceAll('$2', literal(process.env.CARD_HMAC_KEY ?? 'delta-development-hmac-key'));
        await client.query(migrationSql);
      } else await client.query(sql);
      await client.query('INSERT INTO schema_migration(filename) VALUES ($1)', [filename]);
      console.log(`Applied ${filename}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
