import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config-sql/database.js';

/**
 * Next admission number for the current calendar year (e.g. 20260057).
 * Must run inside an open transaction on `executor` when approving joinings so
 * a rollback does not leave burned sequence values.
 *
 * @param {import('mysql2/promise').Pool | import('mysql2/promise').PoolConnection} [executor]
 */
export async function generateAdmissionNumber(executor) {
  const db = executor || getPool();
  const currentYear = new Date().getFullYear();
  const yearPrefix = String(currentYear);

  const [sequences] = await db.execute(
    'SELECT id, last_sequence FROM admission_sequences WHERE year = ? FOR UPDATE',
    [currentYear]
  );

  const [maxRows] = await db.execute(
    `SELECT MAX(CAST(SUBSTRING(admission_number, 5) AS UNSIGNED)) AS max_seq
     FROM admissions
     WHERE admission_number LIKE ?`,
    [`${yearPrefix}%`]
  );

  const maxFromAdmissions = Number(maxRows[0]?.max_seq || 0);
  const lastFromSequence = sequences.length > 0 ? Number(sequences[0].last_sequence || 0) : 0;
  const sequenceNumber = Math.max(maxFromAdmissions, lastFromSequence) + 1;

  if (sequences.length > 0) {
    await db.execute(
      'UPDATE admission_sequences SET last_sequence = ?, updated_at = NOW() WHERE year = ?',
      [sequenceNumber, currentYear]
    );
  } else {
    await db.execute(
      'INSERT INTO admission_sequences (id, year, last_sequence, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
      [uuidv4(), currentYear, sequenceNumber]
    );
  }

  return `${yearPrefix}${String(sequenceNumber).padStart(4, '0')}`;
}

/**
 * Align admission_sequences with the highest issued admission number (heals drift).
 */
export async function syncAdmissionSequenceFromAdmissions(executor) {
  const db = executor || getPool();
  const currentYear = new Date().getFullYear();
  const yearPrefix = String(currentYear);

  const [maxRows] = await db.execute(
    `SELECT MAX(CAST(SUBSTRING(admission_number, 5) AS UNSIGNED)) AS max_seq
     FROM admissions
     WHERE admission_number LIKE ?`,
    [`${yearPrefix}%`]
  );
  const maxSeq = Number(maxRows[0]?.max_seq || 0);

  const [sequences] = await db.execute(
    'SELECT id, last_sequence FROM admission_sequences WHERE year = ? FOR UPDATE',
    [currentYear]
  );

  if (sequences.length > 0) {
    if (Number(sequences[0].last_sequence || 0) !== maxSeq) {
      await db.execute(
        'UPDATE admission_sequences SET last_sequence = ?, updated_at = NOW() WHERE year = ?',
        [maxSeq, currentYear]
      );
    }
  } else if (maxSeq > 0) {
    await db.execute(
      'INSERT INTO admission_sequences (id, year, last_sequence, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
      [uuidv4(), currentYear, maxSeq]
    );
  }

  return maxSeq;
}
