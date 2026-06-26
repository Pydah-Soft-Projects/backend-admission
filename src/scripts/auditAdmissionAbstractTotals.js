/**
 * Verify abstract bucket sums (CQ+MQ+Spot) equal active admission totals per course/branch.
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import {
  SQL_IS_CONV_QUOTA,
  SQL_IS_MANG_QUOTA,
  SQL_IS_SPOT_QUOTA,
} from '../utils/quotaClassification.util.js';

dotenv.config();

async function main() {
  const pool = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const sql = `
    SELECT
      COALESCE(NULLIF(TRIM(course), ''), '(no course)') AS courseName,
      COALESCE(NULLIF(TRIM(branch), ''), '(no branch)') AS branchName,
      COUNT(CASE WHEN status = 'active' THEN 1 END) AS totalActive,
      COUNT(CASE WHEN ${SQL_IS_CONV_QUOTA} AND status = 'active' THEN 1 END) AS cqAdmitted,
      COUNT(CASE WHEN ${SQL_IS_MANG_QUOTA} AND status = 'active' THEN 1 END) AS mqAdmitted,
      COUNT(CASE WHEN ${SQL_IS_SPOT_QUOTA} AND status = 'active' THEN 1 END) AS spotAdmitted
    FROM admissions
    GROUP BY courseName, branchName
    HAVING totalActive > 0
    ORDER BY courseName, branchName
  `;
  const [rows] = await pool.execute(sql);

  const mismatches = [];
  const byCourse = new Map();

  for (const row of rows) {
    const total = Number(row.totalActive) || 0;
    const cq = Number(row.cqAdmitted) || 0;
    const mq = Number(row.mqAdmitted) || 0;
    const spot = Number(row.spotAdmitted) || 0;
    const sum = cq + mq + spot;
    const gap = total - sum;

    const cKey = row.courseName;
    if (!byCourse.has(cKey)) {
      byCourse.set(cKey, { total: 0, cq: 0, mq: 0, spot: 0, gap: 0 });
    }
    const c = byCourse.get(cKey);
    c.total += total;
    c.cq += cq;
    c.mq += mq;
    c.spot += spot;
    c.gap += gap;

    if (gap !== 0) {
      mismatches.push({ ...row, totalActive: total, cqAdmitted: cq, mqAdmitted: mq, spotAdmitted: spot, gap });
    }
  }

  console.log('\n=== Abstract totals by course (active admissions) ===\n');
  console.log('Course'.padEnd(32), '| Total | CQ | MQ | Spot | Gap');
  console.log('-'.repeat(72));
  for (const [course, c] of [...byCourse.entries()].sort((a, b) => b[1].total - a[1].total)) {
    const flag = c.gap !== 0 ? ' ⚠' : '';
    console.log(
      `${course.padEnd(32)} | ${String(c.total).padStart(5)} | ${String(c.cq).padStart(3)} | ${String(c.mq).padStart(3)} | ${String(c.spot).padStart(4)} | ${String(c.gap).padStart(3)}${flag}`
    );
  }

  if (mismatches.length) {
    console.log('\n--- Branch-level gaps (total != CQ+MQ+Spot) ---');
    for (const m of mismatches) {
      console.log(
        `${m.courseName} / ${m.branchName}: total=${m.totalActive} cq=${m.cqAdmitted} mq=${m.mqAdmitted} spot=${m.spotAdmitted} gap=${m.gap}`
      );
    }
  } else {
    console.log('\nAll course/branch rows reconcile: total = CQ + MQ + Spot.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
