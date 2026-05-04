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
    const { templateName, languageCode, variables, contactNumber } = req.body;
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    if (!templateName) {
      return errorResponse(res, 'Template name is required', 400);
    }

    const { lead, validatedNumbers } = await ensureLeadAndNumbers(leadId, [contactNumber]);
    const recipientNumber = validatedNumbers[0];

    // Format variables for WhatsApp API
    const components = whatsappService.formatVariables(variables);

    // 1. Send via Service
    const result = await whatsappService.sendTemplateMessage(
      recipientNumber,
      templateName,
      languageCode || 'en_US',
      components
    );

    // 2. Log in Communications table
    const communicationId = uuidv4();
    await pool.execute(
      `INSERT INTO communications (
        id, lead_id, contact_number, type, direction, 
        template_name, template_rendered_content, template_variables,
        sent_by, sent_at, status, provider_message_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, NOW(), NOW())`,
      [
        communicationId,
        lead.id,
        recipientNumber,
        'whatsapp',
        'outgoing',
        templateName,
        `WhatsApp Template: ${templateName}`, // Simplified content for log
        JSON.stringify(variables),
        userId,
        result.success ? 'success' : 'failed',
        JSON.stringify([result.messageId]),
      ]
    );

    return successResponse(res, { 
      communicationId, 
      messageId: result.messageId 
    }, 'WhatsApp message sent successfully');

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

      // 3. Upsert into message_templates
      const [existing] = await pool.execute(
        'SELECT id FROM message_templates WHERE name = ? AND category = "whatsapp"',
        [remote.name]
      );

      if (existing.length > 0) {
        await pool.execute(
          `UPDATE message_templates SET 
            category = 'whatsapp',
            dlt_template_id = ?,
            content = ?, 
            variable_count = ?, 
            language = ?, 
            header_type = ?,
            header_text = ?,
            header_handle = ?,
            updated_at = NOW(),
            updated_by = ?
          WHERE id = ?`,
          [
            remote.name,
            normalizedContent,
            variableCount,
            remote.language,
            headerType,
            headerText,
            headerHandle,
            userId,
            existing[0].id,
          ]
        );
      } else {
        await pool.execute(
          `INSERT INTO message_templates (
            id, name, category, dlt_template_id, language, content, variable_count, 
            header_type, header_text, header_handle,
            is_active, created_by, updated_by, created_at, updated_at
          ) VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NOW(), NOW())`,
          [
            uuidv4(),
            remote.name,
            remote.name,
            remote.language,
            normalizedContent,
            variableCount,
            headerType,
            headerText,
            headerHandle,
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
