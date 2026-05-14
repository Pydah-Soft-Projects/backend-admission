import { getPool } from '../config-sql/database.js';
import fs from 'fs';
import { successResponse, errorResponse } from '../utils/response.util.js';
import whatsappService from '../services/whatsapp.service.js';
import { ensureLeadAndNumbers } from '../services/communicationSmsDispatch.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * WhatsApp Communication Controller
 */

export const sendWhatsAppCommunication = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { 
      templateName, 
      templateId, // Support both
      languageCode, 
      variables, 
      contactNumber, // Single
      contactNumbers, // Array (Frontend sends this)
      headerHandle 
    } = req.body;
    
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    const technicalTemplateName = templateId || templateName;

    if (!technicalTemplateName) {
      return errorResponse(res, 'Template name/ID is required', 400);
    }

    // Determine target numbers
    const targetNumbers = contactNumbers || (contactNumber ? [contactNumber] : []);
    if (!targetNumbers.length) {
      return errorResponse(res, 'At least one contact number is required', 400);
    }

    const { lead, validatedNumbers } = await ensureLeadAndNumbers(leadId, targetNumbers);

    // 0. Fetch template metadata
    const [templates] = await pool.execute(
      'SELECT id, name, dlt_template_id, language, header_type, header_handle, header_text, variable_count FROM message_templates WHERE (name = ? OR dlt_template_id = ?) AND category = "whatsapp" LIMIT 1',
      [technicalTemplateName, technicalTemplateName]
    );
    
    const template = templates[0];
    if (!template) {
      return errorResponse(res, 'Template not found', 404);
    }

    const headerConfig = {
      type: template.header_type || 'NONE',
      handle: headerHandle || template.header_handle || null,
      text: template.header_text || null
    };

    // Format variables once (Convert object to array if needed)
    const variablesArray = variables && typeof variables === 'object' 
      ? Object.keys(variables)
          .sort((a, b) => parseInt(a) - parseInt(b))
          .map(key => variables[key])
      : (Array.isArray(variables) ? variables : []);

    const components = whatsappService.formatVariables(variablesArray, headerConfig);
    const technicalName = template.dlt_template_id || template.name;
    const finalLanguageCode = languageCode || template.language || 'en';

    const results = [];
    for (const recipientNumber of validatedNumbers) {
      try {
        // 1. Send via Service
        const result = await whatsappService.sendTemplateMessage(
          recipientNumber,
          technicalName,
          finalLanguageCode,
          components
        );

        // 2. Log in Communications table (Aligned with system schema)
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
            lead.id || null,
            recipientNumber,
            'whatsapp',
            'outgoing',
            result.success ? 'success' : 'failed',
            userId || null,
            template.id || null,
            template.dlt_template_id || null,
            template.name || null,
            template.language || null,
            template.content || null, // template_original_content
            `WhatsApp Template: ${template.name}`, // template_rendered_content
            JSON.stringify(variables || {}),
            JSON.stringify([result.messageId].filter(Boolean)),
            JSON.stringify({ headerConfig, apiResponse: result.data || {} }),
          ]
        );

        // 3. Add Activity Log
        const activityLogId = uuidv4();
        const statusLabel = result.success ? 'sent' : 'failed';
        await pool.execute(
          `INSERT INTO activity_logs (id, lead_id, type, comment, performed_by, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            activityLogId,
            lead.id || null,
            'comment',
            `WhatsApp "${template.name}" ${statusLabel} to ${recipientNumber}`,
            userId || null,
            JSON.stringify({
              communicationType: 'whatsapp',
              templateId: template.id,
              templateName: template.name,
              number: recipientNumber,
              status: result.success ? 'success' : 'failed',
              messageId: result.messageId,
              communicationId
            }),
          ]
        );

        // 4. Update Lead follows
        await pool.execute('UPDATE leads SET last_follow_up = NOW(), updated_at = NOW() WHERE id = ?', [lead.id]);

        results.push({ number: recipientNumber, success: true, messageId: result.messageId });
      } catch (err) {
        console.error(`[WhatsApp Loop Error] Number: ${recipientNumber}`, err);
        results.push({ number: recipientNumber, success: false, error: err.message });
      }
    }

    const someSuccess = results.some(r => r.success);

    if (someSuccess) {
      return successResponse(res, { results }, 'WhatsApp dispatch process completed');
    } else {
      const firstError = results[0]?.error || 'Unknown error';
      return errorResponse(res, `Failed to send any WhatsApp messages: ${firstError}`, 500, { results });
    }

  } catch (error) {
    console.error('WhatsApp Controller Error:', error);
    return errorResponse(res, error.message || 'Failed to send WhatsApp message', 500);
  }
};

export const syncWhatsAppTemplates = async (req, res) => {
  try {
    const remoteTemplates = await whatsappService.fetchRemoteTemplates();
    const pool = getPool();
    const userId = req.user.id || req.user._id;
    let syncCount = 0;
    for (const remote of remoteTemplates) {
      if (remote.status !== 'APPROVED') continue;

      // Debug: Log components to see buttons
      console.log(`[WhatsApp Sync] Template: ${remote.name}`, JSON.stringify(remote.components, null, 2));

      // 1. Extract Body & Variables
      const bodyComponent = remote.components.find((c) => c.type === 'BODY');
      const buttonsComponent = remote.components.find((c) => c.type === 'BUTTONS');
      
      const content = bodyComponent?.text || '';
      let variableCount = (content.match(/\{\{([0-9]+)\}\}/g) || []).length;
      const normalizedContent = content.replace(/\{\{([0-9]+)\}\}/g, '{#var#}');

      // Check for dynamic buttons (URL variables)
      if (buttonsComponent) {
        buttonsComponent.buttons.forEach(btn => {
          if (btn.url) {
            const btnVars = (btn.url.match(/\{\{([0-9]+)\}\}/g) || []).length;
            variableCount += btnVars;
          }
        });
      }

      // 2. Extract Header (Text or Media)
      const headerComponent = remote.components.find((c) => c.type === 'HEADER');
      const headerType = headerComponent?.format || 'TEXT';
      let headerText = headerComponent?.text || null;
      let headerVariableCount = 0;

      if (headerType === 'TEXT' && headerText) {
        headerVariableCount = (headerText.match(/\{\{([0-9]+)\}\}/g) || []).length;
        headerText = headerText.replace(/\{\{([0-9]+)\}\}/g, '{#var#}');
      }
      
      variableCount += headerVariableCount;

      // Try to get a valid URL or handle for media
      let headerHandle = null;
      if (headerComponent?.example?.header_handle) {
        headerHandle = headerComponent.example.header_handle[0];
      } else if (headerComponent?.example?.header_url) {
        headerHandle = headerComponent.example.header_url[0];
      } else if (headerComponent?.example?.image) {
        headerHandle = headerComponent.example.image[0];
      } else if (headerComponent?.example?.video) {
        headerHandle = headerComponent.example.video[0];
      } else if (headerComponent?.example?.document) {
        headerHandle = headerComponent.example.document[0];
      }

      // 3. Media Filename Fallback
      if (headerType === 'DOCUMENT' && !headerText) {
        // Use template name as default filename, replacing underscores with spaces or camelCase
        headerText = remote.name.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('_');
      }

      // 4. Upsert into message_templates (Match by dlt_template_id for Smart Sync)
      const [existing] = await pool.execute(
        'SELECT id, name, description, header_handle, media_gallery FROM message_templates WHERE dlt_template_id = ? AND category = "whatsapp"',
        [remote.name]
      );

      if (existing.length > 0) {
        const t = existing[0];
        
        // Handle Media Gallery logic
        let gallery = [];
        try {
          gallery = typeof t.media_gallery === 'string' ? JSON.parse(t.media_gallery) : (t.media_gallery || []);
        } catch (e) { gallery = []; }
        
        // Add new handle to gallery if it's new and valid
        if (headerHandle && !gallery.includes(headerHandle)) {
          gallery.push(headerHandle);
        }

        await pool.execute(
          `UPDATE message_templates SET 
            category = 'whatsapp',
            content = ?, 
            variable_count = ?, 
            language = ?, 
            header_type = ?,
            header_text = COALESCE(header_text, ?),
            header_handle = COALESCE(header_handle, ?),
            media_gallery = ?,
            updated_at = NOW(),
            updated_by = ?
          WHERE id = ?`,
          [
            normalizedContent,
            variableCount,
            remote.language,
            headerType,
            headerText,
            headerHandle,
            JSON.stringify(gallery),
            userId,
            t.id,
          ]
        );
      } else {
        // New template: Store the first handle in both active and gallery
        const initialGallery = headerHandle ? [headerHandle] : [];
        await pool.execute(
          `INSERT INTO message_templates (
            id, name, category, dlt_template_id, language, content, variable_count, 
            header_type, header_text, header_handle, media_gallery,
            is_active, created_by, updated_by, created_at, updated_at
          ) VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NOW(), NOW())`,
          [
            uuidv4(),
            remote.name, // Use technical name as initial friendly name
            remote.name,
            remote.language,
            normalizedContent,
            variableCount,
            headerType,
            headerText,
            headerHandle,
            JSON.stringify(initialGallery),
            userId,
            userId,
          ]
        );
      }
      syncCount++;
    }

    return successResponse(res, { syncCount }, `Successfully synced ${syncCount} templates from WhatsApp`);
  } catch (error) {
    console.error('WhatsApp Sync Error:', error);
    return errorResponse(res, error.message || 'Failed to sync WhatsApp templates', 500);
  }
};
export const uploadWhatsAppMedia = async (req, res) => {
  try {
    if (!req.file) {
      return errorResponse(res, 'No file uploaded', 400);
    }

    const { type } = req.body;
    const result = await whatsappService.uploadMedia(req.file.path, type);

    // Clean up local temp file
    try {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (e) {
      console.error('Failed to delete temp file:', e.message);
    }

    return successResponse(res, { id: result.id }, 'Media uploaded to WhatsApp successfully');
  } catch (error) {
    console.error('WhatsApp Upload Controller Error:', error.response?.data || error.message || error);
    return errorResponse(res, error.message || 'Failed to upload media', 500);
  }
};
