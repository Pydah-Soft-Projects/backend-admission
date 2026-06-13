import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import { connectTransport } from '../config-mongo/transport.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import {
  JOINING_STUDENT_FEE_MONGO_COLLECTION,
  FEE_PORTAL_STUDENT_FEES_COLLECTION,
} from './joiningStudentFeeMongoSync.service.js';

const FEE_PORTAL_LEDGER_COLLECTIONS = [
  FEE_PORTAL_STUDENT_FEES_COLLECTION,
  'transactions',
];

/** Build Mongo filters that match admission number stored as string or number. */
export function buildAdmissionMongoFilters(admissionNumber, joiningIds = []) {
  const admission = String(admissionNumber || '').trim();
  const filters = [{ studentId: admission }, { admissionNumber: admission }];
  const numeric = Number(admission);
  if (Number.isFinite(numeric)) {
    filters.push({ studentId: numeric });
  }
  const uniqueJoiningIds = [...new Set(joiningIds.filter(Boolean))];
  if (uniqueJoiningIds.length === 1) {
    filters.push({ joiningId: uniqueJoiningIds[0] });
  } else if (uniqueJoiningIds.length > 1) {
    filters.push({ joiningId: { $in: uniqueJoiningIds } });
  }
  return filters;
}

export async function resolveAdmissionRemovalTargets(pool, admissionNumbers) {
  if (admissionNumbers.length === 0) {
    return { admissionNumbers: [], targets: [] };
  }

  const placeholders = admissionNumbers.map(() => '?').join(',');
  const [admissionRows] = await pool.execute(
    `SELECT id, admission_number, joining_id, lead_id, student_name, enquiry_number
     FROM admissions
     WHERE admission_number IN (${placeholders})
     ORDER BY admission_number`,
    admissionNumbers
  );

  const [leadRows] = await pool.execute(
    `SELECT id, enquiry_number, admission_number, name
     FROM leads
     WHERE admission_number IN (${placeholders})`,
    admissionNumbers
  );

  const leadIds = leadRows.map((row) => row.id);
  let joiningRows = [];
  if (leadIds.length > 0) {
    const leadPlaceholders = leadIds.map(() => '?').join(',');
    const [byLead] = await pool.execute(
      `SELECT id, lead_id, status, student_name
       FROM joinings
       WHERE lead_id IN (${leadPlaceholders})`,
      leadIds
    );
    joiningRows = byLead;
  }

  const [joiningByLeadData] = await pool.execute(
    `SELECT id, lead_id, status, student_name
     FROM joinings
     WHERE JSON_UNQUOTE(JSON_EXTRACT(lead_data, '$.admissionNumber')) IN (${placeholders})`,
    admissionNumbers
  );

  const joiningMap = new Map();
  for (const row of [...joiningRows, ...joiningByLeadData, ...admissionRows.map((r) => ({ id: r.joining_id, lead_id: r.lead_id }))]) {
    if (row?.id) joiningMap.set(row.id, row);
  }

  const admissionByNumber = new Map(
    admissionRows.map((row) => [String(row.admission_number), row])
  );
  const leadByNumber = new Map(leadRows.map((row) => [String(row.admission_number), row]));

  const targets = admissionNumbers.map((admissionNumber) => {
    const admission = admissionByNumber.get(admissionNumber) || null;
    const lead = leadByNumber.get(admissionNumber) || null;
    const joiningIds = [
      admission?.joining_id,
      ...[...joiningMap.values()]
        .filter((row) => row.lead_id === lead?.id)
        .map((row) => row.id),
    ].filter(Boolean);
    return {
      admissionNumber,
      admission,
      lead,
      joiningIds: [...new Set(joiningIds)],
    };
  });

  return { admissionNumbers, targets };
}

async function countFeePortalMatches(db, admissionNumber, joiningIds) {
  const filters = buildAdmissionMongoFilters(admissionNumber, joiningIds);
  const query = filters.length === 1 ? filters[0] : { $or: filters };

  const crmCount = await db
    .collection(JOINING_STUDENT_FEE_MONGO_COLLECTION)
    .countDocuments(query);

  const ledgerCounts = {};
  for (const name of FEE_PORTAL_LEDGER_COLLECTIONS) {
    ledgerCounts[name] = await db.collection(name).countDocuments(query);
  }

  return { crmCount, ledgerCounts };
}

export async function previewAdmissionExternalCleanup(targets) {
  const report = {
    transportRequests: [],
    secondaryStudents: [],
    feePortal: [],
    transportMongo: [],
  };

  if (targets.length === 0) return report;

  const admissionNumbers = targets.map((target) => target.admissionNumber);
  try {
    const secondary = getSecondaryPool();
    const placeholders = admissionNumbers.map(() => '?').join(',');
    const [transportRows] = await secondary.execute(
      `SELECT id, admission_number, status, application_number, academic_year
       FROM transport_requests
       WHERE admission_number IN (${placeholders})`,
      admissionNumbers
    );
    report.transportRequests = transportRows;

    const [studentRows] = await secondary.execute(
      `SELECT id, admission_number, admission_no, student_name
       FROM students
       WHERE admission_number IN (${placeholders}) OR admission_no IN (${placeholders})`,
      [...admissionNumbers, ...admissionNumbers]
    );
    report.secondaryStudents = studentRows;
  } catch (err) {
    report.secondaryError = err?.message || String(err);
  }

  const feeUri = process.env.FEE_MANAGEMENT_MONGO_URI?.trim();
  if (feeUri) {
    try {
      const conn = await connectFeeManagement();
      for (const target of targets) {
        const counts = await countFeePortalMatches(
          conn.db,
          target.admissionNumber,
          target.joiningIds
        );
        report.feePortal.push({
          admissionNumber: target.admissionNumber,
          joiningIds: target.joiningIds,
          ...counts,
        });
      }
    } catch (err) {
      report.feePortalError = err?.message || String(err);
    }
  } else {
    report.feePortalSkipped = 'FEE_MANAGEMENT_MONGO_URI not set';
  }

  const transportUri = process.env.TRANSPORT_MONGO_URI?.trim();
  if (transportUri) {
    try {
      const conn = await connectTransport();
      const coll = conn.db.collection('studentfees');
      for (const target of targets) {
        const filters = buildAdmissionMongoFilters(target.admissionNumber, target.joiningIds);
        const query = filters.length === 1 ? filters[0] : { $or: filters };
        const count = await coll.countDocuments(query);
        if (count > 0) {
          report.transportMongo.push({
            admissionNumber: target.admissionNumber,
            count,
          });
        }
      }
    } catch (err) {
      report.transportMongoError = err?.message || String(err);
    }
  } else {
    report.transportMongoSkipped = 'TRANSPORT_MONGO_URI not set';
  }

  return report;
}

export async function purgeAdmissionFromFeePortal(admissionNumber, joiningIds = []) {
  const uri = process.env.FEE_MANAGEMENT_MONGO_URI?.trim();
  if (!uri) return { skipped: true, reason: 'FEE_MANAGEMENT_MONGO_URI not set' };

  const conn = await connectFeeManagement();
  const filters = buildAdmissionMongoFilters(admissionNumber, joiningIds);
  const query = filters.length === 1 ? filters[0] : { $or: filters };

  const crmResult = await conn.db
    .collection(JOINING_STUDENT_FEE_MONGO_COLLECTION)
    .deleteMany(query);

  const ledgerDeleted = {};
  for (const name of FEE_PORTAL_LEDGER_COLLECTIONS) {
    const result = await conn.db.collection(name).deleteMany(query);
    ledgerDeleted[name] = Number(result.deletedCount || 0);
  }

  return {
    crmDeleted: Number(crmResult.deletedCount || 0),
    ledgerDeleted,
  };
}

export async function purgeAdmissionFromTransportMongo(admissionNumber, joiningIds = []) {
  const uri = process.env.TRANSPORT_MONGO_URI?.trim();
  if (!uri) return { skipped: true, reason: 'TRANSPORT_MONGO_URI not set' };

  const conn = await connectTransport();
  const filters = buildAdmissionMongoFilters(admissionNumber, joiningIds);
  const query = filters.length === 1 ? filters[0] : { $or: filters };
  const result = await conn.db.collection('studentfees').deleteMany(query);
  return { deleted: Number(result.deletedCount || 0) };
}

export async function purgeAdmissionFromSecondarySql(admissionNumbers) {
  if (admissionNumbers.length === 0) {
    return { transportRequestsDeleted: 0, secondaryStudentsDeleted: 0 };
  }

  const secondary = getSecondaryPool();
  const placeholders = admissionNumbers.map(() => '?').join(',');

  const [transportResult] = await secondary.execute(
    `DELETE FROM transport_requests WHERE admission_number IN (${placeholders})`,
    admissionNumbers
  );
  const [studentsResult] = await secondary.execute(
    `DELETE FROM students
     WHERE admission_number IN (${placeholders}) OR admission_no IN (${placeholders})`,
    [...admissionNumbers, ...admissionNumbers]
  );

  return {
    transportRequestsDeleted: Number(transportResult.affectedRows || 0),
    secondaryStudentsDeleted: Number(studentsResult.affectedRows || 0),
  };
}

export async function clearAdmissionReferencesInPrimarySql(conn, targets) {
  let leadsCleared = 0;
  let joiningsCleared = 0;

  for (const target of targets) {
    const admissionNumber = target.admissionNumber;
    const [leadResult] = await conn.execute(
      `UPDATE leads SET admission_number = NULL, updated_at = NOW()
       WHERE admission_number = ?`,
      [admissionNumber]
    );
    leadsCleared += Number(leadResult.affectedRows || 0);

    const joiningIds = target.joiningIds;
    if (joiningIds.length > 0) {
      const placeholders = joiningIds.map(() => '?').join(',');
      const [joiningResult] = await conn.execute(
        `UPDATE joinings
         SET lead_data = JSON_SET(
           COALESCE(
             CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END,
             JSON_OBJECT()
           ),
           '$.admissionNumber',
           CAST(NULL AS JSON)
         ),
         updated_at = NOW()
         WHERE id IN (${placeholders})`,
        joiningIds
      );
      joiningsCleared += Number(joiningResult.affectedRows || 0);
    }

    const [joiningByNumberResult] = await conn.execute(
      `UPDATE joinings
       SET lead_data = JSON_SET(
         COALESCE(
           CASE WHEN JSON_VALID(lead_data) THEN lead_data ELSE JSON_OBJECT() END,
           JSON_OBJECT()
         ),
         '$.admissionNumber',
         CAST(NULL AS JSON)
       ),
       updated_at = NOW()
       WHERE JSON_UNQUOTE(JSON_EXTRACT(lead_data, '$.admissionNumber')) = ?`,
      [admissionNumber]
    );
    joiningsCleared += Number(joiningByNumberResult.affectedRows || 0);
  }

  return { leadsCleared, joiningsCleared };
}

export async function executeAdmissionExternalCleanup(targets) {
  const admissionNumbers = targets.map((target) => target.admissionNumber);
  const secondary = await purgeAdmissionFromSecondarySql(admissionNumbers);

  const feePortal = {};
  const transportMongo = {};
  for (const target of targets) {
    feePortal[target.admissionNumber] = await purgeAdmissionFromFeePortal(
      target.admissionNumber,
      target.joiningIds
    );
    transportMongo[target.admissionNumber] = await purgeAdmissionFromTransportMongo(
      target.admissionNumber,
      target.joiningIds
    );
  }

  return { secondary, feePortal, transportMongo };
}
