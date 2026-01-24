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
    fieldName: 'student_email',
    fieldType: 'email',
    fieldLabel: 'Student Email',
    placeholder: 'Enter email address',
    isRequired: false,
    displayOrder: 3,
    validationRules: {
      maxLength: 255,
    },
  },
  {
    fieldName: 'student_date_of_birth',
    fieldType: 'date',
    fieldLabel: 'Date of Birth',
    placeholder: 'Select date of birth',
    isRequired: true,
    displayOrder: 4,
    validationRules: {},
  },
  {
    fieldName: 'student_gender',
    fieldType: 'dropdown',
    fieldLabel: 'Gender',
    placeholder: 'Select gender',
    isRequired: true,
    displayOrder: 5,
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
    displayOrder: 6,
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
    displayOrder: 7,
    validationRules: {
      pattern: '^[0-9]{10}$',
      minLength: 10,
      maxLength: 10,
    },
  },
  {
    fieldName: 'mother_name',
    fieldType: 'text',
    fieldLabel: "Mother's Name",
    placeholder: "Enter mother's full name",
    isRequired: false,
    displayOrder: 8,
    validationRules: {
      minLength: 2,
      maxLength: 255,
    },
  },
  {
    fieldName: 'mother_phone',
    fieldType: 'tel',
    fieldLabel: "Mother's Phone Number",
    placeholder: 'Enter 10-digit phone number',
    isRequired: false,
    displayOrder: 9,
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
    displayOrder: 10,
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
    displayOrder: 11,
    validationRules: {
      minLength: 2,
      maxLength: 255,
    },
  },
  {
    fieldName: 'address_mandal',
    fieldType: 'text',
    fieldLabel: 'Mandal',
    placeholder: 'Enter mandal name',
    isRequired: true,
    displayOrder: 12,
    validationRules: {
      minLength: 2,
      maxLength: 255,
    },
  },
  {
    fieldName: 'address_district',
    fieldType: 'text',
    fieldLabel: 'District',
    placeholder: 'Enter district name',
    isRequired: true,
    displayOrder: 13,
    validationRules: {
      minLength: 2,
      maxLength: 255,
    },
  },
  {
    fieldName: 'address_pin_code',
    fieldType: 'text',
    fieldLabel: 'PIN Code',
    placeholder: 'Enter 6-digit PIN code',
    isRequired: true,
    displayOrder: 14,
    validationRules: {
      pattern: '^[0-9]{6}$',
      minLength: 6,
      maxLength: 6,
    },
  },
  {
    fieldName: 'course_interested',
    fieldType: 'text',
    fieldLabel: 'Course Interested',
    placeholder: 'Enter course name',
    isRequired: false,
    displayOrder: 15,
    validationRules: {
      maxLength: 255,
    },
  },
  {
    fieldName: 'quota',
    fieldType: 'dropdown',
    fieldLabel: 'Quota',
    placeholder: 'Select quota',
    isRequired: false,
    displayOrder: 16,
    options: [
      { value: 'Management', label: 'Management' },
      { value: 'Convenor', label: 'Convenor' },
      { value: 'Not Applicable', label: 'Not Applicable' },
    ],
    validationRules: {},
  },
];

const seedDefaultStudentForm = async () => {
  let pool;

  try {
    pool = getPool();

    console.log('Seeding default Student Details form...');

    // Check if default form already exists
    const [existing] = await pool.execute(
      'SELECT id FROM form_builder_forms WHERE is_default = TRUE AND name = ?',
      ['Student Details']
    );

    if (existing.length > 0) {
      console.log('Default Student Details form already exists. Skipping seed.');
      await closeDB();
      process.exit(0);
    }

    // Create the form
    const formId = uuidv4();
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

    // Create fields
    for (const field of defaultStudentFormFields) {
      const fieldId = uuidv4();
      await pool.execute(
        `INSERT INTO form_builder_fields (
          id, form_id, field_name, field_type, field_label, placeholder,
          is_required, validation_rules, display_order, options, is_active,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
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
          true,
        ]
      );
      console.log(`  ✓ Created field: ${field.fieldLabel} (${field.fieldName})`);
    }

    console.log('\n✅ Default Student Details form seeded successfully!');
    console.log(`   Form ID: ${formId}`);
    console.log(`   Total fields: ${defaultStudentFormFields.length}`);

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
