import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { v4 as uuidv4 } from 'uuid';

const VAR_PLACEHOLDER_REGEX = /\{#var#\}/gi;

const buildDefaultVariables = (count) => {
  return Array.from({ length: count }).map((_, index) => ({
    key: `var${index + 1}`,
    label: `Variable ${index + 1}`,
    defaultValue: '',
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
    }));

  while (sanitized.length < requiredCount) {
    sanitized.push({
      key: `var${sanitized.length + 1}`,
      label: `Variable ${sanitized.length + 1}`,
      defaultValue: '',
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
    dltTemplateId: templateData.dlt_template_id,
    language: templateData.language,
    content: templateData.content,
    description: templateData.description || '',
    isUnicode: templateData.is_unicode === 1 || templateData.is_unicode === true,
    variableCount: templateData.variable_count || 0,
    variables: typeof templateData.variables === 'string' 
      ? JSON.parse(templateData.variables) 
      : templateData.variables || [],
    isActive: templateData.is_active === 1 || templateData.is_active === true,
    createdBy: templateData.created_by,
    updatedBy: templateData.updated_by,
    createdAt: templateData.created_at,
    updatedAt: templateData.updated_at,
  };
};

export const getTemplates = async (req, res) => {
  try {
    const { language, isActive, search } = req.query;
    const pool = getPool();

    const conditions = [];
    const params = [];

    if (language) {
      conditions.push('language = ?');
      params.push(language.toLowerCase());
    }
    if (isActive !== undefined) {
      conditions.push('is_active = ?');
      params.push(isActive === 'true');
    }
    if (search) {
      const searchTerm = search.trim();
      conditions.push('(name LIKE ? OR dlt_template_id LIKE ?)');
      params.push(`%${searchTerm}%`, `%${searchTerm}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [templates] = await pool.execute(
      `SELECT * FROM message_templates ${whereClause} ORDER BY is_active DESC, updated_at DESC`,
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
    const { language } = req.query;
    const pool = getPool();

    const conditions = ['is_active = ?'];
    const params = [true];

    if (language) {
      conditions.push('language = ?');
      params.push(language.toLowerCase());
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const [templates] = await pool.execute(
      `SELECT * FROM message_templates ${whereClause} ORDER BY name ASC`,
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
    } = req.body;

    if (!name?.trim() || !dltTemplateId?.trim() || !content?.trim()) {
      return errorResponse(res, 'Name, DLT Template ID, and content are required', 400);
    }

    const variableCount = (content.match(VAR_PLACEHOLDER_REGEX) || []).length;
    const normalizedVars = normalizeVariables(variables, variableCount);
    const pool = getPool();
    const templateId = uuidv4();
    const userId = req.user?.id || req.user?._id;

    await pool.execute(
      `INSERT INTO message_templates (
        id, name, dlt_template_id, language, content, description, is_unicode,
        variable_count, variables, is_active, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        templateId,
        name.trim(),
        dltTemplateId.trim(),
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
      'SELECT * FROM message_templates WHERE id = ?',
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
      'SELECT * FROM message_templates WHERE id = ?',
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

