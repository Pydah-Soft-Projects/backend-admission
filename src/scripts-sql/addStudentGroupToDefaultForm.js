/**
 * Migration: Add student_group field to the default Student Details form (if it exists).
 * Use this when you have already seeded the form and want to add the new field without re-seeding.
 * Run: node src/scripts-sql/addStudentGroupToDefaultForm.js (from backend-admission directory)
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const STUDENT_GROUP_FIELD = {
  fieldName: 'student_group',
  fieldType: 'dropdown',
  fieldLabel: 'Student Group',
  placeholder: 'Select student group',
  isRequired: true,
  displayOrder: 18,
  options: [
    { value: '10th', label: '10th' },
    { value: 'Inter-MPC', label: 'Inter-MPC' },
    { value: 'Inter-BIPC', label: 'Inter-BIPC' },
    { value: 'Degree', label: 'Degree' },
    { value: 'Diploma', label: 'Diploma' },
  ],
  validationRules: {},
};

const run = async () => {
  let pool;

  try {
    pool = getPool();
    console.log('Adding student_group field to default Student Details form...\n');

    const [forms] = await pool.execute(
      'SELECT id FROM form_builder_forms WHERE is_default = TRUE AND name = ?',
      ['Student Details']
    );

    if (forms.length === 0) {
      console.log('Default Student Details form not found. Run seedDefaultStudentForm.js first.');
      await closeDB();
      process.exit(0);
    }

    const formId = forms[0].id;

    const [existing] = await pool.execute(
      'SELECT id FROM form_builder_fields WHERE form_id = ? AND field_name = ?',
      [formId, 'student_group']
    );

    if (existing.length > 0) {
      console.log('Field student_group already exists on default form. Skipping.');
      await closeDB();
      process.exit(0);
    }

    const fieldId = uuidv4();
    await pool.execute(
      `INSERT INTO form_builder_fields (
        id, form_id, field_name, field_type, field_label, placeholder,
        is_required, validation_rules, display_order, options, help_text, is_active,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        fieldId,
        formId,
        STUDENT_GROUP_FIELD.fieldName,
        STUDENT_GROUP_FIELD.fieldType,
        STUDENT_GROUP_FIELD.fieldLabel,
        STUDENT_GROUP_FIELD.placeholder || null,
        STUDENT_GROUP_FIELD.isRequired,
        JSON.stringify(STUDENT_GROUP_FIELD.validationRules || {}),
        STUDENT_GROUP_FIELD.displayOrder,
        JSON.stringify(STUDENT_GROUP_FIELD.options || []),
        null,
        true,
      ]
    );

    console.log('✓ Added field: Student Group (student_group)');
    console.log('\nDone.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await closeDB();
    process.exit(0);
  }
};

run();
