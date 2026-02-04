import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const defaultStudentFormFields = [
  {
    fieldName: 'student_name',
    fieldType: 'text',
    fieldLabel: 'Student Name',
    placeholder: 'Enter student full name',
    isRequired: true,
    displayOrder: 1,
    validationRules: {
      minLength: 2,
      maxLength: 255,
    },
  },
  {
    fieldName: 'student_phone',
    fieldType: 'tel',
    fieldLabel: 'Student Phone Number',
    placeholder: 'Enter 10-digit phone number',
    isRequired: true,
    displayOrder: 2,
    validationRules: {
      pattern: '^[0-9]{10}$',
      minLength: 10,
      maxLength: 10,
    },
  },
  {
    fieldName: 'student_gender',
    fieldType: 'dropdown',
    fieldLabel: 'Gender',
    placeholder: 'Select gender',
    isRequired: true,
    displayOrder: 3,
    options: [
      { value: 'male', label: 'Male' },
      { value: 'female', label: 'Female' },
      { value: 'other', label: 'Other' },
    ],
    validationRules: {},
  },
  {
    fieldName: 'father_name',
    fieldType: 'text',
    fieldLabel: "Father's Name",
    placeholder: "Enter father's full name",
    isRequired: true,
    displayOrder: 4,
    validationRules: {
      minLength: 2,
      maxLength: 255,
    },
  },
  {
    fieldName: 'father_phone',
    fieldType: 'tel',
    fieldLabel: "Father's Phone Number",
    placeholder: 'Enter 10-digit phone number',
    isRequired: true,
    displayOrder: 5,
    validationRules: {
      pattern: '^[0-9]{10}$',
      minLength: 10,
      maxLength: 10,
    },
  },
  {
    fieldName: 'address_door_street',
    fieldType: 'text',
    fieldLabel: 'Door/Street',
    placeholder: 'Enter door number and street',
    isRequired: true,
    displayOrder: 6,
    validationRules: {
      minLength: 5,
      maxLength: 255,
    },
  },
  {
    fieldName: 'address_village_city',
    fieldType: 'text',
    fieldLabel: 'Village/City',
    placeholder: 'Enter village or city name',
    isRequired: true,
    displayOrder: 7,
    validationRules: {
      minLength: 2,
      maxLength: 255,
    },
  },
  {
    fieldName: 'state',
    fieldType: 'dropdown',
    fieldLabel: 'State',
    placeholder: 'Select state',
    isRequired: true,
    displayOrder: 8,
    options: [],
    validationRules: {},
    helpText: 'Select state first; then district and mandal will be available.',
  },
  {
    fieldName: 'address_district',
    fieldType: 'text',
    fieldLabel: 'District',
    placeholder: 'Select district',
    isRequired: true,
    displayOrder: 9,
    validationRules: {
      minLength: 2,
      maxLength: 255,
    },
    helpText: 'Select state first to see districts.',
  },
  {
    fieldName: 'address_mandal',
    fieldType: 'text',
    fieldLabel: 'Mandal',
    placeholder: 'Select mandal',
    isRequired: true,
    displayOrder: 10,
    validationRules: {
      minLength: 2,
      maxLength: 255,
    },
    helpText: 'Select state and district first to see mandals.',
  },
  {
    fieldName: 'student_group',
    fieldType: 'dropdown',
    fieldLabel: 'Student Group',
    placeholder: 'Select student group',
    isRequired: true,
    displayOrder: 11,
    options: [
      { value: '10th', label: '10th' },
      { value: 'Inter-MPC', label: 'Inter-MPC' },
      { value: 'Inter-BIPC', label: 'Inter-BIPC' },
      { value: 'Degree', label: 'Degree' },
      { value: 'Diploma', label: 'Diploma' },
    ],
    validationRules: {},
  },
  {
    fieldName: 'school_or_college_name',
    fieldType: 'dropdown',
    fieldLabel: 'School or College Name',
    placeholder: 'Select school or college',
    isRequired: false,
    displayOrder: 12,
    options: [],
    validationRules: {},
  },
  {
    fieldName: 'academic_year',
    fieldType: 'dropdown',
    fieldLabel: 'Academic Year',
    placeholder: 'Select academic year',
    isRequired: true,
    displayOrder: 13,
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
  },
  {
    fieldName: 'data_collection_type',
    fieldType: 'dropdown',
    fieldLabel: 'Data Collection Type',
    placeholder: 'Select data collection type',
    isRequired: true,
    displayOrder: 14,
    options: [
      { value: 'Direct', label: 'Direct' },
      { value: 'Exam Center', label: 'Exam Center' },
      { value: 'College Visit', label: 'College Visit' },
    ],
    validationRules: {},
  },
  {
    fieldName: 'staff_name',
    fieldType: 'text',
    fieldLabel: 'Staff Name',
    placeholder: 'Enter staff name',
    isRequired: false,
    displayOrder: 15,
    validationRules: {
      minLength: 2,
      maxLength: 255,
    },
    helpText: 'Required when Data Collection Type is Direct or Exam Center',
  },
];

const isSyncMode = process.argv.includes('--sync') || process.argv.includes('--safe');

function insertField(pool, formId, field) {
  const fieldId = uuidv4();
  return pool.execute(
    `INSERT INTO form_builder_fields (
      id, form_id, field_name, field_type, field_label, placeholder,
      is_required, validation_rules, display_order, options, help_text, is_active,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
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
      true,
    ]
  );
}

const seedDefaultStudentForm = async () => {
  let pool;

  try {
    pool = getPool();

    console.log(isSyncMode
      ? 'Syncing default Student Details form (add only missing form/fields, no overwrite)...'
      : 'Seeding default Student Details form...');

    const [existing] = await pool.execute(
      'SELECT id FROM form_builder_forms WHERE is_default = TRUE AND name = ?',
      ['Student Details']
    );

    let formId;

    if (existing.length > 0) {
      formId = existing[0].id;
      if (!isSyncMode) {
        console.log('Default Student Details form already exists. Skipping seed.');
        console.log('To add only missing fields without changing existing data, run: node src/scripts-sql/seedDefaultStudentForm.js --sync');
        await closeDB();
        process.exit(0);
      }
      console.log(`Using existing form: Student Details (${formId})`);
    } else {
      formId = uuidv4();
      await pool.execute(
        `INSERT INTO form_builder_forms (
          id, name, description, is_default, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          formId,
          'Student Details',
          'Default form for collecting student information during lead generation',
          true,
          true,
        ]
      );
      console.log(`✓ Created form: Student Details (${formId})`);
    }

    let existingFieldNames = new Set();
    if (existing.length > 0) {
      const [rows] = await pool.execute(
        'SELECT field_name FROM form_builder_fields WHERE form_id = ?',
        [formId]
      );
      existingFieldNames = new Set(rows.map((r) => r.field_name));
    }

    let added = 0;
    for (const field of defaultStudentFormFields) {
      if (existingFieldNames.has(field.fieldName)) {
        if (isSyncMode) console.log(`  - Skipped (exists): ${field.fieldLabel} (${field.fieldName})`);
        continue;
      }
      await insertField(pool, formId, field);
      console.log(`  ✓ Created field: ${field.fieldLabel} (${field.fieldName})`);
      added += 1;
    }

    if (isSyncMode) {
      console.log(`\n✅ Sync complete. Form ID: ${formId}`);
      console.log(`   Fields added: ${added}. Existing fields left unchanged.`);
    } else {
      console.log('\n✅ Default Student Details form seeded successfully!');
      console.log(`   Form ID: ${formId}`);
      console.log(`   Total fields: ${defaultStudentFormFields.length}`);
    }

    await closeDB();
    process.exit(0);
  } catch (error) {
    console.error('Error seeding default Student Details form:', error);
    if (pool) {
      await closeDB();
    }
    process.exit(1);
  }
};

seedDefaultStudentForm();
