import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import dotenv from 'dotenv';

dotenv.config();

/**
 * WhatsApp Cloud API Service
 * Handles communication with Meta Graph API
 */
class WhatsAppService {
  constructor() {
    this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    this.businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    this.apiVersion = process.env.WHATSAPP_API_VERSION || 'v19.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    this.templatesUrl = `https://graph.facebook.com/${this.apiVersion}/${this.businessAccountId}/message_templates`;
    this.mediaUrl = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/media`;
  }

  /**
   * Upload media to Meta to get a media_id
   * @param {string} filePath - Local path to the file
   * @param {string} type - MIME type or category (IMAGE, VIDEO, DOCUMENT)
   */
  async uploadMedia(filePath, type) {
    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(filePath));
      formData.append('messaging_product', 'whatsapp');
      
      const response = await axios.post(this.mediaUrl, formData, {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${this.accessToken}`
        }
      });
      
      return response.data; // { id: "..." }
    } catch (error) {
      console.error('[WhatsApp Media Upload Error]', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to upload media to WhatsApp');
    }
  }

  /**
   * Send a template-based message
   * @param {string} to - Recipient phone number (with country code, no +)
   * @param {string} templateName - Name of the approved WhatsApp template
   * @param {string} languageCode - Language code (e.g., 'en_US')
   * @param {Array} components - Template variables/components
   */
  async sendTemplateMessage(to, templateName, languageCode = 'en_US', components = []) {
    if (!this.accessToken || !this.phoneNumberId) {
      console.warn('WhatsApp credentials not set. Message sending skipped (Dev Mode).');
      return { success: true, message: 'WhatsApp simulation successful (Dev Mode)', data: { id: 'sim_msg_' + Date.now() } };
    }

    let cleanTo = to.replace(/\D/g, '');
    // Auto-prepend 91 if it's a 10-digit number (assuming India for Pydah)
    if (cleanTo.length === 10) {
      cleanTo = '91' + cleanTo;
    }

    const payload = {
      messaging_product: 'whatsapp',
      to: cleanTo,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: components
      }
    };

    console.log('[WhatsApp API Request]', JSON.stringify(payload, null, 2));

    try {
      const response = await axios.post(this.baseUrl, payload, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      console.log('[WhatsApp API Response]', JSON.stringify(response.data, null, 2));

      return {
        success: true,
        messageId: response.data.messages[0].id,
        data: response.data
      };
    } catch (error) {
      console.error('[WhatsApp API Error Response]', JSON.stringify(error.response?.data || error.message, null, 2));
      throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp message');
    }
  }

  /**
   * Fetch approved templates from Meta
   */
  async fetchRemoteTemplates() {
    if (!this.accessToken || !this.businessAccountId) {
      throw new Error('WhatsApp access token or business account ID not configured');
    }

    try {
      const response = await axios.get(this.templatesUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      return response.data?.data || [];
    } catch (error) {
      console.error('WhatsApp Fetch Templates Error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to fetch WhatsApp templates');
    }
  }

  /**
   * Helper: Format variables into WhatsApp component format
   * @param {Array} allVariables - Flat array of variable values
   * @param {Object} headerConfig - Optional { type, handle, text }
   * @param {Object} templateMeta - Optional info about variable counts
   */
  formatVariables(allVariables, headerConfig = null, templateMeta = null) {
    const components = [];
    let varIndex = 0;

    // 1. Handle Header Component
    if (headerConfig && headerConfig.type && headerConfig.type !== 'NONE') {
      const { type, handle, text } = headerConfig;
      const parameters = [];

      if (type === 'TEXT') {
        const headerVarCount = templateMeta?.headerVarCount || 0;
        if (headerVarCount > 0) {
          const hVars = allVariables.slice(0, headerVarCount);
          varIndex += headerVarCount;
          parameters.push(...hVars.map(v => ({
            type: 'text',
            text: String(typeof v === 'object' ? (v.text || v.value || '') : v)
          })));
        } else if (text) {
          // If text is static, Meta generally doesn't require/allow a header component in the payload
          // unless you want to override it. To be safe with schema (132000), only send if vars exist.
        }
      } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(type) && handle) {
        const isUrl = String(handle).startsWith('http');
        const mediaData = {};
        if (isUrl) {
          if (handle.includes('whatsapp.net') || handle.includes('fbcdn.net')) {
            console.log('[WhatsApp Service] Replacing temporary Meta URL with placeholder for test');
            mediaData.link = type === 'IMAGE' ? 'https://picsum.photos/800/600' : handle;
          } else {
            mediaData.link = handle;
          }
        } else {
          const numericId = parseInt(handle, 10);
          mediaData.id = !isNaN(numericId) && String(numericId) === String(handle) ? numericId : handle;
        }

        // Add filename for documents if provided
        if (type === 'DOCUMENT' && text) {
          mediaData.filename = text;
        }

        parameters.push({ type: type.toLowerCase(), [type.toLowerCase()]: mediaData });
      }

      if (parameters.length > 0) {
        components.push({ type: 'header', parameters });
      }
    }

    // 2. Handle Body Component
    const bodyVarCount = templateMeta?.bodyVarCount ?? (allVariables.length - varIndex);
    const bodyVars = allVariables.slice(varIndex, varIndex + bodyVarCount);
    varIndex += bodyVarCount;

    if (bodyVars.length > 0) {
      components.push({
        type: 'body',
        parameters: bodyVars.map(v => ({
          type: 'text',
          text: String(typeof v === 'object' ? (v.text || v.value || '') : v)
        }))
      });
    }

    // 3. Handle Button Component (if any variables left)
    const buttonVars = allVariables.slice(varIndex);
    if (buttonVars.length > 0) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: buttonVars.map(v => ({
          type: 'text',
          text: String(typeof v === 'object' ? (v.text || v.value || '') : v)
        }))
      });
    }

    return components;
  }
}

export default new WhatsAppService();
