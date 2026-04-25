import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config-sql/database.js';
import { sendSmsThroughBulkSmsApps } from './bulkSms.service.js';

const sanitizeNumber = (number) => String(number || '').replace(/[^\d+]/g, '');

const collectLeadContactNumbers = (lead) => {
  const numbers = new Set();
  if (!lead) {
    return numbers;
  }
  [lead.phone, lead.father_phone].forEach((num) => {
    const sanitized = sanitizeNumber(num);
    if (sanitized) {
      numbers.add(sanitized);
    }
  });
  const dynamicFields = typeof lead.dynamic_fields === 'string' ? JSON.parse(lead.dynamic_fields) : lead.dynamic_fields || {};
  if (dynamicFields && typeof dynamicFields === 'object') {
    Object.values(dynamicFields).forEach((value) => {
      if (typeof value === 'string' || typeof value === 'number') {
        const sanitized = sanitizeNumber(value);
        if (sanitized.length >= 10) {
          numbers.add(sanitized);
        }
      }
    });
  }
  return numbers;
};

const formatTemplateRow = (template) => ({
  _id: template.id,
  id: template.id,
  name: template.name,
  dltTemplateId: template.dlt_template_id,
  language: template.language,
  content: template.content,
  isUnicode: template.is_unicode === 1 || template.is_unicode === true,
  variableCount: template.variable_count || 0,
  variables: typeof template.variables === 'string' ? JSON.parse(template.variables) : template.variables || [],
  isActive: template.is_active === 1 || template.is_active === true,
});

export const findTemplate = async (templateId, { activeOnly = true } = {}) => {
  if (!templateId) {
    throw new Error('Template ID is required');
  }
  const pool = getPool();
  const [templates] = activeOnly
    ? await pool.execute('SELECT * FROM message_templates WHERE id = ? AND is_active = ?', [templateId, true])
    : await pool.execute('SELECT * FROM message_templates WHERE id = ?', [templateId]);
  if (templates.length === 0) {
    throw new Error(activeOnly ? 'Template not found or inactive' : 'Template not found');
  }
  return formatTemplateRow(templates[0]);
};

export const renderTemplateContent = (template, variables = []) => {
  const placeholders = template.variableCount || 0;
  const variablesByKey = new Map();
  variables.forEach((variable, index) => {
    if (!variable) return;
    const templateVar = template.variables?.[index];
    const key = variable.key?.trim() || templateVar?.key || `var${index + 1}`;
    if (!key) return;
    const value =
      variable.value !== undefined && variable.value !== null
        ? String(variable.value)
        : variable.defaultValue !== undefined && variable.defaultValue !== null
          ? String(variable.defaultValue)
          : undefined;
    if (value !== undefined) {
      variablesByKey.set(key, value);
    }
  });
  const normalizedValues = Array.from({ length: placeholders }).map((_, index) => {
    const templateVar = template.variables?.[index];
    const key = templateVar?.key || `var${index + 1}`;
    if (variablesByKey.has(key)) {
      return variablesByKey.get(key);
    }
    if (variables[index]?.value !== undefined && variables[index]?.value !== null) {
      return String(variables[index].value);
    }
    if (templateVar?.defaultValue) {
      return templateVar.defaultValue;
    }
    return '';
  });
  let placeholderIndex = 0;
  const rendered = template.content.replace(/\{#var#\}/gi, () => {
    const value = normalizedValues[placeholderIndex] ?? '';
    placeholderIndex += 1;
    return value;
  });
  const mappedVariables =
    template.variables?.map((variable, index) => ({
      key: variable.key || `var${index + 1}`,
      label: variable.label || `Variable ${index + 1}`,
      defaultValue: variable.defaultValue || '',
      value: normalizedValues[index] ?? '',
    })) || [];
  return { rendered, mappedVariables };
};

export const ensureLeadAndNumbers = async (leadId, contactNumbers = []) => {
  if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
    throw new Error('Invalid lead ID');
  }
  const pool = getPool();
  const [leads] = await pool.execute('SELECT * FROM leads WHERE id = ?', [leadId]);
  if (leads.length === 0) {
    throw new Error('Lead not found');
  }
  const lead = leads[0];
  const knownNumbers = collectLeadContactNumbers(lead);
  const validatedNumbers = (Array.isArray(contactNumbers) ? contactNumbers : [contactNumbers])
    .map(sanitizeNumber)
    .filter(Boolean);
  if (validatedNumbers.length === 0) {
    throw new Error('At least one valid contact number is required');
  }
  const invalidNumbers = validatedNumbers.filter((num) => !knownNumbers.has(num));
  if (invalidNumbers.length > 0) {
    throw new Error(`Number(s) ${invalidNumbers.join(', ')} are not associated with this lead.`);
  }
  return { lead, validatedNumbers };
};

/**
 * Same behaviour as sendSms communication handler (templates + API + DB + activity logs). Used by lead SMS and bulk job processor.
 * @param {import('mysql2/promise').Pool} pool
 */
export async function executeSmsSendForLead(pool, userId, leadId, contactNumbers, templates) {
  if (!Array.isArray(templates) || templates.length === 0) {
    throw new Error('At least one template is required');
  }

  const { lead, validatedNumbers } = await ensureLeadAndNumbers(leadId, contactNumbers);
  const results = [];
  const savedCommunicationIds = [];
  const templateCommunicationMeta = [];

  for (const entry of templates) {
    const templateId = entry?.templateId || entry?._id;
    const userVariables = Array.isArray(entry?.variables) ? entry.variables : [];
    let template;
    try {
      template = await findTemplate(templateId);
    } catch (templateError) {
      results.push({ templateId, success: false, error: templateError.message });
      continue;
    }
    const { rendered, mappedVariables } = renderTemplateContent(template, userVariables);
    let apiResponse;
    let status = 'success';
    let errorMessage = null;
    const unresolvedPlaceholders = /\{#var#\}/i.test(rendered);
    if (unresolvedPlaceholders) {
      console.warn('[executeSmsSendForLead] Unresolved placeholders', { templateId: template.id, leadId });
    }
    const dltTempId = String(template.dltTemplateId || '').trim();
    const isUnicodeSms = template.isUnicode || template.language !== 'en';
    if (isUnicodeSms && !dltTempId) {
      console.warn('[executeSmsSendForLead] Unicode without DLT id', { templateId: template.id });
    }
    try {
      apiResponse = await sendSmsThroughBulkSmsApps({
        numbers: validatedNumbers,
        message: rendered,
        isUnicode: isUnicodeSms,
        tempid: dltTempId || undefined,
      });
      status = apiResponse.success ? 'success' : 'failed';
    } catch (providerError) {
      status = 'failed';
      errorMessage = providerError.message;
      apiResponse = {
        success: false,
        messageIds: [],
        responseText: providerError.response?.data || providerError.message,
        numbers: validatedNumbers,
        durationMs: 0,
      };
    }
    const createdAt = new Date();
    const startIndex = savedCommunicationIds.length;
    for (const number of validatedNumbers) {
      const communicationId = uuidv4();
      await pool.execute(
        `INSERT INTO communications (
          id, lead_id, contact_number, type, direction, status, sent_by, sent_at,
          template_id, template_dlt_template_id, template_name, template_language,
          template_original_content, template_rendered_content, template_variables,
          provider_message_ids, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          communicationId,
          lead.id,
          number,
          'sms',
          'outgoing',
          status,
          userId,
          template.id,
          template.dltTemplateId,
          template.name,
          template.language,
          template.content,
          rendered,
          JSON.stringify(mappedVariables),
          JSON.stringify(
            Array.isArray(apiResponse?.messageIds) && apiResponse.messageIds.length > 0 ? [apiResponse.messageIds[0]] : []
          ),
          JSON.stringify({
            apiResponseText: apiResponse?.responseText,
            durationMs: apiResponse?.durationMs,
            error: errorMessage,
          }),
        ]
      );
      savedCommunicationIds.push(communicationId);
    }
    templateCommunicationMeta.push({
      template,
      status,
      errorMessage,
      apiResponse,
      numbers: validatedNumbers,
      startIndex,
      endIndex: savedCommunicationIds.length,
      createdAt,
    });
    results.push({
      templateId: template.id,
      templateName: template.name,
      success: status === 'success',
      messageId: Array.isArray(apiResponse?.messageIds) && apiResponse.messageIds.length > 0 ? apiResponse.messageIds[0] : undefined,
      responseText: apiResponse?.responseText,
      error: errorMessage,
    });
  }

  if (savedCommunicationIds.length > 0) {
    await pool.execute('UPDATE leads SET last_follow_up = NOW(), updated_at = NOW() WHERE id = ?', [lead.id]);
    for (const meta of templateCommunicationMeta) {
      const communicationsForTemplate = savedCommunicationIds.slice(meta.startIndex, meta.endIndex);
      const numbersList = meta.numbers.join(', ');
      const statusLabel = meta.status === 'success' ? 'sent' : 'failed';
      const comment = `SMS "${meta.template.name}" ${statusLabel} to ${numbersList}`;
      const activityLogId = uuidv4();
      await pool.execute(
        `INSERT INTO activity_logs (id, lead_id, type, comment, performed_by, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          activityLogId,
          lead.id,
          'comment',
          comment,
          userId,
          JSON.stringify({
            communicationType: 'sms',
            templateId: meta.template.id,
            templateName: meta.template.name,
            templateLanguage: meta.template.language,
            numbers: meta.numbers,
            status: meta.status,
            messageIds: meta.apiResponse?.messageIds || [],
            error: meta.errorMessage,
            communicationIds: communicationsForTemplate,
          }),
        ]
      );
    }
  }

  return {
    lead,
    results,
    savedCommunicationIds,
    templateCommunicationMeta,
  };
}
