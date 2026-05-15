/**
 * Compare official master list vs primary admissions + secondary students.
 *
 *   npm run db:compare-admissions-master-2026
 */
import dotenv from 'dotenv';
import { ADMISSIONS_MASTER_LIST_2026 } from '../data/admissionsMasterList2026.js';
import { getPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';

dotenv.config();

const normalizeName = (v) =>
  String(v ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');

const normalizePhone = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
};

function mapAdmissionStatus(sheetStatus) {
  const s = String(sheetStatus ?? '').trim().toLowerCase();
  if (s.includes('cancel')) return 'Admission Cancelled';
  return 'active';
}

async function main() {
  const primary = getPool();
  const secondary = getSecondaryPool();

  const summary = {
    masterRows: ADMISSIONS_MASTER_LIST_2026.length,
    primaryNotFound: 0,
    primaryWrongAdmission: 0,
    primaryWrongHallTicket: 0,
    primaryWrongSource: 0,
    primaryWrongStatus: 0,
    secondaryNotFound: 0,
    secondaryWrongAdmission: 0,
    secondaryWrongStudType: 0,
    ok: 0,
  };

  const issues = [];

  for (const row of ADMISSIONS_MASTER_LIST_2026) {
    const phone = normalizePhone(row.phone);
    const name = normalizeName(row.studentName);
    const targetAdm = String(row.admissionNumber).trim();
    const targetSource = String(row.source).trim();
    const targetStatus = mapAdmissionStatus(row.status);
    const targetStudType =
      targetSource.toLowerCase().includes('manag')
        ? 'MANG'
        : targetSource.toLowerCase().includes('conv')
          ? 'CONV'
          : targetSource.toLowerCase().includes('spot')
            ? 'SPOT'
            : '';

    const [admRows] = await primary.execute(
      `SELECT a.id, a.admission_number, a.status, a.quota, a.student_name, a.student_phone,
              l.id AS lead_id, l.admission_number AS lead_adm, l.hall_ticket_number, l.source
       FROM admissions a
       LEFT JOIN leads l ON l.id = a.lead_id
       WHERE RIGHT(REGEXP_REPLACE(COALESCE(a.student_phone, ''), '[^0-9]', ''), 10) = ?
         AND UPPER(TRIM(a.student_name)) = ?
       LIMIT 3`,
      [phone, name]
    );

    const [secRows] = await secondary.execute(
      `SELECT id, admission_number, stud_type, student_name, student_mobile
       FROM students
       WHERE RIGHT(REGEXP_REPLACE(COALESCE(student_mobile, ''), '[^0-9]', ''), 10) = ?
         AND UPPER(TRIM(student_name)) = ?
       LIMIT 3`,
      [phone, name]
    );

    const rowIssues = [];

    if (admRows.length === 0) {
      summary.primaryNotFound += 1;
      rowIssues.push('primary_not_found');
    } else {
      const p = admRows[0];
      if (String(p.admission_number || '').trim() !== targetAdm) {
        summary.primaryWrongAdmission += 1;
        rowIssues.push({
          field: 'admission_number',
          db: p.admission_number,
          expected: targetAdm,
        });
      }
      if (String(p.lead_adm || '').trim() !== targetAdm) {
        summary.primaryWrongAdmission += 1;
        rowIssues.push({
          field: 'lead.admission_number',
          db: p.lead_adm,
          expected: targetAdm,
        });
      }
      if (String(p.hall_ticket_number || '').trim() !== targetAdm) {
        summary.primaryWrongHallTicket += 1;
        rowIssues.push({
          field: 'hall_ticket_number',
          db: p.hall_ticket_number,
          expected: targetAdm,
        });
      }
      const dbSource = String(p.source || p.quota || '').trim();
      if (dbSource && dbSource.toLowerCase() !== targetSource.toLowerCase()) {
        summary.primaryWrongSource += 1;
        rowIssues.push({ field: 'source/quota', db: dbSource, expected: targetSource });
      }
      if (String(p.status || '').trim() !== targetStatus) {
        summary.primaryWrongStatus += 1;
        rowIssues.push({ field: 'status', db: p.status, expected: targetStatus });
      }
    }

    if (secRows.length === 0) {
      summary.secondaryNotFound += 1;
      rowIssues.push('secondary_not_found');
    } else {
      const s = secRows[0];
      if (String(s.admission_number || '').trim() !== targetAdm) {
        summary.secondaryWrongAdmission += 1;
        rowIssues.push({
          field: 'secondary.admission_number',
          db: s.admission_number,
          expected: targetAdm,
        });
      }
      if (targetStudType && String(s.stud_type || '').trim().toUpperCase() !== targetStudType) {
        summary.secondaryWrongStudType += 1;
        rowIssues.push({ field: 'stud_type', db: s.stud_type, expected: targetStudType });
      }
    }

    if (rowIssues.length === 0) summary.ok += 1;
    else {
      issues.push({
        admissionNumber: targetAdm,
        applicationNumber: row.applicationNumber,
        studentName: row.studentName,
        phone: row.phone,
        issues: rowIssues,
      });
    }
  }

  console.log(JSON.stringify({ summary, issues: issues.slice(0, 40), issuesTruncated: issues.length > 40 }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
