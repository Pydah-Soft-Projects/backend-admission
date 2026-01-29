import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const DATA_COLLECTION_TYPE_FIELD = {
  fieldName: 'data_collection_type',
  fieldType: 'dropdown',
  fieldLabel: 'Data Collection Type',
  placeholder: 'Select data collection type',
  isRequired: true,
  displayOrder: null, // set from max + 1
  options: [
    { value: 'Direct', label: 'Direct' },
    { value: 'Exam Center', label: 'Exam Center' },
    { value: 'College Visit', label: 'College Visit' },
  ],
  validationRules: {},
  helpText: null,
};

const STAFF_NAME_FIELD = {
  fieldName: 'staff_name',
  fieldType: 'text',
  fieldLabel: 'Staff Name',
  placeholder: 'Enter staff name',
  isRequired: false,
  displayOrder: null,
  validationRules: { minLength: 2, maxLength: 255 },
  helpText: 'Required when Data Collection Type is Direct or Exam Center',
};

const SCHOOL_OR_COLLEGE_NAME_FIELD = {
  fieldName: 'school_or_college_name',
  fieldType: 'text',
  fieldLabel: 'School or College Name',
  placeholder: 'Enter school or college name',
  isRequired: false,
  displayOrder: null,
  validationRules: { minLength: 2, maxLength: 255 },
  helpText: null,
};

const FIELDS_TO_ADD = [
  DATA_COLLECTION_TYPE_FIELD,
  STAFF_NAME_FIELD,
  SCHOOL_OR_COLLEGE_NAME_FIELD,
];

const run = async () => {
  let pool;

  try {
    pool = getPool();

    console.log('Adding Data Collection Type, Staff Name, and School or College Name fields to default Student Details form...\n');

    const [forms] = await pool.execute(
      "SELECT id FROM form_builder_forms WHERE is_default = TRUE AND name = 'Student Details' LIMIT 1"
    );

    if (forms.length === 0) {
      console.log('Default Student Details form not found. Run seed:sql first, or add the form via Form Builder.');
      await closeDB();
      process.exit(0);
    }

    const formId = forms[0].id;

    const fieldNames = FIELDS_TO_ADD.map((f) => f.fieldName);
    const placeholders = fieldNames.map(() => '?').join(', ');
    const [existingFields] = await pool.execute(
      `SELECT field_name FROM form_builder_fields WHERE form_id = ? AND field_name IN (${placeholders})`,
      [formId, ...fieldNames]
    );

    const existingNames = new Set(existingFields.map((r) => r.field_name));
    const toAdd = FIELDS_TO_ADD.filter((f) => !existingNames.has(f.fieldName));

    if (toAdd.length === 0) {
      console.log('All fields (Data Collection Type, Staff Name, School or College Name) already exist on the default form. Nothing to do.');
      await closeDB();
      process.exit(0);
    }

    const [maxOrder] = await pool.execute(
      'SELECT COALESCE(MAX(display_order), 0) AS max_order FROM form_builder_fields WHERE form_id = ?',
      [formId]
    );
    const nextOrder = (maxOrder[0]?.max_order ?? 0) + 1;

    for (let i = 0; i < toAdd.length; i++) {
      const field = { ...toAdd[i], displayOrder: nextOrder + i };
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
          field.fieldName,
          field.fieldType,
          field.fieldLabel,
          field.placeholder || null,
          field.isRequired,
          JSON.stringify(field.validationRules || {}),
          field.displayOrder,
          JSON.stringify(field.options || []),
          field.helpText || null,
        ]
      );
      console.log(`  ✓ Added field: ${field.fieldLabel} (${field.fieldName})`);
    }

    console.log('\n✅ Fields added successfully.');
    await closeDB();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    if (pool) await closeDB();
    process.exit(1);
  }
};

run();
