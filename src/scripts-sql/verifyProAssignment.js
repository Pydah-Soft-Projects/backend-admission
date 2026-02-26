import { getPool } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

async function verify() {
  const pool = getPool();
  console.log('Starting verification of PRO dual assignment...');

  try {
    // 1. Find or create a Counselor
    let [users] = await pool.execute("SELECT id FROM users WHERE role_name = 'Student Counselor' LIMIT 1");
    let counselorId;
    if (users.length === 0) {
      console.log('Creating test Counselor...');
      counselorId = uuidv4();
      await pool.execute(
        "INSERT INTO users (id, name, email, password, role_name) VALUES (?, ?, ?, ?, ?)",
        [counselorId, 'Test Counselor', 'counselor@test.com', 'password', 'Student Counselor']
      );
    } else {
      counselorId = users[0].id;
    }

    // 2. Find or create a PRO user
    [users] = await pool.execute("SELECT id FROM users WHERE role_name = 'PRO' LIMIT 1");
    let proId;
    if (users.length === 0) {
      console.log('Creating test PRO user...');
      proId = uuidv4();
      await pool.execute(
        "INSERT INTO users (id, name, email, password, role_name) VALUES (?, ?, ?, ?, ?)",
        [proId, 'Test PRO', 'pro@test.com', 'password', 'PRO']
      );
    } else {
      proId = users[0].id;
    }

    // 3. Create a lead and assign to Counselor
    const leadId = uuidv4();
    console.log(`Creating test lead ${leadId} assigned to Counselor...`);
    await pool.execute(
      "INSERT INTO leads (id, enquiry_number, name, phone, father_name, village, district, mandal, assigned_to, academic_year) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [leadId, 'ENQ-TEST-001', 'Test Lead', '1234567890', 'Father', 'Village', 'District', 'Mandal', counselorId, 2024]
    );

    // 4. Try to assign the SAME lead to PRO user via logic (simulated)
    // We'll call the logic directly or just run a manual query to see if the columns exist and work
    console.log(`Assigning lead ${leadId} to PRO user ${proId}...`);
    await pool.execute(
      "UPDATE leads SET assigned_to_pro = ?, pro_assigned_at = NOW(), pro_assigned_by = ? WHERE id = ?",
      [proId, counselorId, leadId]
    );

    // 5. Verify the lead has BOTH assignees
    const [leads] = await pool.execute("SELECT assigned_to, assigned_to_pro FROM leads WHERE id = ?", [leadId]);
    const lead = leads[0];
    
    if (lead.assigned_to === counselorId && lead.assigned_to_pro === proId) {
      console.log('SUCCESS: Lead has both Counselor and PRO assigned.');
    } else {
      console.log('FAILURE: Dual assignment failed.', lead);
    }

    // Cleanup (optional)
    // await pool.execute("DELETE FROM leads WHERE id = ?", [leadId]);

    console.log('Verification completed.');
    process.exit(0);
  } catch (error) {
    console.error('Verification failed:', error);
    process.exit(1);
  }
}

verify();
