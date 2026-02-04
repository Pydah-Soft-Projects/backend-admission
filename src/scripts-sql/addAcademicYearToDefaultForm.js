/**
 * Add academic_year field to the existing default Student Details form if missing.
 * Run this if you already have the form and want the academic year field without re-seeding.
 */
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const ACADEMIC_YEAR_FIELD = {
  fieldName: 'academic_year',
  fieldType: 'dropdown',
  fieldLabel: 'Academic Year',
  placeholder: 'Select academic year',
  isRequired: true,
  displayOrder: null,
  options: [
    { value: '2024', label: '2024' },
    { value: '2025', label: '2025' },
    { value: '2026', label: '2026' },
    { value: '2027', label: '2027' },
    { value: '2028', label: '2028' },
      { value: '2029', label: '2029' },
      { value: '2030', label: '2030' },
      { value: '2031', label: '2031' },
      { value: '2032', label: '2032' },
      { value: '2033', label: '2033' },
      { value: '2034', label: '2034' },
      { value: '2035', label: '2035' },
  ],
  validationRules: {},
  helpText: 'Admission / academic year (e.g. 2025 for 2025-26 batch).',
};

const run = async () => {
  let pool;

  try {
    pool = getPool();

    console.log('Adding Academic Year field to default Student Details form...\n');

    const [forms] = await pool.execute(
      "SELECT id FROM form_builder_forms WHERE is_default = TRUE AND name = 'Student Details' LIMIT 1"
    );

    if (forms.length === 0) {
      console.log('Default Student Details form not found. Run seedDefaultStudentForm.js first.');
      await closeDB();
      process.exit(0);
    }

    const formId = forms[0].id;

    const [existing] = await pool.execute(
      'SELECT id FROM form_builder_fields WHERE form_id = ? AND field_name = ?',
      [formId, ACADEMIC_YEAR_FIELD.fieldName]
    );

    if (existing.length > 0) {
      console.log('Academic Year field already exists on the default form. Nothing to do.');
      await closeDB();
      process.exit(0);
    }

    const [maxOrder] = await pool.execute(
      'SELECT COALESCE(MAX(display_order), 0) AS max_order FROM form_builder_fields WHERE form_id = ?',
      [formId]
    );
    const displayOrder = (maxOrder[0]?.max_order ?? 0) + 1;

    const fieldId = uuidv4();
    await pool.execute(
      `INSERT INTO form_builder_fields (
        id, form_id, field_name, field_type, field_label, placeholder,
        is_required, validation_rules, display_order, options, help_text, is_active,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
      [
        fieldId,
        formId,
        ACADEMIC_YEAR_FIELD.fieldName,
        ACADEMIC_YEAR_FIELD.fieldType,
        ACADEMIC_YEAR_FIELD.fieldLabel,
        ACADEMIC_YEAR_FIELD.placeholder || null,
        ACADEMIC_YEAR_FIELD.isRequired,
        JSON.stringify(ACADEMIC_YEAR_FIELD.validationRules || {}),
        displayOrder,
        JSON.stringify(ACADEMIC_YEAR_FIELD.options || []),
        ACADEMIC_YEAR_FIELD.helpText || null,
      ]
    );

    console.log('✓ Academic Year field added to default Student Details form.');
    console.log('\n✅ Done.');
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await closeDB();
  }
};

run();
