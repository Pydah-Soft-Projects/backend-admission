import { getPool } from '../src/config-sql/database.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function debug() {
  const pool = getPool();
  const userName = 'KUDIPUDI LAKSHMI DURGA';
  const targetGroup = 'Inter-MPC';
  const targetYear = 2026;

  console.log(`\n🔍 DEEP DIVE: Finding the 1,840 leads for ${userName}`);

  // 1. Find User
  const [users] = await pool.execute('SELECT id FROM users WHERE name = ?', [userName]);
  const userId = users[0].id;

  // 2. Count by every possible assignment type
  console.log('\n--- 🎯 ASSIGNMENT COUNTS (All Years) ---');
  const [counts] = await pool.execute(`
    SELECT 
      (SELECT COUNT(*) FROM leads WHERE assigned_to = ?) as as_counselor_total,
      (SELECT COUNT(*) FROM leads WHERE assigned_to_pro = ?) as as_pro_total,
      (SELECT COUNT(*) FROM leads WHERE assigned_to = ? AND student_group = ?) as as_counselor_mpc,
      (SELECT COUNT(*) FROM leads WHERE assigned_to = ? AND student_group = ? AND academic_year = ?) as as_counselor_mpc_2026
  `, [userId, userId, userId, targetGroup, userId, targetGroup, targetYear]);
  console.table(counts);

  // 3. Status Breakdown for Year 2026 and Inter-MPC (Matches your Dashboard filters)
  console.log(`\n--- 📊 LIVE STATUS BREAKDOWN (Year: ${targetYear}, Group: ${targetGroup}) ---`);
  const [statusRows] = await pool.execute(`
    SELECT call_status, COUNT(*) as count 
    FROM leads 
    WHERE assigned_to = ? AND student_group = ? AND academic_year = ?
    GROUP BY call_status
  `, [userId, targetGroup, targetYear]);
  console.table(statusRows);

  // 4. Check for leads with NULL or Empty status (The "Missing" 1,052)
  const [nullStatus] = await pool.execute(`
    SELECT COUNT(*) as count 
    FROM leads 
    WHERE assigned_to = ? AND student_group = ? AND academic_year = ?
    AND (call_status IS NULL OR TRIM(call_status) = '' OR call_status = 'New' OR call_status = 'Assigned')
  `, [userId, targetGroup, targetYear]);
  console.log(`\n⚪ Leads with "New" or "Empty" status: ${nullStatus[0].count}`);

  process.exit(0);
}

debug();
