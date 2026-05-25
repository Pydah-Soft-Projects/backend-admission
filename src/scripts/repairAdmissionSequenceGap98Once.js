/**
 * Reset admission_sequences so the next issued number is 20260098 (lowest gap).
 * Also verifies findNextAdmissionSequenceNumber returns 98.
 *
 * Usage: node src/scripts/repairAdmissionSequenceGap98Once.js
 */
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';
import { findNextAdmissionSequenceNumber } from '../utils/admissionNumber.util.js';

dotenv.config();

async function main() {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [before] = await conn.execute(
      'SELECT year, last_sequence FROM admission_sequences WHERE year = 2026 FOR UPDATE'
    );

    const nextSeq = await findNextAdmissionSequenceNumber(conn, 2026);
    const nextNumber = `2026${String(nextSeq).padStart(4, '0')}`;

    if (nextSeq !== 98) {
      throw new Error(
        `Expected next sequence 98 but got ${nextSeq} (${nextNumber}). Aborting.`
      );
    }

    await conn.execute(
      'UPDATE admission_sequences SET last_sequence = ?, updated_at = NOW() WHERE year = ?',
      [97, 2026]
    );

    await conn.commit();

    const [after] = await pool.execute(
      'SELECT year, last_sequence FROM admission_sequences WHERE year = 2026'
    );

    const verifyNext = await findNextAdmissionSequenceNumber(pool, 2026);

    console.log(
      JSON.stringify(
        {
          ok: true,
          before,
          after,
          nextAdmissionNumberWillBe: nextNumber,
          verifyNextSequence: verifyNext,
          note: 'New joinings approved will receive 20260098 next.',
        },
        null,
        2
      )
    );
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
