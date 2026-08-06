const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const migrations = [
  '001_extensions.sql',
  '002_schema.sql',
  '005_application_modules.sql',
  '006_role_workflow.sql',
  '007_total_transaction_import.sql',
  '008_management_notifications.sql',
  '009_card_lifecycle_reporting.sql',
  '010_request_card_synchronization.sql',
  '011_off_park_consumption_allocation.sql',
  '012_user_email_domain.sql',
  '013_user_password.sql',
  '014_default_users.sql',
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
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
      const sqlPath = path.resolve(__dirname, '../../../sql', filename);
      await client.query(fs.readFileSync(sqlPath, 'utf8'));
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
