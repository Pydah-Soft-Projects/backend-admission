import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

/**
 * Historical Hydrator for User Performance Summary
 * -----------------------------------------------
 * This script scans millions of rows in activity_logs and communications
 * to populate the user_performance_summaries table with historical data.
 */

async function hydrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : null,
  });

  try {
    console.log('--- Starting Optimized Bulk Hydration ---');
    const targetUser = process.argv[2];

    // 1. Get users to process
    let userQuery = 'SELECT id, role_name, name FROM users';
    let userParams = [];
    if (targetUser && targetUser !== 'all') {
      userQuery += ' WHERE name = ? OR id = ?';
      userParams.push(targetUser, targetUser);
      console.log(`Filtering for user: ${targetUser}`);
    } else {
      console.log('Processing ALL users.');
    }

    const [users] = await connection.execute(userQuery, userParams);
    console.log(`Found ${users.length} user(s) to process.`);
    const userMap = new Map(users.map(u => [u.id, u]));
    const userIds = users.map(u => u.id);

    if (userIds.length === 0) {
      console.log('No users to process.');
      await connection.end();
      return;
    }

    const placeholders = userIds.map(() => '?').join(',');

    // 2. Fetch ALL relevant data in bulk
    console.log('Fetching Communication logs...');
    const [comms] = await connection.execute(`
      SELECT 
        c.sent_by as user_id,
        DATE(c.sent_at) as summary_date,
        l.academic_year,
        l.student_group,
        COUNT(CASE WHEN c.type = 'call' THEN 1 END) as calls_count,
        COUNT(CASE WHEN c.type = 'sms' THEN 1 END) as sms_count,
        SUM(CASE WHEN c.type = 'call' THEN c.duration_seconds ELSE 0 END) as total_duration
      FROM communications c
      JOIN leads l ON c.lead_id = l.id
      WHERE c.sent_by IN (${placeholders})
      GROUP BY user_id, summary_date, l.academic_year, l.student_group
    `, userIds);

    console.log('Fetching Assignment logs...');
    const [assignmentLogs] = await connection.execute(`
      SELECT 
        DATE(a.created_at) as summary_date,
        l.academic_year,
        l.student_group,
        l.lead_status,
        a.metadata
      FROM activity_logs a
      JOIN leads l ON a.lead_id = l.id
      WHERE a.type = 'status_change' 
        AND a.comment LIKE 'Assigned to %'
    `, []);

    console.log('Fetching Handled Leads data...');
    const [handledLeadsData] = await connection.execute(`
      SELECT 
        user_id, summary_date, academic_year, student_group, COUNT(*) as cnt
      FROM (
        SELECT t.user_id, DATE(t.created_at) as summary_date, l.academic_year, l.student_group, t.lead_id
        FROM (
          SELECT performed_by as user_id, created_at, lead_id FROM activity_logs WHERE performed_by IN (${placeholders})
          UNION
          SELECT sent_by as user_id, sent_at as created_at, lead_id FROM communications WHERE sent_by IN (${placeholders})
        ) as t
        JOIN leads l ON t.lead_id = l.id
      ) as final
      GROUP BY user_id, summary_date, academic_year, student_group
    `, [...userIds, ...userIds]);

    console.log('Fetching Conversions...');
    const [conversions] = await connection.execute(`
      SELECT 
        DATE(adm.created_at) as summary_date,
        l.academic_year,
        l.student_group,
        l.assigned_to as user_id,
        COUNT(*) as conv_count
      FROM admissions adm
      JOIN leads l ON adm.lead_id = l.id
      WHERE l.assigned_to IN (${placeholders})
      GROUP BY summary_date, l.academic_year, l.student_group, user_id
    `, userIds);

    // 3. Aggregate into a unified structure
    const mergedData = new Map();
    const getSet = (userId, date, year, group) => {
      const key = `${userId}_${date}_${year}_${group}`;
      if (!mergedData.has(key)) {
        mergedData.set(key, { 
          userId, date, year, group, 
          calls: 0, sms: 0, duration: 0, 
          allotted: 0, handled: 0, conversions: 0,
          breakdown: {}
        });
      }
      return mergedData.get(key);
    };

    comms.forEach(c => {
      const d = getSet(c.user_id, c.summary_date, c.academic_year, c.student_group);
      d.calls = c.calls_count;
      d.sms = c.sms_count;
      d.duration = c.total_duration;
    });

    assignmentLogs.forEach(a => {
      try {
        const meta = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : a.metadata;
        const aid = meta?.assignment?.assignedTo;
        if (aid && userMap.has(aid)) {
          const d = getSet(aid, a.summary_date, a.academic_year, a.student_group);
          d.allotted += 1;
          d.breakdown[a.lead_status || 'Assigned'] = (d.breakdown[a.lead_status || 'Assigned'] || 0) + 1;
        }
      } catch (e) { /* skip */ }
    });

    handledLeadsData.forEach(h => {
      const d = getSet(h.user_id, h.summary_date, h.academic_year, h.student_group);
      d.handled = h.cnt;
    });

    conversions.forEach(c => {
      const d = getSet(c.user_id, c.summary_date, c.academic_year, c.student_group);
      d.conversions = c.conv_count;
    });

    // 4. Batch UPSERT into DB
    console.log(`Processing ${mergedData.size} summary records...`);
    let count = 0;
    for (const [key, val] of mergedData) {
      const user = userMap.get(val.userId);
      if (!user || !val.date || !val.year) continue;

      await connection.execute(`
        INSERT INTO user_performance_summaries (
          user_id, academic_year, student_group, summary_date, role_name,
          total_assigned_count, total_handled_leads, calls_count, sms_count, 
          total_call_duration_seconds, status_changes_count, converted_count,
          status_breakdown
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          total_assigned_count = VALUES(total_assigned_count),
          total_handled_leads = VALUES(total_handled_leads),
          calls_count = VALUES(calls_count),
          sms_count = VALUES(sms_count),
          total_call_duration_seconds = VALUES(total_call_duration_seconds),
          status_changes_count = VALUES(status_changes_count),
          converted_count = VALUES(converted_count),
          status_breakdown = VALUES(status_breakdown)
      `, [
        val.userId, val.year, val.group || 'Unknown', val.date, user.role_name || 'Counsellor',
        val.allotted || 0, val.handled || 0, val.calls, val.sms, val.duration, 0, val.conversions,
        JSON.stringify(val.breakdown)
      ]);
      count++;
      if (count % 100 === 0) console.log(`  Inserted ${count} records...`);
    }

    console.log('--- Hydration Completed Successfully ---');
  } catch (error) {
    console.error('Hydration failed:', error);
  } finally {
    await connection.end();
  }
}

hydrate();
