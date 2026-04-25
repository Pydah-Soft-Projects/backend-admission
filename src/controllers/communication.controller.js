import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { resolveLeadStatus } from '../utils/leadChannelStatus.util.js';
import { sendSmsThroughBulkSmsApps } from '../services/bulkSms.service.js';
import {
  ensureLeadAndNumbers,
  executeSmsSendForLead,
  findTemplate,
  renderTemplateContent,
} from '../services/communicationSmsDispatch.js';
import { v4 as uuidv4 } from 'uuid';

export const logCallCommunication = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { contactNumber, remarks, outcome, durationSeconds } = req.body;
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    if (req.user.roleName === 'PRO') {
      return errorResponse(res, 'Call logging is not available for PRO users', 403);
    }

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

    if (req.user.roleName === 'Student Counselor' && outcome?.trim()) {
      const oc = String(outcome).trim();
      const [stRows] = await pool.execute(
        'SELECT lead_status, call_status, visit_status, assigned_to_pro FROM leads WHERE id = ?',
        [lead.id]
      );
      const st = stRows[0] || {};
      const nextLead = resolveLeadStatus(st.lead_status || 'New', oc, st.visit_status ?? null);
      const visitSql = st.assigned_to_pro ? ', visit_status = ?' : '';
      const visitParams = st.assigned_to_pro ? [oc, nextLead, 'Assigned', lead.id] : [oc, nextLead, lead.id];
      await pool.execute(
        `UPDATE leads SET last_follow_up = NOW(), updated_at = NOW(), call_status = ?, lead_status = ?${visitSql} WHERE id = ?`,
        visitParams
      );
    } else {
      await pool.execute(
        'UPDATE leads SET last_follow_up = NOW(), updated_at = NOW() WHERE id = ?',
        [lead.id]
      );
    }

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

    if (req.user.roleName === 'PRO') {
      return errorResponse(res, 'SMS is not available for PRO users', 403);
    }

    if (!Array.isArray(templates) || templates.length === 0) {
      return errorResponse(res, 'At least one template is required', 400);
    }

    const { results, savedCommunicationIds } = await executeSmsSendForLead(
      pool,
      userId,
      leadId,
      contactNumbers,
      templates
    );

    // Fetch created communications
    if (savedCommunicationIds.length === 0) {
      return successResponse(res, { results, communications: [] }, 'SMS dispatch processed');
    }
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

    if (req.user.roleName === 'PRO') {
      return successResponse(res, {
        items: [],
        pagination: { page, limit, total: 0, pages: 0 },
      });
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

    if (req.user.roleName === 'PRO') {
      return successResponse(res, { stats: [] });
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

/**
 * Super Admin: send one rendered template to any mobile number (provider only).
 * Does not create a `communications` row or require a lead (lead_id is NOT NULL in DB).
 */
export const sendTestTemplateSms = async (req, res) => {
  try {
    const { id: templateId } = req.params;
    const { phone, variables: bodyVariables } = req.body || {};

    if (req.user.roleName === 'PRO') {
      return errorResponse(res, 'SMS is not available for PRO users', 403);
    }

    const raw = String(phone || '').trim();
    if (!raw) {
      return errorResponse(res, 'Phone number is required', 400);
    }

    const digitsOnly = raw.replace(/\D/g, '');
    if (digitsOnly.length < 10) {
      return errorResponse(res, 'Enter a valid mobile number (at least 10 digits)', 400);
    }

    const userVariables = Array.isArray(bodyVariables) ? bodyVariables : [];

    let template;
    try {
      template = await findTemplate(templateId, { activeOnly: false });
    } catch (e) {
      return errorResponse(res, e.message || 'Template not found', 404);
    }

    const { rendered } = renderTemplateContent(template, userVariables);
    const unresolvedPlaceholders = /\{#var#\}/i.test(rendered);
    if (unresolvedPlaceholders) {
      return errorResponse(
        res,
        'Message still contains unresolved {#var#} placeholders. Fill every variable value before testing.',
        400
      );
    }

    const dltTempId = String(template.dltTemplateId || '').trim();
    const isUnicodeSms = template.isUnicode || template.language !== 'en';
    if (isUnicodeSms && !dltTempId) {
      console.warn('[Communications][Test SMS] Unicode/non-English without DLT template id — delivery may fail.', {
        templateId: template.id,
      });
    }

    let apiResponse;
    try {
      apiResponse = await sendSmsThroughBulkSmsApps({
        numbers: [raw],
        message: rendered,
        isUnicode: isUnicodeSms,
        tempid: dltTempId || undefined,
      });
    } catch (providerError) {
      console.error('[Communications][Test SMS] Provider error', {
        templateId: template.id,
        error: providerError?.message,
      });
      return errorResponse(res, providerError.message || 'Failed to send test SMS', 502);
    }

    const success = apiResponse.success === true;
    return successResponse(
      res,
      {
        success,
        messageId:
          Array.isArray(apiResponse?.messageIds) && apiResponse.messageIds.length > 0
            ? apiResponse.messageIds[0]
            : undefined,
        responseText: apiResponse.responseText,
        renderedPreview: rendered.slice(0, 500),
      },
      success ? 'Test SMS submitted successfully' : 'Provider did not confirm success — see response details',
      200
    );
  } catch (error) {
    console.error('Error sending test template SMS:', error);
    return errorResponse(res, error.message || 'Failed to send test SMS', 500);
  }
};
