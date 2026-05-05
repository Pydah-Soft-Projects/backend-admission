import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { v4 as uuidv4 } from 'uuid';

const VAR_PLACEHOLDER_REGEX = /\{#var#\}/gi;

const buildDefaultVariables = (count) => {
  return Array.from({ length: count }).map((_, index) => ({
    key: `var${index + 1}`,
    label: `Variable ${index + 1}`,
    defaultValue: '',
    isGlobal: false,
  }));
};

const normalizeVariables = (requestedVariables, requiredCount) => {
  if (!Array.isArray(requestedVariables) || requestedVariables.length === 0) {
    return buildDefaultVariables(requiredCount);
  }

  const sanitized = requestedVariables
    .slice(0, requiredCount)
    .map((variable, index) => ({
      key: variable?.key?.trim() || `var${index + 1}`,
      label: variable?.label?.trim() || `Variable ${index + 1}`,
      defaultValue: variable?.defaultValue ? String(variable.defaultValue).trim() : '',
      isGlobal: variable?.isGlobal === true || variable?.isGlobal === 'true',
    }));

  while (sanitized.length < requiredCount) {
    sanitized.push({
      key: `var${sanitized.length + 1}`,
      label: `Variable ${sanitized.length + 1}`,
      defaultValue: '',
      isGlobal: false,
    });
  }

  return sanitized;
};

// Helper function to format template data from SQL to camelCase
const formatTemplate = (templateData) => {
  if (!templateData) return null;
  return {
    id: templateData.id,
    _id: templateData.id, // Keep _id for backward compatibility
    name: templateData.name,
    templateGroupId: templateData.template_group_id || null,
    templateGroupName: templateData.template_group_name || null,
    dltTemplateId: templateData.dlt_template_id,
    language: templateData.language,
    content: templateData.content,
    description: templateData.description || '',
    isUnicode: templateData.is_unicode === 1 || templateData.is_unicode === true,
    variableCount: templateData.variable_count || 0,
    variables: typeof templateData.variables === 'string' 
      ? JSON.parse(templateData.variables) 
      : templateData.variables || [],
    category: templateData.category || 'sms',
    headerType: templateData.header_type || 'TEXT',
    headerText: templateData.header_text || '',
    headerHandle: templateData.header_handle || '',
    mediaGallery: typeof templateData.media_gallery === 'string' 
      ? JSON.parse(templateData.media_gallery) 
      : templateData.media_gallery || [],
    isActive: templateData.is_active === 1 || templateData.is_active === true,
    createdBy: templateData.created_by,
    updatedBy: templateData.updated_by,
    createdAt: templateData.created_at,
    updatedAt: templateData.updated_at,
  };
};

const assertTemplateGroupExists = async (pool, groupId) => {
  if (!groupId || String(groupId).trim() === '') return null;
  const id = String(groupId).trim();
  const [rows] = await pool.execute('SELECT id FROM message_template_groups WHERE id = ?', [id]);
  if (rows.length === 0) {
    throw new Error('Template group not found');
  }
  return id;
};

export const getTemplateGroups = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      'SELECT id, name, created_at, updated_at FROM message_template_groups ORDER BY name ASC'
    );
    const list = (rows || []).map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    return successResponse(res, list, 'Template groups retrieved successfully');
  } catch (error) {
    console.error('Error fetching template groups:', error);
    return errorResponse(res, error.message || 'Failed to fetch template groups', 500);
  }
};

export const createTemplateGroup = async (req, res) => {
  try {
    const { name } = req.body;
    const trimmed = name != null ? String(name).trim() : '';
    if (!trimmed) {
      return errorResponse(res, 'Group name is required', 400);
    }
    const pool = getPool();
    const groupId = uuidv4();
    try {
      await pool.execute(
        'INSERT INTO message_template_groups (id, name, created_at, updated_at) VALUES (?, ?, NOW(), NOW())',
        [groupId, trimmed]
      );
    } catch (e) {
      if (e && (e.code === 'ER_DUP_ENTRY' || String(e.message || '').includes('Duplicate'))) {
        return errorResponse(res, 'A group with this name already exists', 409);
      }
      throw e;
    }
    const [created] = await pool.execute(
      'SELECT id, name, created_at, updated_at FROM message_template_groups WHERE id = ?',
      [groupId]
    );
    const r = created[0];
    return successResponse(
      res,
      { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at },
      'Template group created successfully',
      201
    );
  } catch (error) {
    console.error('Error creating template group:', error);
    return errorResponse(res, error.message || 'Failed to create template group', 500);
  }
};

export const updateTemplateGroup = async (req, res) => {
  try {
    const { id } = req.params;
    const groupId = id != null ? String(id).trim() : '';
    if (!groupId) {
      return errorResponse(res, 'Group id is required', 400);
    }
    const { name } = req.body;
    const trimmed = name != null ? String(name).trim() : '';
    if (!trimmed) {
      return errorResponse(res, 'Group name is required', 400);
    }
    const pool = getPool();
    const [exists] = await pool.execute('SELECT id FROM message_template_groups WHERE id = ?', [groupId]);
    if (!exists.length) {
      return errorResponse(res, 'Template group not found', 404);
    }
    try {
      await pool.execute(
        'UPDATE message_template_groups SET name = ?, updated_at = NOW() WHERE id = ?',
        [trimmed, groupId]
      );
    } catch (e) {
      if (e && (e.code === 'ER_DUP_ENTRY' || String(e.message || '').includes('Duplicate'))) {
        return errorResponse(res, 'A group with this name already exists', 409);
      }
      throw e;
    }
    const [updated] = await pool.execute(
      'SELECT id, name, created_at, updated_at FROM message_template_groups WHERE id = ?',
      [groupId]
    );
    const r = updated[0];
    return successResponse(
      res,
      { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at },
      'Template group updated successfully'
    );
  } catch (error) {
    console.error('Error updating template group:', error);
    return errorResponse(res, error.message || 'Failed to update template group', 500);
  }
};

export const deleteTemplateGroup = async (req, res) => {
  try {
    const { id } = req.params;
    const groupId = id != null ? String(id).trim() : '';
    if (!groupId) {
      return errorResponse(res, 'Group id is required', 400);
    }
    const pool = getPool();
    const [result] = await pool.execute('DELETE FROM message_template_groups WHERE id = ?', [groupId]);
    if (!result.affectedRows) {
      return errorResponse(res, 'Template group not found', 404);
    }
    return successResponse(res, { id: groupId }, 'Template group deleted successfully');
  } catch (error) {
    console.error('Error deleting template group:', error);
    return errorResponse(res, error.message || 'Failed to delete template group', 500);
  }
};

export const getTemplates = async (req, res) => {
  try {
    const { language, isActive, search, templateGroupId, category } = req.query;
    const pool = getPool();

    const conditions = [];
    const params = [];

    if (category) {
      if (category.toLowerCase() === 'sms') {
        conditions.push('(t.category = ? OR t.category IS NULL OR t.category = \'\')');
      } else {
        conditions.push('t.category = ?');
      }
      params.push(category.toLowerCase());
    }

    if (language) {
      conditions.push('t.language = ?');
      params.push(language.toLowerCase());
    }
    if (isActive !== undefined) {
      conditions.push('t.is_active = ?');
      params.push(isActive === 'true');
    }
    if (search) {
      const searchTerm = search.trim();
      conditions.push('(t.name LIKE ? OR t.dlt_template_id LIKE ?)');
      params.push(`%${searchTerm}%`, `%${searchTerm}%`);
    }
    if (templateGroupId && String(templateGroupId).trim() !== '') {
      conditions.push('t.template_group_id = ?');
      params.push(String(templateGroupId).trim());
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [templates] = await pool.execute(
      `SELECT t.*, g.name AS template_group_name
       FROM message_templates t
       LEFT JOIN message_template_groups g ON t.template_group_id = g.id
       ${whereClause}
       ORDER BY t.is_active DESC, t.updated_at DESC`,
      params
    );

    const formattedTemplates = templates.map(formatTemplate);

    return successResponse(res, formattedTemplates, 'Templates retrieved successfully');
  } catch (error) {
    console.error('Error fetching templates:', error);
    return errorResponse(res, error.message || 'Failed to fetch templates', 500);
  }
};

export const getActiveTemplates = async (req, res) => {
  try {
    const { language, category } = req.query;
    const pool = getPool();

    const conditions = ['t.is_active = ?'];
    const params = [true];

    if (category) {
      if (category.toLowerCase() === 'sms') {
        conditions.push('(t.category = ? OR t.category IS NULL OR t.category = \'\')');
      } else {
        conditions.push('t.category = ?');
      }
      params.push(category.toLowerCase());
    }

    if (language) {
      conditions.push('t.language = ?');
      params.push(language.toLowerCase());
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const [templates] = await pool.execute(
      `SELECT t.*, g.name AS template_group_name
       FROM message_templates t
       LEFT JOIN message_template_groups g ON t.template_group_id = g.id
       ${whereClause}
       ORDER BY t.name ASC`,
      params
    );

    const formattedTemplates = templates.map(formatTemplate);

    return successResponse(res, formattedTemplates, 'Active templates retrieved successfully');
  } catch (error) {
    console.error('Error fetching active templates:', error);
    return errorResponse(res, error.message || 'Failed to fetch active templates', 500);
  }
};

export const createTemplate = async (req, res) => {
  try {
    const {
      name,
      dltTemplateId,
      language = 'en',
      content,
      description,
      isUnicode,
      variables,
      templateGroupId,
      category = 'sms'
    } = req.body;

    if (!name?.trim() || !dltTemplateId?.trim() || !content?.trim()) {
      return errorResponse(res, 'Name, DLT Template ID, and content are required', 400);
    }

    const variableCount = (content.match(VAR_PLACEHOLDER_REGEX) || []).length;
    const normalizedVars = normalizeVariables(variables, variableCount);
    const pool = getPool();
    const templateId = uuidv4();
    const userId = req.user?.id || req.user?._id;

    let groupIdResolved = null;
    try {
      groupIdResolved = await assertTemplateGroupExists(pool, templateGroupId);
    } catch (e) {
      return errorResponse(res, e.message || 'Invalid template group', 400);
    }

    await pool.execute(
      `INSERT INTO message_templates (
        id, name, template_group_id, category, dlt_template_id, language, content, description, is_unicode,
        variable_count, variables, is_active, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        templateId,
        name.trim(),
        groupIdResolved,
        (category || 'sms').toLowerCase(),
        (dltTemplateId || '').trim(),
        language.trim().toLowerCase(),
        content.trim(),
        description?.trim() || null,
        Boolean(isUnicode),
        variableCount,
        JSON.stringify(normalizedVars),
        true,
        userId || null,
        userId || null,
      ]
    );

    // Fetch created template
    const [templates] = await pool.execute(
      `SELECT t.*, g.name AS template_group_name
       FROM message_templates t
       LEFT JOIN message_template_groups g ON t.template_group_id = g.id
       WHERE t.id = ?`,
      [templateId]
    );

    const template = formatTemplate(templates[0]);

    return successResponse(res, template, 'Template created successfully', 201);
  } catch (error) {
    console.error('Error creating template:', error);
    return errorResponse(res, error.message || 'Failed to create template', 500);
  }
};

export const updateTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      dltTemplateId,
      language,
      content,
      description,
      isUnicode,
      variables,
      isActive,
      templateGroupId,
      category
    } = req.body;

    const pool = getPool();
    const userId = req.user?.id || req.user?._id;

    // Check if template exists
    const [templates] = await pool.execute(
      'SELECT * FROM message_templates WHERE id = ?',
      [id]
    );

    if (templates.length === 0) {
      return errorResponse(res, 'Template not found', 404);
    }

    const currentTemplate = templates[0];
    const updateFields = [];
    const updateValues = [];

    if (name !== undefined) {
      updateFields.push('name = ?');
      updateValues.push(name?.trim() || currentTemplate.name);
    }

    if (dltTemplateId !== undefined) {
      updateFields.push('dlt_template_id = ?');
      updateValues.push(dltTemplateId?.trim() || currentTemplate.dlt_template_id);
    }

    if (language !== undefined) {
      updateFields.push('language = ?');
      updateValues.push(language?.trim()?.toLowerCase() || currentTemplate.language);
    }

    if (description !== undefined) {
      updateFields.push('description = ?');
      updateValues.push(description?.trim() || '');
    }

    if (isUnicode !== undefined) {
      updateFields.push('is_unicode = ?');
      updateValues.push(Boolean(isUnicode));
    }

    if (isActive !== undefined) {
      updateFields.push('is_active = ?');
      updateValues.push(Boolean(isActive));
    }

    if (category !== undefined) {
      updateFields.push('category = ?');
      updateValues.push(category?.trim()?.toLowerCase() || currentTemplate.category);
    }

    if (templateGroupId !== undefined) {
      if (templateGroupId === null || templateGroupId === '') {
        updateFields.push('template_group_id = ?');
        updateValues.push(null);
      } else {
        try {
          const gid = await assertTemplateGroupExists(pool, templateGroupId);
          updateFields.push('template_group_id = ?');
          updateValues.push(gid);
        } catch (e) {
          return errorResponse(res, e.message || 'Invalid template group', 400);
        }
      }
    }

    if (req.body.headerHandle !== undefined) {
      updateFields.push('header_handle = ?');
      updateValues.push(req.body.headerHandle);
    }
    if (req.body.headerText !== undefined) {
      updateFields.push('header_text = ?');
      updateValues.push(req.body.headerText);
    }
    if (req.body.mediaGallery !== undefined) {
      updateFields.push('media_gallery = ?');
      updateValues.push(JSON.stringify(req.body.mediaGallery));
    }

    if (content !== undefined) {
      if (!content?.trim()) {
        return errorResponse(res, 'Content cannot be empty', 400);
      }

      const cleanedContent = content.trim();
      const variableCount = (cleanedContent.match(VAR_PLACEHOLDER_REGEX) || []).length;

      updateFields.push('content = ?');
      updateValues.push(cleanedContent);
      updateFields.push('variable_count = ?');
      updateValues.push(variableCount);
      updateFields.push('variables = ?');
      updateValues.push(JSON.stringify(normalizeVariables(variables, variableCount)));
    } else if (variables !== undefined) {
      updateFields.push('variables = ?');
      updateValues.push(JSON.stringify(normalizeVariables(variables, currentTemplate.variable_count || 0)));
    }

    if (userId) {
      updateFields.push('updated_by = ?');
      updateValues.push(userId);
    }

    // Execute update
    if (updateFields.length > 0) {
      updateFields.push('updated_at = NOW()');
      updateValues.push(id);
      await pool.execute(
        `UPDATE message_templates SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );
    }

    // Fetch updated template
    const [updatedTemplates] = await pool.execute(
      `SELECT t.*, g.name AS template_group_name
       FROM message_templates t
       LEFT JOIN message_template_groups g ON t.template_group_id = g.id
       WHERE t.id = ?`,
      [id]
    );

    const template = formatTemplate(updatedTemplates[0]);

    return successResponse(res, template, 'Template updated successfully');
  } catch (error) {
    console.error('Error updating template:', error);
    return errorResponse(res, error.message || 'Failed to update template', 500);
  }
};

export const deleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const pool = getPool();
    const userId = req.user?.id || req.user?._id;

    // Check if template exists
    const [templates] = await pool.execute(
      'SELECT * FROM message_templates WHERE id = ?',
      [id]
    );

    if (templates.length === 0) {
      return errorResponse(res, 'Template not found', 404);
    }

    // Deactivate template
    const updateFields = ['is_active = ?', 'updated_at = NOW()'];
    const updateValues = [false];

    if (userId) {
      updateFields.splice(1, 0, 'updated_by = ?');
      updateValues.push(userId);
    }

    updateValues.push(id);

    await pool.execute(
      `UPDATE message_templates SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // Fetch updated template
    const [updatedTemplates] = await pool.execute(
      'SELECT * FROM message_templates WHERE id = ?',
      [id]
    );

    const template = formatTemplate(updatedTemplates[0]);

    return successResponse(res, template, 'Template deactivated successfully');
  } catch (error) {
    console.error('Error deleting template:', error);
    return errorResponse(res, error.message || 'Failed to delete template', 500);
  }
};

export const hardDeleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const pool = getPool();

    // Check if template exists
    const [templates] = await pool.execute(
      'SELECT * FROM message_templates WHERE id = ?',
      [id]
    );

    if (templates.length === 0) {
      return errorResponse(res, 'Template not found', 404);
    }

    // Hard delete from database
    await pool.execute(
      'DELETE FROM message_templates WHERE id = ?',
      [id]
    );

    return successResponse(res, null, 'Template permanently deleted');
  } catch (error) {
    console.error('Error hard deleting template:', error);
    return errorResponse(res, error.message || 'Failed to hard delete template', 500);
  }
};

