import MessageTemplate from '../models/MessageTemplate.model.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

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

const applyTemplateMetadata = (template, userId) => {
  if (userId) {
    if (!template.createdBy) {
      template.createdBy = userId;
    }
    template.updatedBy = userId;
  }
  return template;
};

export const getTemplates = async (req, res) => {
  try {
    const { language, isActive, search } = req.query;
    const filter = {};

    if (language) {
      filter.language = language.toLowerCase();
    }
    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }
    if (search) {
      const regex = new RegExp(search.trim(), 'i');
      filter.$or = [{ name: regex }, { dltTemplateId: regex }];
    }

    const templates = await MessageTemplate.find(filter)
      .sort({ isActive: -1, updatedAt: -1 })
      .lean();

    return successResponse(res, templates, 'Templates retrieved successfully');
  } catch (error) {
    console.error('Error fetching templates:', error);
    return errorResponse(res, error.message || 'Failed to fetch templates', 500);
  }
};

export const getActiveTemplates = async (req, res) => {
  try {
    const { language } = req.query;
    const filter = { isActive: true };

    if (language) {
      filter.language = language.toLowerCase();
    }

    const templates = await MessageTemplate.find(filter)
      .sort({ name: 1 })
      .lean();

    return successResponse(res, templates, 'Active templates retrieved successfully');
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

    const template = new MessageTemplate({
      name: name.trim(),
      dltTemplateId: dltTemplateId.trim(),
      language: language.trim().toLowerCase(),
      content: content.trim(),
      description: description?.trim(),
      isUnicode: Boolean(isUnicode),
      variableCount,
      variables: normalizeVariables(variables, variableCount),
    });

    applyTemplateMetadata(template, req.user?._id);

    await template.save();

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

    const template = await MessageTemplate.findById(id);

    if (!template) {
      return errorResponse(res, 'Template not found', 404);
    }

    if (name !== undefined) {
      template.name = name?.trim() || template.name;
    }

    if (dltTemplateId !== undefined) {
      template.dltTemplateId = dltTemplateId?.trim() || template.dltTemplateId;
    }

    if (language !== undefined) {
      template.language = language?.trim()?.toLowerCase() || template.language;
    }

    if (description !== undefined) {
      template.description = description?.trim() || '';
    }

    if (isUnicode !== undefined) {
      template.isUnicode = Boolean(isUnicode);
    }

    if (isActive !== undefined) {
      template.isActive = Boolean(isActive);
    }

    if (content !== undefined) {
      if (!content?.trim()) {
        return errorResponse(res, 'Content cannot be empty', 400);
      }

      const cleanedContent = content.trim();
      const variableCount = (cleanedContent.match(VAR_PLACEHOLDER_REGEX) || []).length;

      template.content = cleanedContent;
      template.variableCount = variableCount;
      template.variables = normalizeVariables(variables, variableCount);
    } else if (variables !== undefined) {
      template.variables = normalizeVariables(variables, template.variableCount);
    }

    applyTemplateMetadata(template, req.user?._id);

    await template.save();

    return successResponse(res, template, 'Template updated successfully');
  } catch (error) {
    console.error('Error updating template:', error);
    return errorResponse(res, error.message || 'Failed to update template', 500);
  }
};

export const deleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;

    const template = await MessageTemplate.findById(id);

    if (!template) {
      return errorResponse(res, 'Template not found', 404);
    }

    template.isActive = false;
    applyTemplateMetadata(template, req.user?._id);
    await template.save();

    return successResponse(res, template, 'Template deactivated successfully');
  } catch (error) {
    console.error('Error deleting template:', error);
    return errorResponse(res, error.message || 'Failed to delete template', 500);
  }
};

