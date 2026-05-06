import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

const config = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

async function investigate() {
  const userName = 'BANGARU MANASA';
  const group = 'Inter-MPC';
  const date = '2026-05-05';

  console.log(`\nReclamation Summary for User: ${userName}`);
  console.log(`Group: ${group} | Date: ${date}\n`);

  const pool = mysql.createPool(config);

  try {
    const [users] = await pool.execute('SELECT id FROM users WHERE name = ?', [userName]);
    if (users.length === 0) return console.error(`User "${userName}" not found.`);
    const userId = users[0].id;

    // Comprehensive query to find reclaimed leads and their last user-set status
    const query = `
      SELECT 
        l.name as lead_name,
        a.old_status as status_at_reclaim,
        (
          SELECT al2.new_status 
          FROM activity_logs al2 
          WHERE al2.lead_id = a.lead_id 
            AND al2.performed_by = ? 
            AND al2.created_at < a.created_at
            AND al2.type IN ('status_change', 'follow_up')
          ORDER BY al2.created_at DESC 
          LIMIT 1
        ) as last_user_set_status
      FROM activity_logs a
      JOIN leads l ON l.id = a.lead_id
      WHERE a.source_user_id = ? 
        AND a.target_user_id IS NULL
        AND l.student_group = ?
        AND DATE(a.created_at) = ?
      ORDER BY a.created_at DESC
    `;

    const [logs] = await pool.execute(query, [userId, userId, group, date]);

    if (logs.length === 0) {
      console.log(`No automated reclaims found for this specific criteria.`);
    } else {
      const summary = {};
      logs.forEach(l => {
        const s = l.last_user_set_status || 'Assigned (No update)';
        summary[s] = (summary[s] || 0) + 1;
      });

      console.log(`Call Status Breakdown (What users had set before reclaim):`);
      console.log(`--------------------------------------------------------`);
      Object.entries(summary).sort((a,b) => b[1] - a[1]).forEach(([s, count]) => {
        console.log(`${s.padEnd(25)} : ${count}`);
      });
      console.log(`--------------------------------------------------------`);
      console.log(`Total Reclaimed Leads     : ${logs.length}\n`);

      // List the 45 'Interested' leads specifically if they exist
      const interestedLeads = logs.filter(l => l.last_user_set_status === 'Interested');
      if (interestedLeads.length > 0) {
        console.log(`Leads that were 'Interested' but got reclaimed (Audit Required):`);
        console.table(interestedLeads.map(l => ({ Lead: l.lead_name, Status: 'Interested' })));
      }
    }

  } catch (error) {
    console.error('Error during analysis:', error);
  } finally {
    await pool.end();
  }
}

investigate();
