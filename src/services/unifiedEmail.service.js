import { sendEmailViaBrevo } from './brevoEmail.service.js';
import { sendEmailViaNodeMailer } from './nodemailerEmail.service.js';
import { getPool } from '../config-sql/database.js';

/**
 * Get the configured email channel preference
 * @returns {Promise<string>} 'brevo', 'nodemailer', or 'both'
 */
const getEmailChannelPreference = async () => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      'SELECT value FROM notification_configs WHERE type = ? LIMIT 1',
      ['email_channel']
    );
    
    if (rows && rows.length > 0) {
      return rows[0].value || 'brevo';
    }
    
    return 'brevo'; // Default to Brevo for backward compatibility
  } catch (error) {
    console.error('[UnifiedEmail] Error getting email channel preference:', error);
    return 'brevo'; // Default fallback
  }
};

/**
 * Send email through configured channel(s)
 * @param {Object} options - Email options
 * @param {string|string[]} options.to - Recipient email(s)
 * @param {string} options.subject - Email subject
 * @param {string} options.htmlContent - HTML content
 * @param {string} [options.textContent] - Plain text content (optional)
 * @param {Object} [options.replyTo] - Reply-to email and name
 * @param {string} [options.forceChannel] - Force a specific channel ('brevo' or 'nodemailer'), overrides config
 * @returns {Promise<Object>} Result with success status and channel used
 */
export const sendEmail = async ({
  to,
  subject,
  htmlContent,
  textContent,
  replyTo,
  forceChannel,
}) => {
  const channelPreference = forceChannel || (await getEmailChannelPreference());
  const results = {
    success: false,
    channels: {
      brevo: { sent: false, error: null },
      nodemailer: { sent: false, error: null },
    },
    primaryChannel: channelPreference,
  };

  // Send via Brevo if configured
  if (channelPreference === 'brevo' || channelPreference === 'both') {
    try {
      const brevoResult = await sendEmailViaBrevo({
        to,
        subject,
        htmlContent,
        textContent,
        replyTo,
      });
      results.channels.brevo.sent = true;
      results.channels.brevo.messageId = brevoResult.messageId;
      results.success = true;
    } catch (error) {
      console.error('[UnifiedEmail] Brevo send failed:', error.message);
      results.channels.brevo.error = error.message;
      // Don't throw - let NodeMailer try if configured
    }
  }

  // Send via NodeMailer if configured
  if (channelPreference === 'nodemailer' || channelPreference === 'both') {
    try {
      const nodemailerResult = await sendEmailViaNodeMailer({
        to,
        subject,
        htmlContent,
        textContent,
        replyTo,
      });
      results.channels.nodemailer.sent = true;
      results.channels.nodemailer.messageId = nodemailerResult.messageId;
      results.success = true;
    } catch (error) {
      console.error('[UnifiedEmail] NodeMailer send failed:', error.message);
      results.channels.nodemailer.error = error.message;
      // Don't throw - if Brevo succeeded, that's fine
    }
  }

  // If both channels failed, return results with success=false (don't throw)
  // This allows the caller to handle the failure gracefully
  if (!results.success) {
    const errors = [];
    if (results.channels.brevo.error) {
      errors.push(`Brevo: ${results.channels.brevo.error}`);
    }
    if (results.channels.nodemailer.error) {
      errors.push(`NodeMailer: ${results.channels.nodemailer.error}`);
    }
    // Log the error but don't throw - return results with success=false
    console.warn('[UnifiedEmail] All email channels failed:', errors.join('; '));
  }

  return results;
};

/**
 * Test email channels
 * @param {string} testEmail - Email address to send test to
 * @returns {Promise<Object>} Test results for both channels
 */
export const testEmailChannels = async (testEmail) => {
  const { sendEmailViaBrevo } = await import('./brevoEmail.service.js');
  const { sendEmailViaNodeMailer } = await import('./nodemailerEmail.service.js');
  
  const testSubject = 'Test Email - CRM Admissions';
  const testHtml = `
    <html>
      <body>
        <h2>Test Email</h2>
        <p>This is a test email to verify email channel configuration.</p>
        <p>If you received this email, the channel is working correctly.</p>
      </body>
    </html>
  `;

  const results = {
    brevo: { success: false, error: null },
    nodemailer: { success: false, error: null },
  };

  // Test Brevo
  try {
    await sendEmailViaBrevo({
      to: testEmail,
      subject: `${testSubject} (Brevo)`,
      htmlContent: testHtml,
    });
    results.brevo.success = true;
  } catch (error) {
    results.brevo.error = error.message;
  }

  // Test NodeMailer
  try {
    await sendEmailViaNodeMailer({
      to: testEmail,
      subject: `${testSubject} (NodeMailer)`,
      htmlContent: testHtml,
    });
    results.nodemailer.success = true;
  } catch (error) {
    results.nodemailer.error = error.message;
  }

  return results;
};

