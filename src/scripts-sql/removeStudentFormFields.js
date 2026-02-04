/**
 * Remove specific fields from the default Student Details form and set display_order
 * so existing form fields show in the correct order (Student Group → School or College Name → …).
 *
 * 1. Deletes: student_email, student_date_of_birth, mother_name, mother_phone,
 *    address_pin_code, course_interested, quota.
 * 2. Updates display_order for all remaining fields to match the intended order.
 *
 * Run from backend-admission: node src/scripts-sql/removeStudentFormFields.js
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const FIELDS_TO_REMOVE = [
  'student_email',
  'student_date_of_birth',
  'mother_name',
  'mother_phone',
  'address_pin_code',
  'course_interested',
  'quota',
];

// Intended order: after Student Group comes School or College Name, then Academic Year, etc.
const DISPLAY_ORDER_BY_FIELD = {
  student_name: 1,
  student_phone: 2,
  student_gender: 3,
  father_name: 4,
  father_phone: 5,
  address_door_street: 6,
  address_village_city: 7,
  state: 8,
  address_district: 9,
  address_mandal: 10,
  student_group: 11,
  school_or_college_name: 12,
  academic_year: 13,
  data_collection_type: 14,
  staff_name: 15,
};

const run = async () => {
  let pool;
  try {
    pool = getPool();
    console.log('Updating default Student Details form...\n');

    const [forms] = await pool.execute(
      'SELECT id, name FROM form_builder_forms WHERE is_default = TRUE AND name = ?',
      ['Student Details']
    );

    if (forms.length === 0) {
      console.log('No default Student Details form found. Nothing to do.');
      await closeDB();
      process.exit(0);
    }

    const formId = forms[0].id;
    let removed = 0;

    for (const fieldName of FIELDS_TO_REMOVE) {
      const [result] = await pool.execute(
        'DELETE FROM form_builder_fields WHERE form_id = ? AND field_name = ?',
        [formId, fieldName]
      );
      if (result.affectedRows > 0) {
        console.log(`  ✓ Removed field: ${fieldName}`);
        removed += 1;
      }
    }

    let updated = 0;
    for (const [fieldName, order] of Object.entries(DISPLAY_ORDER_BY_FIELD)) {
      const [result] = await pool.execute(
        'UPDATE form_builder_fields SET display_order = ? WHERE form_id = ? AND field_name = ?',
        [order, formId, fieldName]
      );
      if (result.affectedRows > 0) {
        updated += 1;
      }
    }
    if (updated > 0) {
      console.log(`  ✓ Updated display_order for ${updated} field(s).`);
    }

    console.log(`\n✅ Done. Removed ${removed} field(s). Display order set for remaining fields.`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await closeDB();
  }
};

run();
