import { getPool } from '../config-sql/database.js';

/**
 * User Performance Service
 * ------------------------
 * Handles real-time updates to the user_performance_summaries table.
 * Uses atomic increments and JSON merges to keep the table in sync without full scans.
 */

export const updatePerformanceSummary = async ({
  userId,
  academicYear,
  studentGroup,
  roleName,
  summaryDate = new Date(),
  metrics = {} // { allottedDelta: 1, handledDelta: 1, callsDelta: 1, smsDelta: 1, durationDelta: 60, conversionsDelta: 1 }
}) => {
  try {
    const pool = getPool();
    const dateStr = summaryDate.toISOString().slice(0, 10);
    const year = academicYear || new Date().getFullYear();
    const group = studentGroup || 'Unknown';

    // Build the dynamic increment part
    const increments = [];
    const values = [userId, year, group, dateStr, roleName || 'Counsellor'];
    
    if (metrics.allottedDelta) {
      increments.push(`total_assigned_count = total_assigned_count + ${Number(metrics.allottedDelta)}`);
    }
    if (metrics.handledDelta) {
      increments.push(`total_handled_leads = total_handled_leads + ${Number(metrics.handledDelta)}`);
    }
    if (metrics.callsDelta) {
      increments.push(`calls_count = calls_count + ${Number(metrics.callsDelta)}`);
    }
    if (metrics.smsDelta) {
      increments.push(`sms_count = sms_count + ${Number(metrics.smsDelta)}`);
    }
    if (metrics.durationDelta) {
      increments.push(`total_call_duration_seconds = total_call_duration_seconds + ${Number(metrics.durationDelta)}`);
    }
    if (metrics.conversionsDelta) {
      increments.push(`converted_count = converted_count + ${Number(metrics.conversionsDelta)}`);
    }
    if (metrics.changesDelta) {
      increments.push(`status_changes_count = status_changes_count + ${Number(metrics.changesDelta)}`);
    }

    if (increments.length === 0 && !metrics.statusUpdate) return;

    const updateClause = increments.length > 0 ? increments.join(', ') : 'updated_at = NOW()';

    await pool.execute(`
      INSERT INTO user_performance_summaries (
        user_id, academic_year, student_group, summary_date, role_name,
        total_assigned_count, total_handled_leads, calls_count, sms_count, 
        total_call_duration_seconds, status_changes_count, converted_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE ${updateClause}
    `, [
      ...values,
      metrics.allottedDelta || 0,
      metrics.handledDelta || 0,
      metrics.callsDelta || 0,
      metrics.smsDelta || 0,
      metrics.durationDelta || 0,
      metrics.changesDelta || 0,
      metrics.conversionsDelta || 0
    ]);

  } catch (error) {
    console.error('[UserPerformanceService] Error updating summary:', error);
  }
};

/**
 * Specifically updates the status breakdown JSON.
 */
export const updateStatusBreakdown = async ({
  userId,
  academicYear,
  studentGroup,
  summaryDate = new Date(),
  oldStatus,
  newStatus
}) => {
  try {
    const pool = getPool();
    const dateStr = summaryDate.toISOString().slice(0, 10);
    const year = academicYear || new Date().getFullYear();
    const group = studentGroup || 'Unknown';

    // Ensure the row exists
    await pool.execute(`
      INSERT INTO user_performance_summaries (user_id, academic_year, student_group, summary_date, role_name)
      VALUES (?, ?, ?, ?, 'Counsellor')
      ON DUPLICATE KEY UPDATE updated_at = NOW()
    `, [userId, year, group, dateStr]);

    let jsonUpdate = 'status_breakdown = JSON_SET(COALESCE(status_breakdown, "{}")';
    
    if (oldStatus) {
      jsonUpdate += `, "$.\\"${oldStatus}\\"", GREATEST(0, CAST(COALESCE(JSON_EXTRACT(status_breakdown, "$.\\"${oldStatus}\\""), 0) AS SIGNED) - 1)`;
    }
    if (newStatus) {
      jsonUpdate += `, "$.\\"${newStatus}\\"", CAST(COALESCE(JSON_EXTRACT(status_breakdown, "$.\\"${newStatus}\\""), 0) AS SIGNED) + 1`;
    }
    jsonUpdate += ')';

    await pool.execute(`
      UPDATE user_performance_summaries 
      SET ${jsonUpdate}
      WHERE user_id = ? AND academic_year = ? AND student_group = ? AND summary_date = ?
    `, [userId, year, group, dateStr]);

  } catch (error) {
    console.error('[UserPerformanceService] Error updating status breakdown:', error);
  }
};

/** High-level wrapper for status changes */
export const logStatusChangePerformance = async (userId, lead, newStatus, oldStatus = null) => {
  return updateStatusBreakdown({
    userId,
    academicYear: lead.academic_year,
    studentGroup: lead.student_group,
    oldStatus,
    newStatus
  });
};

/** Specifically for Calls (Expected by communication controller) */
export const logCallPerformance = async (userId, lead, duration = 0) => {
  return updatePerformanceSummary({
    userId,
    academicYear: lead.academic_year,
    studentGroup: lead.student_group,
    metrics: {
      handledDelta: 1, 
      callsDelta: 1,
      durationDelta: duration
    }
  });
};

/** Specifically for SMS/Generic Metrics (Expected by communication controller) */
export const updatePerformanceMetric = async ({ userId, academicYear, studentGroup, roleName, metric, value }) => {
  const metrics = {};
  if (metric === 'sms_count') metrics.smsDelta = value;
  if (metric === 'calls_count') metrics.callsDelta = value;
  
  return updatePerformanceSummary({
    userId,
    academicYear,
    studentGroup,
    roleName,
    metrics
  });
};

/** High-level wrapper for admissions */
export const logAdmissionPerformance = async (userId, lead) => {
  return updatePerformanceSummary({
    userId,
    academicYear: lead.academic_year,
    studentGroup: lead.student_group,
    metrics: { conversionsDelta: 1 }
  });
};
