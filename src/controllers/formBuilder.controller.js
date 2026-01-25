import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { v4 as uuidv4 } from 'uuid';

// Helper function to format form data from SQL to camelCase
const formatForm = (formData) => {
  if (!formData) return null;
  return {
    id: formData.id,
    _id: formData.id,
    name: formData.name,
    description: formData.description || null,
    isDefault: formData.is_default === 1 || formData.is_default === true,
    isActive: formData.is_active === 1 || formData.is_active === true,
    createdBy: formData.created_by,
    updatedBy: formData.updated_by,
    createdAt: formData.created_at,
    updatedAt: formData.updated_at,
  };
};

// Helper function to format field data from SQL to camelCase
const formatField = (fieldData) => {
  if (!fieldData) return null;
  
  let validationRules = {};
  let options = [];
  
  try {
    if (fieldData.validation_rules) {
      validationRules = typeof fieldData.validation_rules === 'string' 
        ? JSON.parse(fieldData.validation_rules) 
        : fieldData.validation_rules;
    }
  } catch (e) {
    console.error('Error parsing validation_rules:', e);
  }
  
  try {
    if (fieldData.options) {
      options = typeof fieldData.options === 'string' 
        ? JSON.parse(fieldData.options) 
        : fieldData.options;
    }
  } catch (e) {
    console.error('Error parsing options:', e);
  }
  
  return {
    id: fieldData.id,
    _id: fieldData.id,
    formId: fieldData.form_id,
    fieldName: fieldData.field_name,
    fieldType: fieldData.field_type,
    fieldLabel: fieldData.field_label,
    placeholder: fieldData.placeholder || null,
    isRequired: fieldData.is_required === 1 || fieldData.is_required === true,
    validationRules: validationRules,
    displayOrder: fieldData.display_order || 0,
    options: options,
    defaultValue: fieldData.default_value || null,
    helpText: fieldData.help_text || null,
    isActive: fieldData.is_active === 1 || fieldData.is_active === true,
    createdBy: fieldData.created_by,
    updatedBy: fieldData.updated_by,
    createdAt: fieldData.created_at,
    updatedAt: fieldData.updated_at,
  };
};

/**
 * @desc    Get all forms
 * @route   GET /api/form-builder/forms
 * @access  Private
 */
export const listForms = async (req, res) => {
  try {
    const showInactive = req.query.showInactive === 'true';
    const includeFieldCount = req.query.includeFieldCount !== 'false'; // Default true
    const pool = getPool();

    let query = 'SELECT * FROM form_builder_forms';
    const params = [];
    
    if (!showInactive) {
      query += ' WHERE is_active = ?';
      params.push(true);
    }
    
    query += ' ORDER BY is_default DESC, name ASC';

    const [forms] = await pool.execute(query, params);
    const formattedForms = forms.map(formatForm);

    // If field count is requested, add field counts to each form
    if (includeFieldCount && formattedForms.length > 0) {
      const formIds = formattedForms.map(f => f.id);
      const placeholders = formIds.map(() => '?').join(',');
      
      let fieldCountQuery = `SELECT form_id, COUNT(*) as field_count FROM form_builder_fields WHERE form_id IN (${placeholders})`;
      const fieldCountParams = [...formIds];
      
      if (!showInactive) {
        fieldCountQuery += ' AND is_active = ?';
        fieldCountParams.push(true);
      }
      
      fieldCountQuery += ' GROUP BY form_id';
      
      const [fieldCounts] = await pool.execute(fieldCountQuery, fieldCountParams);
      
      // Create a map of form_id to field count
      const fieldCountMap = new Map();
      fieldCounts.forEach((row) => {
        // Convert BigInt to number if needed
        const count = typeof row.field_count === 'bigint' ? Number(row.field_count) : row.field_count;
        fieldCountMap.set(row.form_id, count);
      });
      
      // Add field count to each form
      formattedForms.forEach((form) => {
        form.fieldCount = fieldCountMap.get(form.id) || 0;
      });
    }

    return successResponse(res, formattedForms);
  } catch (error) {
    console.error('List forms error:', error);
    return errorResponse(res, error.message || 'Failed to fetch forms', 500);
  }
};

/**
 * @desc    Get a single form with its fields
 * @route   GET /api/form-builder/forms/:formId
 * @access  Private
 */
export const getForm = async (req, res) => {
  try {
    const { formId } = req.params;
    const includeFields = req.query.includeFields !== 'false'; // Default true
    const showInactive = req.query.showInactive === 'true';
    // Check if this is a public route (no user authentication)
    const isPublicRoute = !req.user;
    const pool = getPool();

    // Get form - for public routes, only return active forms
    let formQuery = 'SELECT * FROM form_builder_forms WHERE id = ?';
    const formParams = [formId];
    
    if (isPublicRoute) {
      formQuery += ' AND is_active = ?';
      formParams.push(true);
    }
    
    const [forms] = await pool.execute(formQuery, formParams);

    if (forms.length === 0) {
      return errorResponse(res, 'Form not found', 404);
    }

    const form = formatForm(forms[0]);

    if (!includeFields) {
      return successResponse(res, form);
    }

    // Get fields for this form
    let fieldQuery = 'SELECT * FROM form_builder_fields WHERE form_id = ?';
    const fieldParams = [formId];
    
    if (!showInactive) {
      fieldQuery += ' AND is_active = ?';
      fieldParams.push(true);
    }
    
    fieldQuery += ' ORDER BY display_order ASC, created_at ASC';

    const [fields] = await pool.execute(fieldQuery, fieldParams);
    const formattedFields = fields.map(formatField);

    return successResponse(res, {
      ...form,
      fields: formattedFields,
    });
  } catch (error) {
    console.error('Get form error:', error);
    return errorResponse(res, error.message || 'Failed to retrieve form', 500);
  }
};

/**
 * @desc    Create a new form
 * @route   POST /api/form-builder/forms
 * @access  Private (Super Admin)
 */
export const createForm = async (req, res) => {
  try {
    const { name, description, isDefault } = req.body;
    const userId = req.user?.id || req.user?._id;

    if (!name || !name.trim()) {
      return errorResponse(res, 'Form name is required', 400);
    }

    const pool = getPool();
    const formId = uuidv4();

    await pool.execute(
      `INSERT INTO form_builder_forms (
        id, name, description, is_default, is_active, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        formId,
        name.trim(),
        description?.trim() || null,
        isDefault === true,
        true,
        userId || null,
        userId || null,
      ]
    );

    // Automatically create mandatory fields: Student Name and Primary Phone Number
    const mandatoryFields = [
      {
        fieldName: 'name',
        fieldType: 'text',
        fieldLabel: 'Student Name',
        placeholder: 'Enter student name',
        isRequired: true,
        displayOrder: 0,
        helpText: 'Full name of the student',
      },
      {
        fieldName: 'phone',
        fieldType: 'tel',
        fieldLabel: 'Primary Phone Number',
        placeholder: 'Enter phone number',
        isRequired: true,
        displayOrder: 1,
        helpText: 'Primary contact phone number',
      },
    ];

    // Insert mandatory fields
    for (const field of mandatoryFields) {
      const fieldId = uuidv4();
      await pool.execute(
        `INSERT INTO form_builder_fields (
          id, form_id, field_name, field_type, field_label, placeholder, is_required,
          validation_rules, display_order, options, default_value, help_text, is_active,
          created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          fieldId,
          formId,
          field.fieldName,
          field.fieldType,
          field.fieldLabel,
          field.placeholder || null,
          field.isRequired,
          JSON.stringify({}),
          field.displayOrder,
          JSON.stringify([]),
          field.defaultValue || null,
          field.helpText || null,
          true,
          userId || null,
          userId || null,
        ]
      );
    }

    // Fetch the created form with fields
    const [forms] = await pool.execute(
      'SELECT * FROM form_builder_forms WHERE id = ?',
      [formId]
    );

    // Fetch the created fields
    const [fields] = await pool.execute(
      'SELECT * FROM form_builder_fields WHERE form_id = ? ORDER BY display_order ASC',
      [formId]
    );

    const form = formatForm(forms[0]);
    const formattedFields = fields.map(formatField);

    return successResponse(
      res,
      {
        ...form,
        fields: formattedFields,
      },
      'Form created successfully with mandatory fields (Student Name and Primary Phone Number)',
      201
    );
  } catch (error) {
    console.error('Create form error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return errorResponse(res, 'Form with this name already exists', 409);
    }
    return errorResponse(res, error.message || 'Failed to create form', 500);
  }
};

/**
 * @desc    Update a form
 * @route   PUT /api/form-builder/forms/:formId
 * @access  Private (Super Admin)
 */
export const updateForm = async (req, res) => {
  try {
    const { formId } = req.params;
    const { name, description, isDefault, isActive } = req.body;
    const userId = req.user?.id || req.user?._id;

    const pool = getPool();

    // Check if form exists
    const [existing] = await pool.execute(
      'SELECT * FROM form_builder_forms WHERE id = ?',
      [formId]
    );

    if (existing.length === 0) {
      return errorResponse(res, 'Form not found', 404);
    }

    // Build update query dynamically
    const updates = [];
    const params = [];

    if (name !== undefined) {
      if (!name || !name.trim()) {
        return errorResponse(res, 'Form name cannot be empty', 400);
      }
      updates.push('name = ?');
      params.push(name.trim());
    }

    if (description !== undefined) {
      updates.push('description = ?');
      params.push(description?.trim() || null);
    }

    if (isDefault !== undefined) {
      updates.push('is_default = ?');
      params.push(isDefault === true);
    }

    if (isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(isActive === true);
    }

    if (updates.length === 0) {
      return errorResponse(res, 'No fields to update', 400);
    }

    updates.push('updated_by = ?');
    updates.push('updated_at = NOW()');
    params.push(userId || null);
    params.push(formId);

    await pool.execute(
      `UPDATE form_builder_forms SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    // Fetch updated form
    const [forms] = await pool.execute(
      'SELECT * FROM form_builder_forms WHERE id = ?',
      [formId]
    );

    const form = formatForm(forms[0]);

    return successResponse(res, form, 'Form updated successfully');
  } catch (error) {
    console.error('Update form error:', error);
    return errorResponse(res, error.message || 'Failed to update form', 500);
  }
};

/**
 * @desc    Delete a form
 * @route   DELETE /api/form-builder/forms/:formId
 * @access  Private (Super Admin)
 */
export const deleteForm = async (req, res) => {
  try {
    const { formId } = req.params;
    const pool = getPool();

    // Check if form exists
    const [existing] = await pool.execute(
      'SELECT * FROM form_builder_forms WHERE id = ?',
      [formId]
    );

    if (existing.length === 0) {
      return errorResponse(res, 'Form not found', 404);
    }

    // Check if it's a default form
    if (existing[0].is_default === 1 || existing[0].is_default === true) {
      return errorResponse(res, 'Cannot delete default form', 400);
    }

    // Delete form (cascade will delete fields)
    await pool.execute('DELETE FROM form_builder_forms WHERE id = ?', [formId]);

    return successResponse(res, null, 'Form deleted successfully');
  } catch (error) {
    console.error('Delete form error:', error);
    return errorResponse(res, error.message || 'Failed to delete form', 500);
  }
};

/**
 * @desc    Get all fields for a form
 * @route   GET /api/form-builder/forms/:formId/fields
 * @access  Private
 */
export const listFields = async (req, res) => {
  try {
    const { formId } = req.params;
    const showInactive = req.query.showInactive === 'true';
    const pool = getPool();

    // Verify form exists
    const [forms] = await pool.execute(
      'SELECT id FROM form_builder_forms WHERE id = ?',
      [formId]
    );

    if (forms.length === 0) {
      return errorResponse(res, 'Form not found', 404);
    }

    let query = 'SELECT * FROM form_builder_fields WHERE form_id = ?';
    const params = [formId];
    
    if (!showInactive) {
      query += ' AND is_active = ?';
      params.push(true);
    }
    
    query += ' ORDER BY display_order ASC, created_at ASC';

    const [fields] = await pool.execute(query, params);
    const formattedFields = fields.map(formatField);

    return successResponse(res, formattedFields);
  } catch (error) {
    console.error('List fields error:', error);
    return errorResponse(res, error.message || 'Failed to fetch fields', 500);
  }
};

/**
 * @desc    Create a new field
 * @route   POST /api/form-builder/forms/:formId/fields
 * @access  Private (Super Admin)
 */
export const createField = async (req, res) => {
  try {
    const { formId } = req.params;
    const {
      fieldName,
      fieldType,
      fieldLabel,
      placeholder,
      isRequired,
      validationRules,
      displayOrder,
      options,
      defaultValue,
      helpText,
    } = req.body;
    const userId = req.user?.id || req.user?._id;

    if (!fieldName || !fieldName.trim()) {
      return errorResponse(res, 'Field name is required', 400);
    }

    if (!fieldType) {
      return errorResponse(res, 'Field type is required', 400);
    }

    const validFieldTypes = ['text', 'number', 'email', 'tel', 'date', 'dropdown', 'checkbox', 'radio', 'textarea', 'file'];
    if (!validFieldTypes.includes(fieldType)) {
      return errorResponse(res, `Invalid field type. Must be one of: ${validFieldTypes.join(', ')}`, 400);
    }

    if (!fieldLabel || !fieldLabel.trim()) {
      return errorResponse(res, 'Field label is required', 400);
    }

    const pool = getPool();

    // Verify form exists
    const [forms] = await pool.execute(
      'SELECT id FROM form_builder_forms WHERE id = ?',
      [formId]
    );

    if (forms.length === 0) {
      return errorResponse(res, 'Form not found', 404);
    }

    // Check if field name already exists in this form
    const [existing] = await pool.execute(
      'SELECT id FROM form_builder_fields WHERE form_id = ? AND field_name = ?',
      [formId, fieldName.trim()]
    );

    if (existing.length > 0) {
      return errorResponse(res, 'Field with this name already exists in this form', 409);
    }

    const fieldId = uuidv4();

    await pool.execute(
      `INSERT INTO form_builder_fields (
        id, form_id, field_name, field_type, field_label, placeholder, is_required,
        validation_rules, display_order, options, default_value, help_text,
        is_active, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        fieldId,
        formId,
        fieldName.trim(),
        fieldType,
        fieldLabel.trim(),
        placeholder?.trim() || null,
        isRequired === true,
        validationRules ? JSON.stringify(validationRules) : JSON.stringify({}),
        displayOrder || 0,
        options ? JSON.stringify(options) : JSON.stringify([]),
        defaultValue || null,
        helpText?.trim() || null,
        true,
        userId || null,
        userId || null,
      ]
    );

    // Fetch the created field
    const [fields] = await pool.execute(
      'SELECT * FROM form_builder_fields WHERE id = ?',
      [fieldId]
    );

    const field = formatField(fields[0]);

    return successResponse(res, field, 'Field created successfully', 201);
  } catch (error) {
    console.error('Create field error:', error);
    return errorResponse(res, error.message || 'Failed to create field', 500);
  }
};

/**
 * @desc    Update a field
 * @route   PUT /api/form-builder/fields/:fieldId
 * @access  Private (Super Admin)
 */
export const updateField = async (req, res) => {
  try {
    const { fieldId } = req.params;
    const {
      fieldName,
      fieldType,
      fieldLabel,
      placeholder,
      isRequired,
      validationRules,
      displayOrder,
      options,
      defaultValue,
      helpText,
      isActive,
    } = req.body;
    const userId = req.user?.id || req.user?._id;

    const pool = getPool();

    // Check if field exists
    const [existing] = await pool.execute(
      'SELECT * FROM form_builder_fields WHERE id = ?',
      [fieldId]
    );

    if (existing.length === 0) {
      return errorResponse(res, 'Field not found', 404);
    }

    // Build update query dynamically
    const updates = [];
    const params = [];

    if (fieldName !== undefined) {
      if (!fieldName || !fieldName.trim()) {
        return errorResponse(res, 'Field name cannot be empty', 400);
      }
      // Check if new field name conflicts with another field in the same form
      const [conflict] = await pool.execute(
        'SELECT id FROM form_builder_fields WHERE form_id = ? AND field_name = ? AND id != ?',
        [existing[0].form_id, fieldName.trim(), fieldId]
      );
      if (conflict.length > 0) {
        return errorResponse(res, 'Field with this name already exists in this form', 409);
      }
      updates.push('field_name = ?');
      params.push(fieldName.trim());
    }

    if (fieldType !== undefined) {
      const validFieldTypes = ['text', 'number', 'email', 'tel', 'date', 'dropdown', 'checkbox', 'radio', 'textarea', 'file'];
      if (!validFieldTypes.includes(fieldType)) {
        return errorResponse(res, `Invalid field type. Must be one of: ${validFieldTypes.join(', ')}`, 400);
      }
      updates.push('field_type = ?');
      params.push(fieldType);
    }

    if (fieldLabel !== undefined) {
      if (!fieldLabel || !fieldLabel.trim()) {
        return errorResponse(res, 'Field label cannot be empty', 400);
      }
      updates.push('field_label = ?');
      params.push(fieldLabel.trim());
    }

    if (placeholder !== undefined) {
      updates.push('placeholder = ?');
      params.push(placeholder?.trim() || null);
    }

    if (isRequired !== undefined) {
      updates.push('is_required = ?');
      params.push(isRequired === true);
    }

    if (validationRules !== undefined) {
      updates.push('validation_rules = ?');
      params.push(JSON.stringify(validationRules || {}));
    }

    if (displayOrder !== undefined) {
      updates.push('display_order = ?');
      params.push(displayOrder || 0);
    }

    if (options !== undefined) {
      updates.push('options = ?');
      params.push(JSON.stringify(options || []));
    }

    if (defaultValue !== undefined) {
      updates.push('default_value = ?');
      params.push(defaultValue || null);
    }

    if (helpText !== undefined) {
      updates.push('help_text = ?');
      params.push(helpText?.trim() || null);
    }

    if (isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(isActive === true);
    }

    if (updates.length === 0) {
      return errorResponse(res, 'No fields to update', 400);
    }

    updates.push('updated_by = ?');
    updates.push('updated_at = NOW()');
    params.push(userId || null);
    params.push(fieldId);

    await pool.execute(
      `UPDATE form_builder_fields SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    // Fetch updated field
    const [fields] = await pool.execute(
      'SELECT * FROM form_builder_fields WHERE id = ?',
      [fieldId]
    );

    const field = formatField(fields[0]);

    return successResponse(res, field, 'Field updated successfully');
  } catch (error) {
    console.error('Update field error:', error);
    return errorResponse(res, error.message || 'Failed to update field', 500);
  }
};

/**
 * @desc    Delete a field
 * @route   DELETE /api/form-builder/fields/:fieldId
 * @access  Private (Super Admin)
 */
export const deleteField = async (req, res) => {
  try {
    const { fieldId } = req.params;
    const pool = getPool();

    // Check if field exists
    const [existing] = await pool.execute(
      'SELECT * FROM form_builder_fields WHERE id = ?',
      [fieldId]
    );

    if (existing.length === 0) {
      return errorResponse(res, 'Field not found', 404);
    }

    // Delete field
    await pool.execute('DELETE FROM form_builder_fields WHERE id = ?', [fieldId]);

    return successResponse(res, null, 'Field deleted successfully');
  } catch (error) {
    console.error('Delete field error:', error);
    return errorResponse(res, error.message || 'Failed to delete field', 500);
  }
};

/**
 * @desc    Reorder fields
 * @route   PUT /api/form-builder/forms/:formId/fields/reorder
 * @access  Private (Super Admin)
 */
export const reorderFields = async (req, res) => {
  try {
    const { formId } = req.params;
    const { fieldIds } = req.body; // Array of field IDs in desired order
    const userId = req.user?.id || req.user?._id;

    if (!Array.isArray(fieldIds) || fieldIds.length === 0) {
      return errorResponse(res, 'fieldIds must be a non-empty array', 400);
    }

    const pool = getPool();

    // Verify form exists
    const [forms] = await pool.execute(
      'SELECT id FROM form_builder_forms WHERE id = ?',
      [formId]
    );

    if (forms.length === 0) {
      return errorResponse(res, 'Form not found', 404);
    }

    // Update display_order for each field
    const updatePromises = fieldIds.map((fieldId, index) => {
      return pool.execute(
        'UPDATE form_builder_fields SET display_order = ?, updated_by = ?, updated_at = NOW() WHERE id = ? AND form_id = ?',
        [index, userId || null, fieldId, formId]
      );
    });

    await Promise.all(updatePromises);

    return successResponse(res, null, 'Fields reordered successfully');
  } catch (error) {
    console.error('Reorder fields error:', error);
    return errorResponse(res, error.message || 'Failed to reorder fields', 500);
  }
};
