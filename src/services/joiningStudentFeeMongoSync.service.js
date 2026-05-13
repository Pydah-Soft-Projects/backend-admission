import { connectFeeManagement } from '../config-mongo/feeManagement.js';

/**
 * Collection in the Fee Management MongoDB that mirrors per-joining student fee line
 * overrides (batch + structure lines). Admissions remains the workflow source of truth in SQL
 * (`joinings.lead_data._joiningStudentFeeDetails`); this collection lets finance / fee tools
 * query the same snapshot without joining to MySQL.
 */
export const JOINING_STUDENT_FEE_MONGO_COLLECTION = 'crm_joining_student_fee_details';

/**
 * @param {object} params
 * @param {string} params.joiningId - UUID joining id (primary key for upsert)
 * @param {string | null} [params.leadId]
 * @param {object | null} [params.studentFeeDetails] - Same shape as sanitized `_joiningStudentFeeDetails` ({ batch?, lines })
 */
export async function syncJoiningStudentFeeDetailsToFeeMongo({
  joiningId,
  leadId = null,
  studentFeeDetails = null,
}) {
  if (!joiningId || typeof joiningId !== 'string') return;

  const uri = process.env.FEE_MANAGEMENT_MONGO_URI?.trim();
  if (!uri) {
    console.warn(
      '[joiningStudentFeeMongoSync] FEE_MANAGEMENT_MONGO_URI not set; skipping Fee DB mirror'
    );
    return;
  }

  const lines = Array.isArray(studentFeeDetails?.lines) ? studentFeeDetails.lines : [];
  const batch =
    studentFeeDetails?.batch != null && String(studentFeeDetails.batch).trim() !== ''
      ? String(studentFeeDetails.batch).trim().slice(0, 32)
      : null;
  const hasPayload = lines.length > 0 || Boolean(batch);

  try {
    const conn = await connectFeeManagement();
    const coll = conn.db.collection(JOINING_STUDENT_FEE_MONGO_COLLECTION);

    if (!hasPayload) {
      await coll.deleteOne({ joiningId });
      return;
    }

    await coll.replaceOne(
      { joiningId },
      {
        joiningId,
        leadId: leadId && String(leadId).trim() !== '' ? String(leadId).trim() : null,
        batch,
        lines,
        updatedAt: new Date(),
        source: 'admissions_crm',
      },
      { upsert: true }
    );
  } catch (err) {
    console.error(
      '[joiningStudentFeeMongoSync] Fee Mongo mirror failed (SQL save still succeeded):',
      err?.message || err
    );
  }
}
