import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const GMAIL_SENDER_NAME = process.env.GMAIL_SENDER_NAME || 'CRM Admissions';

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.warn(
    '[NodeMailerEmail] Missing GMAIL_USER or GMAIL_APP_PASSWORD. Email sending via Gmail will fail until these environment variables are set.'
  );
}

// Create reusable transporter
let transporter = null;

const getTransporter = () => {
  if (transporter) {
    return transporter;
  }

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error('Gmail credentials are not configured');
  }

  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });

  return transporter;
};

/**
 * Send email using NodeMailer (Gmail)
 * @param {Object} options - Email options
 * @param {string|string[]} options.to - Recipient email(s)
 * @param {string} options.subject - Email subject
 * @param {string} options.htmlContent - HTML content
 * @param {string} [options.textContent] - Plain text content (optional)
 * @param {Object} [options.replyTo] - Reply-to email and name
 * @param {string} [options.from] - Sender email (defaults to GMAIL_USER)
 * @param {string} [options.fromName] - Sender name (defaults to GMAIL_SENDER_NAME)
 * @returns {Promise<Object>} Response with success status and message ID
 */
export const sendEmailViaNodeMailer = async ({
  to,
  subject,
  htmlContent,
  textContent,
  replyTo,
  from,
  fromName,
}) => {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error('Gmail credentials are not configured');
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

  const mailOptions = {
    from: from
      ? `${fromName || GMAIL_SENDER_NAME} <${from}>`
      : `${GMAIL_SENDER_NAME} <${GMAIL_USER}>`,
    to: recipients.join(', '),
    subject: subject.trim(),
    html: htmlContent || textContent,
    ...(textContent && { text: textContent }),
    ...(replyTo && {
      replyTo: replyTo.email
        ? `${replyTo.name || GMAIL_SENDER_NAME} <${replyTo.email}>`
        : replyTo.email || GMAIL_USER,
    }),
  };

  try {
    const transport = getTransporter();
    const info = await transport.sendMail(mailOptions);

    return {
      success: true,
      messageId: info.messageId,
      response: {
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
      },
    };
  } catch (error) {
    console.error('[NodeMailerEmail] Error sending email:', error.message);
    throw new Error(error.message || 'Failed to send email via NodeMailer');
  }
};

/**
 * Verify Gmail connection
 * @returns {Promise<boolean>} True if connection is valid
 */
export const verifyGmailConnection = async () => {
  try {
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      return false;
    }

    const transport = getTransporter();
    await transport.verify();
    return true;
  } catch (error) {
    console.error('[NodeMailerEmail] Connection verification failed:', error.message);
    return false;
  }
};

