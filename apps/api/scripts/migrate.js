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
  '015_default_company.sql',
  '016_card_distribution_status.sql',
  '017_transaction_review_workflow.sql',
  '018_off_park_responsibles_vehicles.sql',
  '019_mileage_funding_workflow.sql',
  '020_totalenergies_transaction_details.sql',
  '021_vehicle_registration_dates.sql',
  '022_company_driver_fuel_receipts.sql',
  '023_card_company_view.sql',
  '024_transaction_beneficiary_linking.sql',
  '025_total_card_reference.sql',
  '026_reconcile_blocked_total_transactions.sql',
  '027_complete_total_card_reference.sql',
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
      const sql = fs.readFileSync(sqlPath, 'utf8');
      if (['025_total_card_reference.sql', '027_complete_total_card_reference.sql'].includes(filename)) {
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
