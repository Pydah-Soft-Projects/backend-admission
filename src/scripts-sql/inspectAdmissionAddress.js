/**
 * One-off diagnostic: inspect address-related data for an admission number.
 * Usage: node src/scripts-sql/inspectAdmissionAddress.js 20260230
 */
import { getPool } from '../config-sql/database.js';
import { communicationAddressFromSqlRow } from '../utils/joiningAddress.util.js';

const admissionNumber = process.argv[2] || '20260230';

function parseJson(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

function summarize(obj) {
  return JSON.stringify(obj, null, 2);
}

async function main() {
  const pool = getPool();
  const [admRows] = await pool.execute(
    `SELECT a.*, l.name AS lead_name, l.phone AS lead_phone, l.village AS lead_village,
            l.mandal AS lead_mandal, l.district AS lead_district, l.state AS lead_state,
            l.address AS lead_address, l.dynamic_fields AS lead_dynamic_fields,
            l.enquiry_number AS lead_enquiry_number
     FROM admissions a
     LEFT JOIN leads l ON l.id = a.lead_id
     WHERE a.admission_number = ?
     LIMIT 1`,
    [admissionNumber]
  );

  if (!admRows.length) {
    console.error(`No admission found for number: ${admissionNumber}`);
    process.exit(1);
  }

  const adm = admRows[0];
  const leadDataRaw = parseJson(adm.lead_data) || {};
  const regExtras =
    leadDataRaw._joiningRegistrationExtras &&
    typeof leadDataRaw._joiningRegistrationExtras === 'object'
      ? leadDataRaw._joiningRegistrationExtras
      : {};

  const [relatives] = await pool.execute(
    'SELECT * FROM admission_relatives WHERE admission_id = ?',
    [adm.id]
  );

  let joining = null;
  let joiningRelatives = [];
  if (adm.joining_id) {
    const [jRows] = await pool.execute('SELECT * FROM joinings WHERE id = ?', [adm.joining_id]);
    joining = jRows[0] || null;
    if (joining) {
      const [jr] = await pool.execute('SELECT * FROM joining_relatives WHERE joining_id = ?', [
        adm.joining_id,
      ]);
      joiningRelatives = jr;
    }
  }

  const commFromApi = communicationAddressFromSqlRow(adm, regExtras);
  const commFromJoining = joining
    ? communicationAddressFromSqlRow(joining, parseJson(joining.lead_data)?._joiningRegistrationExtras || {})
    : null;

  const addressKeys = [
    'address_door_street',
    'address_landmark',
    'address_village_city',
    'address_mandal',
    'address_district',
    'address_pin_code',
    'address_state',
  ];

  const regAddressKeys = Object.keys(regExtras).filter((k) =>
    /address|door|street|landmark|village|city|mandal|district|state|pin/i.test(k)
  );

  console.log('=== ADMISSION', admissionNumber, '===');
  console.log('id:', adm.id);
  console.log('joining_id:', adm.joining_id);
  console.log('lead_id:', adm.lead_id);
  console.log('student_name:', adm.student_name);
  console.log('enquiry_number:', adm.enquiry_number || adm.lead_enquiry_number);

  console.log('\n--- Admission SQL address columns ---');
  for (const k of addressKeys) {
    console.log(`${k}:`, JSON.stringify(adm[k] ?? ''));
  }

  console.log('\n--- Lead table address fields ---');
  console.log('lead_address:', JSON.stringify(adm.lead_address ?? ''));
  console.log('lead_village:', JSON.stringify(adm.lead_village ?? ''));
  console.log('lead_mandal:', JSON.stringify(adm.lead_mandal ?? ''));
  console.log('lead_district:', JSON.stringify(adm.lead_district ?? ''));
  console.log('lead_state:', JSON.stringify(adm.lead_state ?? ''));

  console.log('\n--- registrationFormData (_joiningRegistrationExtras) address keys ---');
  console.log(summarize(Object.fromEntries(regAddressKeys.map((k) => [k, regExtras[k]]))));

  console.log('\n--- API communication address (admission row + reg extras) ---');
  console.log(summarize(commFromApi));

  if (joining) {
    console.log('\n--- Joining SQL address columns ---');
    for (const k of addressKeys) {
      console.log(`${k}:`, JSON.stringify(joining[k] ?? ''));
    }
    console.log('\n--- API communication address (joining row) ---');
    console.log(summarize(commFromJoining));
    console.log('\n--- joining_relatives count ---', joiningRelatives.length);
    if (joiningRelatives.length) console.log(summarize(joiningRelatives));
  }

  console.log('\n--- admission_relatives count ---', relatives.length);
  if (relatives.length) console.log(summarize(relatives));

  const leadDyn = parseJson(adm.lead_dynamic_fields);
  if (leadDyn && typeof leadDyn === 'object') {
    const dynAddr = Object.fromEntries(
      Object.entries(leadDyn).filter(([k]) =>
        /address|door|street|landmark|village|city|mandal|district|state|pin/i.test(k)
      )
    );
    if (Object.keys(dynAddr).length) {
      console.log('\n--- lead dynamic_fields address-like keys ---');
      console.log(summarize(dynAddr));
    }
  }

  if (process.argv.includes('--stats')) {
    const [stats] = await pool.execute(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN TRIM(COALESCE(address_door_street,'')) = '' THEN 1 ELSE 0 END) AS empty_door,
        SUM(CASE WHEN address_village_city IN ('Not Provided','') OR address_village_city IS NULL THEN 1 ELSE 0 END) AS empty_or_placeholder_village
      FROM admissions
    `);
    console.log('\n=== ADMISSION ADDRESS STATS ===');
    console.log(stats[0]);
    const [sample] = await pool.execute(`
      SELECT admission_number, student_name, address_door_street, address_village_city, address_mandal, address_district
      FROM admissions
      WHERE TRIM(COALESCE(address_door_street,'')) = ''
        AND (address_village_city IN ('Not Provided','') OR address_village_city IS NULL)
      ORDER BY updated_at DESC
      LIMIT 10
    `);
    console.log('\nSample admissions with no real address:');
    console.log(sample);
  }

  await pool.end?.();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
