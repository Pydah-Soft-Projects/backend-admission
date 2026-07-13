/**
 * Apply transport_requests cancellation columns.
 * Run: node src/scripts-sql/applyTransportRequestCancellationMigration.js
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../config-sql/database-secondary.js';
import { getTableColumnSet } from '../utils/secondarySchema.util.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const pool = getPool();
  const cols = await getTableColumnSet(pool, 'transport_requests');

  await pool.execute(
    `ALTER TABLE transport_requests
     MODIFY COLUMN status ENUM('pending', 'approved', 'rejected', 'cancelled') DEFAULT 'pending'`
  );
  console.log('Updated transport_requests.status enum.');

  if (!cols.has('cancellation_reason')) {
    await pool.execute(
      `ALTER TABLE transport_requests
       ADD COLUMN cancellation_reason VARCHAR(500) NULL AFTER status`
    );
    console.log('Added transport_requests.cancellation_reason.');
  } else {
    console.log('cancellation_reason already exists — skipped.');
  }

  console.log('Migration complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
