import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const STATE_FIELD = {
  fieldName: 'state',
  fieldType: 'dropdown',
  fieldLabel: 'State',
  placeholder: 'Select state',
  isRequired: true,
  displayOrder: 12,
  options: [],
  validationRules: {},
  helpText: 'Select state first; then district and mandal will be available.',
};

const run = async () => {
  let pool;

  try {
    pool = getPool();
    console.log('Adding State field to default Student Details form (for district/mandal dropdowns)...\n');

    const [forms] = await pool.execute(
      "SELECT id FROM form_builder_forms WHERE is_default = TRUE AND name = 'Student Details' LIMIT 1"
    );

    if (forms.length === 0) {
      console.log('Default Student Details form not found. Run seed:sql first.');
      await closeDB();
      process.exit(0);
    }

    const formId = forms[0].id;

    const [existing] = await pool.execute(
      'SELECT id FROM form_builder_fields WHERE form_id = ? AND field_name IN (?, ?)',
      [formId, 'state', 'address_state']
    );

    if (existing.length > 0) {
      console.log('State (or address_state) field already exists. Nothing to do.');
      await closeDB();
      process.exit(0);
    }

    await pool.execute(
      'UPDATE form_builder_fields SET display_order = display_order + 1 WHERE form_id = ? AND display_order >= ?',
      [formId, STATE_FIELD.displayOrder]
    );

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
        STATE_FIELD.fieldName,
        STATE_FIELD.fieldType,
        STATE_FIELD.fieldLabel,
        STATE_FIELD.placeholder || null,
        STATE_FIELD.isRequired,
        JSON.stringify(STATE_FIELD.validationRules || {}),
        STATE_FIELD.displayOrder,
        JSON.stringify(STATE_FIELD.options || []),
        STATE_FIELD.helpText || null,
      ]
    );

    console.log('  ✓ Added field: State (state)');
    console.log('\n✅ State field added. District and Mandal will now show as dropdowns when state is selected.');
    await closeDB();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    if (pool) await closeDB();
    process.exit(1);
  }
};

run();
