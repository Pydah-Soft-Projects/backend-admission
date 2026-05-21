/**
 * Full dump for one admission: admissions + joinings + leads + lead_data managed ids.
 * Usage: node src/scripts/inspectAdmissionFull.js 20260048
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const num = process.argv[2];
if (!num) {
  console.error('Usage: node src/scripts/inspectAdmissionFull.js <admissionNumber>');
  process.exit(1);
}

function parseJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch {
    return null;
  }
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const [adm] = await conn.execute(
    'SELECT * FROM admissions WHERE admission_number = ? LIMIT 1',
    [num]
  );
  if (!adm.length) {
    console.log('No admission found');
    await conn.end();
    return;
  }
  const a = adm[0];
  const admLd = parseJson(a.lead_data);
  console.log('\n=== ADMISSIONS ===');
  console.log({
    id: a.id,
    admission_number: a.admission_number,
    status: a.status,
    course: a.course,
    branch: a.branch,
    course_id: a.course_id,
    branch_id: a.branch_id,
    managed_course_id: a.managed_course_id,
    managed_branch_id: a.managed_branch_id,
    updated_at: a.updated_at,
    lead_data_managed_course: admLd?._joiningManagedCourseId,
    lead_data_managed_branch: admLd?._joiningManagedBranchId,
  });

  const [j] = await conn.execute('SELECT * FROM joinings WHERE id = ?', [a.joining_id]);
  if (j[0]) {
    const jld = parseJson(j[0].lead_data);
    console.log('\n=== JOININGS ===');
    console.log({
      id: j[0].id,
      status: j[0].status,
      course: j[0].course,
      branch: j[0].branch,
      managed_course_id: j[0].managed_course_id,
      managed_branch_id: j[0].managed_branch_id,
      updated_at: j[0].updated_at,
      lead_data_managed_course: jld?._joiningManagedCourseId,
      lead_data_managed_branch: jld?._joiningManagedBranchId,
    });
  }

  const [l] = await conn.execute('SELECT * FROM leads WHERE id = ?', [a.lead_id]);
  if (l[0]) {
    const df = parseJson(l[0].dynamic_fields);
    console.log('\n=== LEADS ===');
    console.log({
      id: l[0].id,
      enquiry_number: l[0].enquiry_number,
      course_interested: l[0].course_interested,
      updated_at: l[0].updated_at,
    });
  }

  let sec;
  try {
    sec = await mysql.createConnection({
      host: process.env.DB_SECONDARY_HOST,
      port: process.env.DB_SECONDARY_PORT || 3306,
      user: process.env.DB_SECONDARY_USER,
      password: process.env.DB_SECONDARY_PASSWORD,
      database: process.env.DB_SECONDARY_NAME,
    });
    for (const bid of [a.managed_branch_id, '50', '53']) {
      const [br] = await sec.execute(
        'SELECT id, course_id, name, code FROM course_branches WHERE id = ?',
        [bid]
      );
      console.log(`\n=== SECONDARY branch id ${bid} ===`, br[0] || 'NOT FOUND');
    }
  } catch (e) {
    console.log('Secondary DB:', e.message);
  } finally {
    if (sec) await sec.end();
  }

  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
