import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { sendSmsThroughBulkSmsApps } from '../services/bulkSms.service.js';
import { v4 as uuidv4 } from 'uuid';

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

  const dynamicFields = typeof lead.dynamic_fields === 'string' 
    ? JSON.parse(lead.dynamic_fields) 
    : lead.dynamic_fields || {};
    
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

const findTemplate = async (templateId) => {
  if (!templateId) {
    throw new Error('Template ID is required');
  }

  const pool = getPool();
  const [templates] = await pool.execute(
    'SELECT * FROM message_templates WHERE id = ? AND is_active = ?',
    [templateId, true]
  );

  if (templates.length === 0) {
    throw new Error('Template not found or inactive');
  }

  const template = templates[0];
  return {
    _id: template.id,
    id: template.id,
    name: template.name,
    dltTemplateId: template.dlt_template_id,
    language: template.language,
    content: template.content,
    isUnicode: template.is_unicode === 1 || template.is_unicode === true,
    variableCount: template.variable_count || 0,
    variables: typeof template.variables === 'string' 
      ? JSON.parse(template.variables) 
      : template.variables || [],
    isActive: template.is_active === 1 || template.is_active === true,
  };
};

const renderTemplateContent = (template, variables = []) => {
  const placeholders = template.variableCount || 0;

  const variablesByKey = new Map();

  variables.forEach((variable, index) => {
    if (!variable) return;
    const templateVar = template.variables?.[index];
    const key =
      variable.key?.trim() ||
      templateVar?.key ||
      `var${index + 1}`;
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

  return {
    rendered,
    mappedVariables,
  };
};

const ensureLeadAndNumbers = async (leadId, contactNumbers = []) => {
  if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
    throw new Error('Invalid lead ID');
  }

  const pool = getPool();
  const [leads] = await pool.execute(
    'SELECT * FROM leads WHERE id = ?',
    [leadId]
  );

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
    throw new Error(
      `Number(s) ${invalidNumbers.join(', ')} are not associated with this lead.`
    );
  }

  return {
    lead,
    validatedNumbers,
  };
};

export const logCallCommunication = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { contactNumber, remarks, outcome, durationSeconds } = req.body;
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    const { lead, validatedNumbers } = await ensureLeadAndNumbers(leadId, [contactNumber]);

    const sanitizedNumber = validatedNumbers[0];

    // Create communication record
    const communicationId = uuidv4();
    await pool.execute(
      `INSERT INTO communications (
        id, lead_id, contact_number, type, direction, remarks, call_outcome, duration_seconds,
        sent_by, sent_at, status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, NOW(), NOW())`,
      [
        communicationId,
        lead.id,
        sanitizedNumber,
        'call',
        'outgoing',
        remarks?.trim() || null,
        outcome?.trim() || null,
        durationSeconds ? Number(durationSeconds) : null,
        userId,
        'success',
        JSON.stringify({ source: 'click_to_call' }),
      ]
    );

    // Update lead's last follow up
    await pool.execute(
      'UPDATE leads SET last_follow_up = NOW(), updated_at = NOW() WHERE id = ?',
      [lead.id]
    );

    // Fetch created communication
    const [communications] = await pool.execute(
      `SELECT c.*, u.id as sent_by_id, u.name as sent_by_name, u.email as sent_by_email, u.role_name as sent_by_role_name
       FROM communications c
       LEFT JOIN users u ON c.sent_by = u.id
       WHERE c.id = ?`,
      [communicationId]
    );

    const comm = communications[0];
    const communication = {
      id: comm.id,
      _id: comm.id,
      leadId: comm.lead_id,
      contactNumber: comm.contact_number,
      type: comm.type,
      direction: comm.direction,
      remarks: comm.remarks,
      callOutcome: comm.call_outcome,
      durationSeconds: comm.duration_seconds,
      sentBy: comm.sent_by_id ? {
        id: comm.sent_by_id,
        _id: comm.sent_by_id,
        name: comm.sent_by_name,
        email: comm.sent_by_email,
        roleName: comm.sent_by_role_name,
      } : comm.sent_by,
      sentAt: comm.sent_at,
      status: comm.status,
      metadata: typeof comm.metadata === 'string' 
        ? JSON.parse(comm.metadata) 
        : comm.metadata || {},
      createdAt: comm.created_at,
      updatedAt: comm.updated_at,
    };

    // Note: We don't create an ActivityLog comment here because call logs
    // are already displayed in the Call History section, avoiding duplication

    return successResponse(res, communication, 'Call logged successfully', 201);
  } catch (error) {
    console.error('Error logging call communication:', error);
    return errorResponse(res, error.message || 'Failed to log call', 500);
  }
};

export const sendSmsCommunication = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { templates, contactNumbers } = req.body;
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    if (!Array.isArray(templates) || templates.length === 0) {
      return errorResponse(res, 'At least one template is required', 400);
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
        results.push({
          templateId,
          success: false,
          error: templateError.message,
        });
        continue;
      }

      const { rendered, mappedVariables } = renderTemplateContent(template, userVariables);

      let apiResponse;
      let status = 'success';
      let errorMessage = null;

      const messagePreview = rendered.slice(0, 500);
      const unresolvedPlaceholders = /\{#var#\}/i.test(rendered);

      console.info('[Communications][SMS] Prepared payload', {
        leadId: lead.id,
        templateId: template.id,
        templateName: template.name,
        language: template.language,
        recipientCount: validatedNumbers.length,
        numbersPreview: validatedNumbers.slice(0, 5),
        variables: mappedVariables.map((variable) => ({
          key: variable.key,
          value: variable.value,
        })),
        messagePreview,
        hasUnresolvedPlaceholders: unresolvedPlaceholders,
      });

      if (unresolvedPlaceholders) {
        console.warn('[Communications][SMS] Template contains unresolved placeholders', {
          templateId: template.id,
          templateName: template.name,
          messagePreview,
        });
      }

      try {
        apiResponse = await sendSmsThroughBulkSmsApps({
          numbers: validatedNumbers,
          message: rendered,
          isUnicode: template.isUnicode || template.language !== 'en',
        });
        status = apiResponse.success ? 'success' : 'failed';
        const primaryMessageId = Array.isArray(apiResponse.messageIds)
          ? apiResponse.messageIds[0]
          : undefined;
        console.info('[Communications][SMS] Provider response', {
          templateId: template.id,
          success: apiResponse.success,
          messageId: primaryMessageId,
          transport: apiResponse.transport,
          durationMs: apiResponse.durationMs,
          responseSnippet: apiResponse.responseText?.slice(0, 500),
        });
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
        console.error('[Communications][SMS] Provider error', {
          templateId: template.id,
          error: providerError?.message,
          responseText:
            providerError?.response?.data && typeof providerError.response.data === 'string'
              ? providerError.response.data.slice(0, 500)
              : providerError?.response?.data,
        });
      }

      const createdAt = new Date();
      const startIndex = savedCommunicationIds.length;

      // Create communication records for each number
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
              Array.isArray(apiResponse?.messageIds) && apiResponse.messageIds.length > 0
                ? [apiResponse.messageIds[0]]
                : []
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
        messageId:
          Array.isArray(apiResponse?.messageIds) && apiResponse.messageIds.length > 0
            ? apiResponse.messageIds[0]
            : undefined,
        responseText: apiResponse?.responseText,
        error: errorMessage,
      });
    }

    // Update lead's last follow up
    if (savedCommunicationIds.length > 0) {
      await pool.execute(
        'UPDATE leads SET last_follow_up = NOW(), updated_at = NOW() WHERE id = ?',
        [lead.id]
      );

      // Create activity logs
      for (const meta of templateCommunicationMeta) {
        const communicationsForTemplate = savedCommunicationIds.slice(meta.startIndex, meta.endIndex);
        const numbersList = meta.numbers.join(', ');
        const statusLabel = meta.status === 'success' ? 'sent' : 'failed';
        const comment = `SMS "${meta.template.name}" ${statusLabel} to ${numbersList}`;

        const activityLogId = uuidv4();
        await pool.execute(
          `INSERT INTO activity_logs (
            id, lead_id, type, comment, performed_by, metadata, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
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

    // Fetch created communications
    const placeholders = savedCommunicationIds.map(() => '?').join(',');
    const [communications] = await pool.execute(
      `SELECT c.*, u.id as sent_by_id, u.name as sent_by_name, u.email as sent_by_email, u.role_name as sent_by_role_name
       FROM communications c
       LEFT JOIN users u ON c.sent_by = u.id
       WHERE c.id IN (${placeholders})
       ORDER BY c.sent_at DESC`,
      savedCommunicationIds
    );

    const formattedCommunications = communications.map(comm => ({
      id: comm.id,
      _id: comm.id,
      leadId: comm.lead_id,
      contactNumber: comm.contact_number,
      type: comm.type,
      direction: comm.direction,
      status: comm.status,
      remarks: comm.remarks,
      callOutcome: comm.call_outcome,
      durationSeconds: comm.duration_seconds,
      template: comm.template_id ? {
        templateId: comm.template_id,
        dltTemplateId: comm.template_dlt_template_id,
        name: comm.template_name,
        language: comm.template_language,
        originalContent: comm.template_original_content,
        renderedContent: comm.template_rendered_content,
        variables: typeof comm.template_variables === 'string' 
          ? JSON.parse(comm.template_variables) 
          : comm.template_variables || [],
      } : null,
      providerMessageIds: typeof comm.provider_message_ids === 'string'
        ? JSON.parse(comm.provider_message_ids)
        : comm.provider_message_ids || [],
      metadata: typeof comm.metadata === 'string' 
        ? JSON.parse(comm.metadata) 
        : comm.metadata || {},
      sentBy: comm.sent_by_id ? {
        id: comm.sent_by_id,
        _id: comm.sent_by_id,
        name: comm.sent_by_name,
        email: comm.sent_by_email,
        roleName: comm.sent_by_role_name,
      } : comm.sent_by,
      sentAt: comm.sent_at,
      createdAt: comm.created_at,
      updatedAt: comm.updated_at,
    }));

    return successResponse(
      res,
      {
        results,
        communications: formattedCommunications,
      },
      'SMS dispatch processed'
    );
  } catch (error) {
    console.error('Error sending SMS:', error);
    return errorResponse(res, error.message || 'Failed to send SMS', 500);
  }
};

export const getLeadCommunications = async (req, res) => {
  try {
    const { leadId } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    const type = req.query.type;
    const pool = getPool();

    if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
      return errorResponse(res, 'Invalid lead ID', 400);
    }

    // Build WHERE conditions with table alias for JOIN query
    const conditions = ['c.lead_id = ?'];
    const params = [leadId];

    if (type && ['call', 'sms'].includes(type)) {
      conditions.push('c.type = ?');
      params.push(type);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const offset = (page - 1) * limit;

    // Get total count (no alias needed for simple count query)
    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM communications WHERE lead_id = ?${type && ['call', 'sms'].includes(type) ? ' AND type = ?' : ''}`,
      type && ['call', 'sms'].includes(type) ? [leadId, type] : [leadId]
    );
    const total = countResult[0].total;

    // Get communications
    // Note: Using string interpolation for LIMIT/OFFSET as mysql2 has issues with placeholders for these
    const [items] = await pool.execute(
      `SELECT c.*, u.id as sent_by_id, u.name as sent_by_name, u.email as sent_by_email, u.role_name as sent_by_role_name
       FROM communications c
       LEFT JOIN users u ON c.sent_by = u.id
       ${whereClause}
       ORDER BY c.sent_at DESC
       LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      params
    );

    const formattedItems = items.map(comm => ({
      id: comm.id,
      _id: comm.id,
      leadId: comm.lead_id,
      contactNumber: comm.contact_number,
      type: comm.type,
      direction: comm.direction,
      status: comm.status,
      remarks: comm.remarks,
      callOutcome: comm.call_outcome,
      durationSeconds: comm.duration_seconds,
      template: comm.template_id ? {
        templateId: comm.template_id,
        dltTemplateId: comm.template_dlt_template_id,
        name: comm.template_name,
        language: comm.template_language,
        originalContent: comm.template_original_content,
        renderedContent: comm.template_rendered_content,
        variables: typeof comm.template_variables === 'string' 
          ? JSON.parse(comm.template_variables) 
          : comm.template_variables || [],
      } : null,
      providerMessageIds: typeof comm.provider_message_ids === 'string'
        ? JSON.parse(comm.provider_message_ids)
        : comm.provider_message_ids || [],
      metadata: typeof comm.metadata === 'string' 
        ? JSON.parse(comm.metadata) 
        : comm.metadata || {},
      sentBy: comm.sent_by_id ? {
        id: comm.sent_by_id,
        _id: comm.sent_by_id,
        name: comm.sent_by_name,
        email: comm.sent_by_email,
        roleName: comm.sent_by_role_name,
      } : comm.sent_by,
      sentAt: comm.sent_at,
      createdAt: comm.created_at,
      updatedAt: comm.updated_at,
    }));

    return successResponse(res, {
      items: formattedItems,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching lead communications:', error);
    return errorResponse(res, error.message || 'Failed to fetch communications', 500);
  }
};

export const getLeadCommunicationStats = async (req, res) => {
  try {
    const { leadId } = req.params;
    const pool = getPool();

    if (!leadId || typeof leadId !== 'string' || leadId.length !== 36) {
      return errorResponse(res, 'Invalid lead ID', 400);
    }

    // Get aggregated stats by contact number
    const [aggregation] = await pool.execute(
      `SELECT 
        contact_number,
        SUM(CASE WHEN type = 'call' THEN 1 ELSE 0 END) as call_count,
        SUM(CASE WHEN type = 'sms' THEN 1 ELSE 0 END) as sms_count,
        MAX(sent_at) as last_contacted_at,
        MAX(CASE WHEN type = 'call' THEN sent_at ELSE NULL END) as last_call_at,
        MAX(CASE WHEN type = 'sms' THEN sent_at ELSE NULL END) as last_sms_at
       FROM communications
       WHERE lead_id = ?
       GROUP BY contact_number
       ORDER BY last_contacted_at DESC`,
      [leadId]
    );

    // Get template usage for each contact number
    const [templateData] = await pool.execute(
      `SELECT 
        contact_number,
        template_id,
        template_name,
        sent_at,
        status
       FROM communications
       WHERE lead_id = ? AND type = 'sms' AND template_id IS NOT NULL
       ORDER BY sent_at DESC`,
      [leadId]
    );

    // Group template data by contact number
    const templateMap = new Map();
    templateData.forEach((row) => {
      const key = row.contact_number;
      if (!templateMap.has(key)) {
        templateMap.set(key, []);
      }
      templateMap.get(key).push({
        templateId: row.template_id,
        templateName: row.template_name,
        sentAt: row.sent_at,
        status: row.status,
      });
    });

    const stats = aggregation.map((item) => {
      const templateUsageMap = new Map();
      const templates = templateMap.get(item.contact_number) || [];

      templates
        .filter((tmpl) => tmpl.templateId)
        .forEach((tmpl) => {
          const key = tmpl.templateId;
          if (!templateUsageMap.has(key)) {
            templateUsageMap.set(key, {
              templateId: tmpl.templateId,
              templateName: tmpl.templateName,
              count: 0,
            });
          }
          const entry = templateUsageMap.get(key);
          entry.count += 1;
        });

      return {
        contactNumber: item.contact_number,
        callCount: item.call_count || 0,
        smsCount: item.sms_count || 0,
        lastContactedAt: item.last_contacted_at,
        lastCallAt: item.last_call_at,
        lastSmsAt: item.last_sms_at,
        templateUsage: Array.from(templateUsageMap.values()),
      };
    });

    return successResponse(res, {
      stats,
    });
  } catch (error) {
    console.error('Error fetching communication stats:', error);
    return errorResponse(res, error.message || 'Failed to fetch communication stats', 500);
  }
};

