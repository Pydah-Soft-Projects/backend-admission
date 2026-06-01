/**
 * Analyze student vs parent mobile numbers across leads, joinings, and admissions.
 *
 * Usage:
 *   node src/scripts-sql/analyzePreferredMobileNumbers.js
 *   node src/scripts-sql/analyzePreferredMobileNumbers.js --limit=20
 *   node src/scripts-sql/analyzePreferredMobileNumbers.js --sample-phone=8328516429
 */
import { getPool } from '../config-sql/database.js';

const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 15);
const samplePhone = process.argv.find((a) => a.startsWith('--sample-phone='))?.split('=')[1]?.trim() || '';

/** Last 10 digits — matches app normalizeJoiningMobileDigits. */
const N = (col) =>
  `NULLIF(RIGHT(REGEXP_REPLACE(COALESCE(${col}, ''), '[^0-9]', ''), 10), '')`;

const phone10 = {
  leadStudent: N('l.phone'),
  leadFather: N('l.father_phone'),
  leadAlternate: N('l.alternate_mobile'),
  jStudent: N('j.student_phone'),
  jFather: N('j.father_phone'),
  jMother: N('j.mother_phone'),
  jPreferred: N('j.preferred_mobile_number'),
  aStudent: N('a.student_phone'),
  aFather: N('a.father_phone'),
  aMother: N('a.mother_phone'),
  aPreferred: N('a.preferred_mobile_number'),
};

async function section(title) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

async function main() {
  const pool = getPool();

  await section('1) LEADS — student phone vs father phone vs alternate mobile');
  const [leadSummary] = await pool.execute(`
    SELECT
      COUNT(*) AS total_leads,
      SUM(CASE WHEN ${phone10.leadStudent} IS NOT NULL THEN 1 ELSE 0 END) AS has_student_phone,
      SUM(CASE WHEN ${phone10.leadFather} IS NOT NULL THEN 1 ELSE 0 END) AS has_father_phone,
      SUM(CASE WHEN ${phone10.leadAlternate} IS NOT NULL THEN 1 ELSE 0 END) AS has_alternate_mobile,
      SUM(CASE WHEN ${phone10.leadStudent} = ${phone10.leadFather} AND ${phone10.leadStudent} IS NOT NULL THEN 1 ELSE 0 END) AS student_eq_father,
      SUM(CASE WHEN ${phone10.leadStudent} <> ${phone10.leadFather} AND ${phone10.leadStudent} IS NOT NULL AND ${phone10.leadFather} IS NOT NULL THEN 1 ELSE 0 END) AS student_ne_father,
      SUM(CASE WHEN ${phone10.leadStudent} = ${phone10.leadAlternate} AND ${phone10.leadStudent} IS NOT NULL AND ${phone10.leadAlternate} IS NOT NULL THEN 1 ELSE 0 END) AS student_eq_alternate,
      SUM(CASE WHEN ${phone10.leadFather} = ${phone10.leadAlternate} AND ${phone10.leadFather} IS NOT NULL AND ${phone10.leadAlternate} IS NOT NULL THEN 1 ELSE 0 END) AS father_eq_alternate,
      SUM(CASE WHEN ${phone10.leadAlternate} IS NOT NULL AND (${phone10.leadAlternate} <> ${phone10.leadStudent} OR ${phone10.leadStudent} IS NULL) AND (${phone10.leadAlternate} <> ${phone10.leadFather} OR ${phone10.leadFather} IS NULL) THEN 1 ELSE 0 END) AS alternate_unique_third_number
    FROM leads l
  `);
  console.table(leadSummary);

  await section('2) JOININGS — student vs father vs mother vs preferred');
  const [joiningSummary] = await pool.execute(`
    SELECT
      COUNT(*) AS total_joinings,
      SUM(CASE WHEN ${phone10.jStudent} IS NOT NULL THEN 1 ELSE 0 END) AS has_student_phone,
      SUM(CASE WHEN ${phone10.jFather} IS NOT NULL THEN 1 ELSE 0 END) AS has_father_phone,
      SUM(CASE WHEN ${phone10.jMother} IS NOT NULL THEN 1 ELSE 0 END) AS has_mother_phone,
      SUM(CASE WHEN ${phone10.jPreferred} IS NOT NULL THEN 1 ELSE 0 END) AS has_preferred_mobile,
      SUM(CASE WHEN ${phone10.jStudent} = ${phone10.jFather} AND ${phone10.jStudent} IS NOT NULL THEN 1 ELSE 0 END) AS student_eq_father,
      SUM(CASE WHEN ${phone10.jStudent} <> ${phone10.jFather} AND ${phone10.jStudent} IS NOT NULL AND ${phone10.jFather} IS NOT NULL THEN 1 ELSE 0 END) AS student_ne_father,
      SUM(CASE WHEN ${phone10.jStudent} = ${phone10.jMother} AND ${phone10.jStudent} IS NOT NULL AND ${phone10.jMother} IS NOT NULL THEN 1 ELSE 0 END) AS student_eq_mother,
      SUM(CASE WHEN ${phone10.jStudent} <> ${phone10.jMother} AND ${phone10.jStudent} IS NOT NULL AND ${phone10.jMother} IS NOT NULL THEN 1 ELSE 0 END) AS student_ne_mother,
      SUM(CASE WHEN ${phone10.jPreferred} = ${phone10.jStudent} AND ${phone10.jPreferred} IS NOT NULL THEN 1 ELSE 0 END) AS preferred_eq_student,
      SUM(CASE WHEN ${phone10.jPreferred} = ${phone10.jFather} AND ${phone10.jPreferred} IS NOT NULL AND ${phone10.jStudent} <> ${phone10.jFather} THEN 1 ELSE 0 END) AS preferred_eq_father_when_diff,
      SUM(CASE WHEN ${phone10.jPreferred} IS NULL OR ${phone10.jPreferred} = '' THEN 1 ELSE 0 END) AS preferred_empty
    FROM joinings j
  `);
  console.table(joiningSummary);

  await section('3) ADMISSIONS — student vs father vs mother vs preferred');
  const [admissionSummary] = await pool.execute(`
    SELECT
      COUNT(*) AS total_admissions,
      SUM(CASE WHEN ${phone10.aStudent} IS NOT NULL THEN 1 ELSE 0 END) AS has_student_phone,
      SUM(CASE WHEN ${phone10.aFather} IS NOT NULL THEN 1 ELSE 0 END) AS has_father_phone,
      SUM(CASE WHEN ${phone10.aMother} IS NOT NULL THEN 1 ELSE 0 END) AS has_mother_phone,
      SUM(CASE WHEN ${phone10.aPreferred} IS NOT NULL THEN 1 ELSE 0 END) AS has_preferred_mobile,
      SUM(CASE WHEN ${phone10.aStudent} = ${phone10.aFather} AND ${phone10.aStudent} IS NOT NULL THEN 1 ELSE 0 END) AS student_eq_father,
      SUM(CASE WHEN ${phone10.aStudent} <> ${phone10.aFather} AND ${phone10.aStudent} IS NOT NULL AND ${phone10.aFather} IS NOT NULL THEN 1 ELSE 0 END) AS student_ne_father,
      SUM(CASE WHEN ${phone10.aPreferred} = ${phone10.aStudent} AND ${phone10.aPreferred} IS NOT NULL THEN 1 ELSE 0 END) AS preferred_eq_student,
      SUM(CASE WHEN ${phone10.aPreferred} = ${phone10.aFather} AND ${phone10.aPreferred} IS NOT NULL THEN 1 ELSE 0 END) AS preferred_eq_father,
      SUM(CASE WHEN ${phone10.aPreferred} = ${phone10.aMother} AND ${phone10.aPreferred} IS NOT NULL THEN 1 ELSE 0 END) AS preferred_eq_mother,
      SUM(CASE WHEN ${phone10.aPreferred} IS NULL OR ${phone10.aPreferred} = '' THEN 1 ELSE 0 END) AS preferred_empty
    FROM admissions a
  `);
  console.table(admissionSummary);

  await section('4) LEAD → JOINING drift (linked records)');
  const [driftSummary] = await pool.execute(`
    SELECT
      COUNT(*) AS linked_joinings,
      SUM(CASE WHEN ${phone10.leadStudent} = ${phone10.jStudent} OR (${phone10.leadStudent} IS NULL AND ${phone10.jStudent} IS NULL) THEN 1 ELSE 0 END) AS lead_student_matches_joining,
      SUM(CASE WHEN ${phone10.leadFather} = ${phone10.jFather} OR (${phone10.leadFather} IS NULL AND ${phone10.jFather} IS NULL) THEN 1 ELSE 0 END) AS lead_father_matches_joining,
      SUM(CASE WHEN ${phone10.leadStudent} <> ${phone10.jStudent} AND ${phone10.leadStudent} IS NOT NULL AND ${phone10.jStudent} IS NOT NULL THEN 1 ELSE 0 END) AS student_phone_changed,
      SUM(CASE WHEN ${phone10.leadFather} <> ${phone10.jFather} AND ${phone10.leadFather} IS NOT NULL AND ${phone10.jFather} IS NOT NULL THEN 1 ELSE 0 END) AS father_phone_changed,
      SUM(CASE WHEN ${phone10.jStudent} = ${phone10.jFather} AND ${phone10.jStudent} IS NOT NULL AND ${phone10.leadStudent} <> ${phone10.leadFather} THEN 1 ELSE 0 END) AS became_same_on_joining_but_diff_on_lead
    FROM joinings j
    INNER JOIN leads l ON l.id = j.lead_id
  `);
  console.table(driftSummary);

  await section('5) Preferred mobile classification (joinings with preferred set)');
  const [preferredClass] = await pool.execute(`
    SELECT
      CASE
        WHEN ${phone10.jPreferred} IS NULL THEN 'empty'
        WHEN ${phone10.jPreferred} = ${phone10.jStudent} AND ${phone10.jPreferred} = ${phone10.jFather} THEN 'matches_student_and_father_same'
        WHEN ${phone10.jPreferred} = ${phone10.jStudent} AND (${phone10.jFather} IS NULL OR ${phone10.jPreferred} <> ${phone10.jFather}) THEN 'matches_student_only'
        WHEN ${phone10.jPreferred} = ${phone10.jFather} AND ${phone10.jPreferred} <> ${phone10.jStudent} THEN 'matches_father_distinct'
        WHEN ${phone10.jPreferred} = ${phone10.jMother} THEN 'matches_mother'
        ELSE 'matches_other_or_unmapped'
      END AS preferred_category,
      COUNT(*) AS row_count
    FROM joinings j
    GROUP BY preferred_category
    ORDER BY row_count DESC
  `);
  console.table(preferredClass);

  await section(`6) Sample: student = father (like duplicate dropdown case) — top ${limit}`);
  const [sameSamples] = await pool.execute(`
    SELECT
      j.id AS joining_id,
      l.enquiry_number,
      j.student_name,
      ${phone10.jStudent} AS student_phone,
      ${phone10.jFather} AS father_phone,
      ${phone10.jMother} AS mother_phone,
      ${phone10.jPreferred} AS preferred_mobile,
      j.status
    FROM joinings j
    LEFT JOIN leads l ON l.id = j.lead_id
    WHERE ${phone10.jStudent} = ${phone10.jFather}
      AND ${phone10.jStudent} IS NOT NULL
    ORDER BY j.updated_at DESC
    LIMIT ${limit}
  `);
  console.table(sameSamples);

  await section(`7) Sample: student ≠ father (distinct parent number) — top ${limit}`);
  const [diffSamples] = await pool.execute(`
    SELECT
      j.id AS joining_id,
      l.enquiry_number,
      j.student_name,
      ${phone10.jStudent} AS student_phone,
      ${phone10.jFather} AS father_phone,
      ${phone10.jMother} AS mother_phone,
      ${phone10.jPreferred} AS preferred_mobile,
      j.status
    FROM joinings j
    LEFT JOIN leads l ON l.id = j.lead_id
    WHERE ${phone10.jStudent} <> ${phone10.jFather}
      AND ${phone10.jStudent} IS NOT NULL
      AND ${phone10.jFather} IS NOT NULL
    ORDER BY j.updated_at DESC
    LIMIT ${limit}
  `);
  console.table(diffSamples);

  if (samplePhone) {
    const digits = samplePhone.replace(/\D/g, '').slice(-10);
    await section(`8) Lookup for phone ending in ${digits}`);
    const [leadHits] = await pool.execute(
      `
      SELECT 'lead' AS source, l.enquiry_number, l.name, l.phone, l.father_phone, l.alternate_mobile, NULL AS preferred_mobile, l.lead_status
      FROM leads l
      WHERE ${phone10.leadStudent} = ? OR ${phone10.leadFather} = ? OR ${phone10.leadAlternate} = ?
      LIMIT ${limit}
    `,
      [digits, digits, digits]
    );
    const [joiningHits] = await pool.execute(
      `
      SELECT 'joining' AS source, l.enquiry_number, j.student_name AS name, j.student_phone AS phone, j.father_phone, j.mother_phone AS alternate_mobile, j.preferred_mobile_number AS preferred_mobile, j.status AS lead_status
      FROM joinings j
      LEFT JOIN leads l ON l.id = j.lead_id
      WHERE ${phone10.jStudent} = ? OR ${phone10.jFather} = ? OR ${phone10.jMother} = ? OR ${phone10.jPreferred} = ?
      LIMIT ${limit}
    `,
      [digits, digits, digits, digits]
    );
    const [admissionHits] = await pool.execute(
      `
      SELECT 'admission' AS source, a.enquiry_number, a.student_name AS name, a.student_phone AS phone, a.father_phone, a.mother_phone AS alternate_mobile, a.preferred_mobile_number AS preferred_mobile, a.status AS lead_status
      FROM admissions a
      WHERE ${phone10.aStudent} = ? OR ${phone10.aFather} = ? OR ${phone10.aMother} = ? OR ${phone10.aPreferred} = ?
      LIMIT ${limit}
    `,
      [digits, digits, digits, digits]
    );
    console.log('\nLeads:');
    console.table(leadHits);
    console.log('\nJoinings:');
    console.table(joiningHits);
    console.log('\nAdmissions:');
    console.table(admissionHits);
  }

  console.log('\nDone.\n');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
