import { getPool } from '../config-sql/database.js';
import fs from 'fs';
import { successResponse, errorResponse } from '../utils/response.util.js';
import whatsappService from '../services/whatsapp.service.js';
import { ensureLeadAndNumbers } from '../services/communicationSmsDispatch.js';
import { v4 as uuidv4 } from 'uuid';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';

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

export const verifyWhatsAppContact = async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return errorResponse(res, 'Phone number is required', 400);
    }

    const cleanPhone = phone.replace(/\D/g, '').slice(-10); // Match last 10 digits
    const pool = getPool();

    // Check if we have any successful WhatsApp communication records for this number
    const [rows] = await pool.execute(
      `SELECT id FROM communications 
       WHERE contact_number LIKE ? AND type = 'whatsapp' AND status IN ('success', 'accepted') 
       LIMIT 1`,
      [`%${cleanPhone}`]
    );

    return successResponse(res, {
      success: true,
      status: rows.length > 0 ? 'valid' : 'unknown',
      source: 'local_history'
    }, 'WhatsApp contact status checked against history');
  } catch (error) {
    console.error('Verify WhatsApp Contact Error:', error);
    return errorResponse(res, error.message || 'Failed to verify contact', 500);
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
    console.error('Sync WhatsApp Templates Error:', error);
    return errorResponse(res, error.message || 'Failed to sync templates', 500);
  }
};

/**
 * Webhook Verification (GET)
 */
export const verifyWhatsAppWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'pydah_whatsapp_token';

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('[WhatsApp Webhook] Verified');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
};

/**
 * Webhook Reception (POST)
 */
export const receiveWhatsAppWebhook = async (req, res) => {
  try {
    const { body } = req;
    console.log('[WhatsApp Webhook Received]', JSON.stringify(body, null, 2));

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      if (messages && messages[0]) {
        const msg = messages[0];
        const from = msg.from; // Phone number
        const msgId = msg.id;
        const timestamp = msg.timestamp;
        const type = msg.type;
        
        let content = '';
        let mediaId = null;

        if (type === 'text') {
          content = msg.text.body;
        } else if (type === 'image') {
          content = msg.image.caption || 'Image';
          mediaId = msg.image.id;
        } else if (type === 'video') {
          content = msg.video.caption || 'Video';
          mediaId = msg.video.id;
        } else if (type === 'document') {
          content = msg.document.filename || 'Document';
          mediaId = msg.document.id;
        } else if (type === 'button') {
          content = msg.button.text;
        } else if (type === 'interactive') {
          if (msg.interactive.type === 'button_reply') {
            content = msg.interactive.button_reply.title;
          } else if (msg.interactive.type === 'list_reply') {
            content = msg.interactive.list_reply.title;
          }
        }

        const pool = getPool();

        // 1. Find the lead by phone number (last 10 digits)
        const cleanFrom = from.replace(/\D/g, '').slice(-10);
        const [leads] = await pool.execute(
          'SELECT id, name FROM leads WHERE phone LIKE ? OR alternate_mobile LIKE ? OR father_phone LIKE ? LIMIT 1',
          [`%${cleanFrom}`, `%${cleanFrom}`, `%${cleanFrom}`]
        );
        const lead = leads[0];

        // 2. Find or create conversation
        let [conversations] = await pool.execute(
          'SELECT id FROM whatsapp_conversations WHERE contact_number = ?',
          [from]
        );

        let conversationId;
        if (conversations.length === 0) {
          conversationId = uuidv4();
          await pool.execute(
            `INSERT INTO whatsapp_conversations (id, lead_id, contact_number, last_message_preview, unread_count) 
             VALUES (?, ?, ?, ?, 1)`,
            [conversationId, lead?.id || null, from, content]
          );
        } else {
          conversationId = conversations[0].id;
          await pool.execute(
            `UPDATE whatsapp_conversations SET 
              lead_id = COALESCE(lead_id, ?), 
              last_message_preview = ?, 
              unread_count = unread_count + 1, 
              last_message_at = NOW(),
              updated_at = NOW() 
             WHERE id = ?`,
            [lead?.id || null, content, conversationId]
          );
        }

        // 3. Save message
        await pool.execute(
          `INSERT INTO whatsapp_messages (id, conversation_id, whatsapp_message_id, direction, type, content, media_id, status, sent_at)
           VALUES (?, ?, ?, 'inbound', ?, ?, ?, 'received', FROM_UNIXTIME(?))`,
          [uuidv4(), conversationId, msgId, type, content, mediaId, timestamp]
        );

        console.log(`[WhatsApp Webhook] Message saved for ${from}`);
      }
    }

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('WhatsApp Webhook Error:', error);
    return res.status(200).send('EVENT_RECEIVED'); // Always return 200 to Meta to avoid retry loops
  }
};

/**
 * Get List of WhatsApp Conversations
 */
export const getWhatsAppConversations = async (req, res) => {
  try {
    const pool = getPool();
    const userId = req.user.id || req.user._id;
    const roleName = req.user.roleName;

    let query = `
      SELECT c.*, l.name as lead_name, l.enquiry_number as lead_enquiry_number
      FROM whatsapp_conversations c
      LEFT JOIN leads l ON c.lead_id = l.id
    `;
    
    const params = [];
    
    // Filter for non-admin users
    if (!hasElevatedAdminPrivileges(roleName) && roleName !== 'Admin') {
      query += `
        WHERE (
          l.assigned_to = ? 
          OR l.assigned_to_pro = ? 
          OR EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.conversation_id = c.id AND m.sent_by = ?)
        )
      `;
      params.push(userId, userId, userId);
    }

    query += ` ORDER BY c.last_message_at DESC`;

    const [rows] = await pool.execute(query, params);
    return successResponse(res, rows);
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

/**
 * Get Message History for a Conversation
 */
export const getWhatsAppMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const pool = getPool();
    
    // Mark as read when fetching
    await pool.execute(
      'UPDATE whatsapp_conversations SET unread_count = 0 WHERE id = ?',
      [conversationId]
    );

    const [rows] = await pool.execute(
      `SELECT m.*, u.name as sent_by_name
       FROM whatsapp_messages m
       LEFT JOIN users u ON m.sent_by = u.id
       WHERE m.conversation_id = ?
       ORDER BY m.sent_at ASC`,
      [conversationId]
    );
    return successResponse(res, rows);
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

/**
 * Send a manual reply (Chat)
 */
export const sendWhatsAppChatReply = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { text } = req.body;
    const userId = req.user.id || req.user._id;

    if (!text) return errorResponse(res, 'Message text is required', 400);

    const pool = getPool();
    const [conversations] = await pool.execute(
      'SELECT id, contact_number FROM whatsapp_conversations WHERE id = ?',
      [conversationId]
    );

    if (conversations.length === 0) return errorResponse(res, 'Conversation not found', 404);
    const conversation = conversations[0];

    // 1. Send via WhatsApp Service
    const result = await whatsappService.sendTextMessage(conversation.contact_number, text);

    // 2. Save Message
    const msgId = uuidv4();
    await pool.execute(
      `INSERT INTO whatsapp_messages (id, conversation_id, whatsapp_message_id, direction, type, content, status, sent_by, sent_at)
       VALUES (?, ?, ?, 'outbound', 'text', ?, 'sent', ?, NOW())`,
      [msgId, conversationId, result.messageId, text, userId]
    );

    // 3. Update Conversation
    await pool.execute(
      'UPDATE whatsapp_conversations SET last_message_preview = ?, last_message_at = NOW(), updated_at = NOW() WHERE id = ?',
      [text, conversationId]
    );

    return successResponse(res, { id: msgId, status: 'sent' }, 'Message sent');
  } catch (error) {
    return errorResponse(res, error.message, 500);
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
