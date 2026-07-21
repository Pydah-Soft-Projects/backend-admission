import dotenv from 'dotenv';
import path from 'path';
import mysql from 'mysql2/promise';

dotenv.config({ path: path.join(process.cwd(), '.env') });

async function clean() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'admission_db',
    port: Number(process.env.DB_PORT || 3306),
  });

  const [rows] = await pool.execute(
    "SELECT id, student_name, lead_data FROM joinings WHERE student_name LIKE '%BANNU ROYALS%' LIMIT 1"
  );
  if (!rows.length) {
    console.log('No joining found for BANNU ROYALS');
    await pool.end();
    return;
  }

  const j = rows[0];
  let ld = JSON.parse(j.lead_data);
  if (ld._joiningRegistrationExtras?.transport_details) {
    console.log('Original transport_details:', ld._joiningRegistrationExtras.transport_details);
    ld._joiningRegistrationExtras.transport_details = {
      accommodationType: ld._joiningRegistrationExtras.transport_details.accommodationType || 'bus',
      academicYear: ld._joiningRegistrationExtras.transport_details.academicYear || '2026-2027',
    };
    console.log('Cleaned transport_details:', ld._joiningRegistrationExtras.transport_details);

    await pool.execute(
      'UPDATE joinings SET lead_data = ? WHERE id = ?',
      [JSON.stringify(ld), j.id]
    );
    console.log('✅ Cleaned joining record for BANNU ROYALS');
  }

  await pool.end();
  process.exit(0);
}

clean();
