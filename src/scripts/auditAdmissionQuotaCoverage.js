/**
 * Audit all admissions: quota labels vs abstract buckets (CONV / MANG / SPOT).
 * Run: node src/scripts/auditAdmissionQuotaCoverage.js
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { classifyAdmissionQuotaCategory } from '../utils/quotaClassification.util.js';

dotenv.config();

const ADMISSION_CANCELLED = 'Admission Cancelled';

async function main() {
  const pool = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const [rows] = await pool.execute(
    `SELECT
       COALESCE(NULLIF(TRIM(course), ''), '(no course)') AS courseName,
       COALESCE(NULLIF(TRIM(branch), ''), '(no branch)') AS branchName,
       COALESCE(NULLIF(TRIM(quota), ''), '(empty)') AS quotaLabel,
       status,
       COUNT(*) AS cnt
     FROM admissions
     GROUP BY courseName, branchName, quotaLabel, status
     ORDER BY courseName, branchName, quotaLabel, status`
  );

  const byQuota = new Map();
  const byCourse = new Map();
  const unmatched = [];
  let totalActive = 0;
  let totalCancelled = 0;
  let matchedActive = 0;
  let unmatchedActive = 0;
  let emptyQuotaActive = 0;

  for (const row of rows) {
    const quotaLabel = row.quotaLabel;
    const cnt = Number(row.cnt) || 0;
    const isActive = row.status !== ADMISSION_CANCELLED;
    const category = quotaLabel === '(empty)' ? null : classifyAdmissionQuotaCategory(quotaLabel);

    const qKey = quotaLabel;
    if (!byQuota.has(qKey)) {
      byQuota.set(qKey, { label: quotaLabel, category, active: 0, cancelled: 0 });
    }
    const qAgg = byQuota.get(qKey);
    if (isActive) qAgg.active += cnt;
    else qAgg.cancelled += cnt;

    const cKey = row.courseName;
    if (!byCourse.has(cKey)) {
      byCourse.set(cKey, { active: 0, cancelled: 0, unmatchedActive: 0, emptyQuotaActive: 0 });
    }
    const cAgg = byCourse.get(cKey);
    if (isActive) {
      totalActive += cnt;
      cAgg.active += cnt;
      if (quotaLabel === '(empty)') {
        emptyQuotaActive += cnt;
        cAgg.emptyQuotaActive += cnt;
      } else if (category) {
        matchedActive += cnt;
      } else {
        unmatchedActive += cnt;
        cAgg.unmatchedActive += cnt;
        unmatched.push({
          course: row.courseName,
          branch: row.branchName,
          quota: quotaLabel,
          status: row.status,
          count: cnt,
        });
      }
    } else {
      totalCancelled += cnt;
      cAgg.cancelled += cnt;
    }
  }

  console.log('\n=== Quota label coverage (all admissions) ===\n');
  console.log(
    `Active: ${totalActive} | Matched to abstract bucket: ${matchedActive} | Unmatched label: ${unmatchedActive} | Empty quota: ${emptyQuotaActive}`
  );
  console.log(`Cancelled: ${totalCancelled}\n`);

  console.log('--- Distinct quota labels ---');
  for (const [, agg] of [...byQuota.entries()].sort((a, b) => b[1].active - a[1].active)) {
    const bucket = agg.category ?? (agg.label === '(empty)' ? 'EMPTY' : 'UNMATCHED');
    console.log(
      `${bucket.padEnd(10)} | active ${String(agg.active).padStart(5)} | cancelled ${String(agg.cancelled).padStart(5)} | ${agg.label}`
    );
  }

  console.log('\n--- Per course (active admissions) ---');
  for (const [course, agg] of [...byCourse.entries()].sort((a, b) => b[1].active - a[1].active)) {
    const gap = agg.unmatchedActive + agg.emptyQuotaActive;
    const flag = gap > 0 ? ' ⚠' : '';
    console.log(
      `${course.padEnd(28)} | active ${String(agg.active).padStart(5)} | unmatched ${String(agg.unmatchedActive).padStart(4)} | empty quota ${String(agg.emptyQuotaActive).padStart(4)}${flag}`
    );
  }

  if (unmatched.length > 0) {
    console.log('\n--- Unmatched quota rows (would not appear in abstract CQ/MQ/Spot) ---');
    for (const u of unmatched.sort((a, b) => b.count - a.count)) {
      console.log(
        `${u.count}x | ${u.course} / ${u.branch} | quota="${u.quota}" | ${u.status}`
      );
    }
  } else {
    console.log('\nNo unmatched non-empty quota labels for active admissions.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
