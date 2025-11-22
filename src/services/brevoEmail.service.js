import axios from 'axios';

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'team@pydasoft.in';
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'CRM Admissions';

if (!BREVO_API_KEY) {
  console.warn(
    '[BrevoEmail] Missing BREVO_API_KEY. Email sending will fail until the environment variable is set.'
  );
}

/**
 * Send email using Brevo (formerly Sendinblue)
 * @param {Object} options - Email options
 * @param {string|string[]} options.to - Recipient email(s)
 * @param {string} options.subject - Email subject
 * @param {string} options.htmlContent - HTML content
 * @param {string} [options.textContent] - Plain text content (optional)
 * @param {Object} [options.replyTo] - Reply-to email and name
 * @returns {Promise<Object>} Response from Brevo API
 */
export const sendEmailViaBrevo = async ({
  to,
  subject,
  htmlContent,
  textContent,
  replyTo,
}) => {
  if (!BREVO_API_KEY) {
    throw new Error('Brevo API key is not configured');
  }

  if (!to || (!Array.isArray(to) && !to.trim())) {
    throw new Error('Recipient email is required');
  }

  if (!subject || !subject.trim()) {
    throw new Error('Email subject is required');
  }

  if (!htmlContent && !textContent) {
    throw new Error('Email content (HTML or text) is required');
  }

  // Normalize recipients to array
  const recipients = Array.isArray(to) ? to : [to];
  const toArray = recipients.map((email) => ({ email: email.trim() }));

  const payload = {
    sender: {
      name: BREVO_SENDER_NAME,
      email: BREVO_SENDER_EMAIL,
    },
    to: toArray,
    subject: subject.trim(),
    htmlContent: htmlContent || textContent,
    ...(textContent && { textContent }),
    ...(replyTo && {
      replyTo: {
        email: replyTo.email || BREVO_SENDER_EMAIL,
        name: replyTo.name || BREVO_SENDER_NAME,
      },
    }),
  };

  try {
    const response = await axios.post(BREVO_API_URL, payload, {
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    return {
      success: true,
      messageId: response.data?.messageId,
      response: response.data,
    };
  } catch (error) {
    console.error('[BrevoEmail] Error sending email:', error.response?.data || error.message);
    throw new Error(
      error.response?.data?.message || error.message || 'Failed to send email via Brevo'
    );
  }
};

/**
 * Send transactional email template via Brevo
 * @param {Object} options - Email options
 * @param {string|string[]} options.to - Recipient email(s)
 * @param {number} options.templateId - Brevo template ID
 * @param {Object} [options.params] - Template parameters
 * @returns {Promise<Object>} Response from Brevo API
 */
export const sendTemplateEmailViaBrevo = async ({ to, templateId, params = {} }) => {
  if (!BREVO_API_KEY) {
    throw new Error('Brevo API key is not configured');
  }

  if (!to || (!Array.isArray(to) && !to.trim())) {
    throw new Error('Recipient email is required');
  }

  if (!templateId) {
    throw new Error('Template ID is required');
  }

  const recipients = Array.isArray(to) ? to : [to];
  const toArray = recipients.map((email) => ({ email: email.trim() }));

  const payload = {
    to: toArray,
    templateId: Number(templateId),
    params,
  };

  try {
    const response = await axios.post(BREVO_API_URL, payload, {
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    return {
      success: true,
      messageId: response.data?.messageId,
      response: response.data,
    };
  } catch (error) {
    console.error('[BrevoEmail] Error sending template email:', error.response?.data || error.message);
    throw new Error(
      error.response?.data?.message || error.message || 'Failed to send template email via Brevo'
    );
  }
};

