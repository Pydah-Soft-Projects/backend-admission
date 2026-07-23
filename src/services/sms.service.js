import axios from 'axios';
import dotenv from 'dotenv';
import { getPool } from '../config-sql/database.js';
import { sendSmsThroughBulkSmsApps } from './bulkSms.service.js';

dotenv.config();

const BULK_SMS_API_KEY = process.env.BULK_SMS_API_KEY;
const BULK_SMS_SENDER_ID = process.env.BULK_SMS_SENDER_ID || 'PYDAHK';

/** SDMS student portal login URL sent in account-created SMS (no scheme). */
export const STUDENT_PORTAL_LOGIN_URL =
  process.env.STUDENT_PORTAL_LOGIN_URL || 'sdms.pydah.edu.in';

/** DLT template: Hello {#var#} your account has been created. Username: {#var#} Password: {#var#}. Login: {#var#}- Pydah College */
const STUDENT_ACCOUNT_CREATED_DLT_TEMPLATE_ID = '1707176525577028276';

/**
 * DLT template id for parent portal SMS (code-only; not in message_templates).
 * Template: Dear parent , To track your child progress please login to our college portal {#var#} - Pydah Group
 * Override via PARENT_PORTAL_SMS_DLT_TEMPLATE_ID in .env if needed.
 */
const PARENT_PORTAL_SMS_DLT_TEMPLATE_ID =
  process.env.PARENT_PORTAL_SMS_DLT_TEMPLATE_ID?.trim() || '1707178073635639145';

/** Parent SMS body — {#var#} = portal login URL; must match the approved DLT template exactly. */
const PARENT_PORTAL_SMS_MESSAGE = `Dear parent , To track your child progress please login to our college portal ${STUDENT_PORTAL_LOGIN_URL} - Pydah Group`;

/**
 * Look up a DLT template id by its `message_templates.name`. Results are cached
 * in-memory for `TEMPLATE_LOOKUP_TTL_MS` so a high-traffic endpoint doesn't hit
 * the DB on every send. Single source of truth = the row inserted by the
 * `migrate:*-sms-template` scripts.
 */
const TEMPLATE_LOOKUP_TTL_MS = 5 * 60 * 1000;
const templateIdCache = new Map();

async function resolveDltTemplateId(templateName) {
  const key = String(templateName || '').trim();
  if (!key) return null;
  const hit = templateIdCache.get(key);
  if (hit && Date.now() - hit.at < TEMPLATE_LOOKUP_TTL_MS) {
    return hit.id;
  }
  try {
    const [rows] = await getPool().execute(
      'SELECT dlt_template_id FROM message_templates WHERE name = ? AND is_active = TRUE ORDER BY updated_at DESC LIMIT 1',
      [key]
    );
    const id = rows[0]?.dlt_template_id ? String(rows[0].dlt_template_id).trim() : null;
    if (id) templateIdCache.set(key, { id, at: Date.now() });
    return id;
  } catch (err) {
    console.warn(`Failed to resolve dlt_template_id for "${key}":`, err?.message || err);
    return null;
  }
}

const smsService = {
  /**
   * Send OTP to a mobile number
   * @param {string} mobileNumber - The 10-digit mobile number
   * @param {string} otp - The OTP code
   * @returns {Promise<Object>} - The API response
   */
  sendOTP: async (mobileNumber, otp) => {
    if (!BULK_SMS_API_KEY) {
      console.warn('BULKSMS_API_KEY is not set. OTP sending skipped (Dev Mode).');
      return { success: true, message: 'SMS simulation successful (Dev Mode)' };
    }

    // Clean mobile number (keep last 10 digits if needed, or assume valid input)
    // The API expects a specific format, usually just the number.
    const cleanNumber = mobileNumber.replace(/\D/g, '').slice(-10);
    const otpTemplateId = process.env.OTP_TEMPLATE_ID || '1007482811215703964'; // Fallback or Env

    const message = `Your OTP for recovering your password is ${otp} - PYDAH`;
    // URL Encode message
    const encodedMessage = encodeURIComponent(message);

    const url = `https://www.bulksmsapps.com/api/apismsv2.aspx?apikey=${BULK_SMS_API_KEY}&sender=${BULK_SMS_SENDER_ID}&mobile=${cleanNumber}&message=${encodedMessage}&type=1&tempid=${otpTemplateId}`;

    try {
      const response = await axios.get(url);
      console.log(`SMS Sent to ${cleanNumber}. Response:`, response.data);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Failed to send SMS:', error.message);
      throw new Error('Failed to send OTP SMS');
    }
  },

  /**
   * Send Admission Confirmation SMS to an approved student.
   *
   * DLT-approved template (lives in `message_templates`, name =
   * 'Admission · confirmation on approval', seeded by
   * `npm run migrate:admission-confirmation-sms-template`):
   *   Dear {#var#}, Congratulations and welcome to Pydah Group! Your admission
   *   has been successfully processed. Admission Number: {#var#}. We look
   *   forward to being part of your academic journey. Warm Regards, Pydah Group
   *
   * The DLT template id is read from the DB row (cached for 5 min) — never
   * hardcoded — so updating the DLT entry only requires updating that row.
   * Errors are swallowed; an SMS failure must never roll back an approval.
   */
  sendAdmissionConfirmation: async (mobileNumber, name, admissionNumber) => {
    if (!BULK_SMS_API_KEY) {
      console.warn('BULK_SMS_API_KEY is not set. Admission confirmation SMS skipped (Dev Mode).');
      return { success: true, message: 'SMS simulation successful (Dev Mode)' };
    }

    const cleanNumber = String(mobileNumber || '').replace(/\D/g, '').slice(-10);
    if (cleanNumber.length !== 10) {
      console.warn(`Admission confirmation SMS skipped — invalid mobile "${mobileNumber}".`);
      return { success: false, error: 'invalid_mobile_number' };
    }
    const safeName = String(name || 'Student').trim() || 'Student';
    const safeAdmissionNumber = String(admissionNumber || '').trim();
    if (!safeAdmissionNumber) {
      console.warn('Admission confirmation SMS skipped — missing admissionNumber.');
      return { success: false, error: 'missing_admission_number' };
    }

    const templateId = await resolveDltTemplateId('Admission · confirmation on approval');
    if (!templateId) {
      console.warn(
        'Admission confirmation SMS skipped — template "Admission · confirmation on approval" not found in message_templates. Run `npm run migrate:admission-confirmation-sms-template`.'
      );
      return { success: false, error: 'template_not_found' };
    }

    const message = `Dear ${safeName}, Congratulations and welcome to Pydah Group! Your admission has been successfully processed. Admission Number: ${safeAdmissionNumber}. We look forward to being part of your academic journey. Warm Regards, Pydah Group`;

    // Delegate to bulkSms.service.js so the response is *actually* parsed
    // against the BulkSMSApps success pattern ("successfully submitted" /
    // MessageId-NNN). Without this the gateway's .NET error envelope
    // ("Object reference not set to an instance of an object." + an ASP.NET
    // postback form) was being treated as success and the SMS was never
    // actually delivered. See bulkSms.service.js#isValidSmsResponse.
    try {
      const result = await sendSmsThroughBulkSmsApps({
        numbers: [cleanNumber],
        message,
        tempid: templateId,
      });

      const responsePreview = String(result.responseText || '')
        .replace(/\s+/g, ' ')
        .slice(0, 240);

      if (result.success) {
        console.log(
          `Admission confirmation SMS sent to ${cleanNumber} (admission ${safeAdmissionNumber}, dlt ${templateId}, messageIds=[${result.messageIds.join(',')}]).`
        );
        return {
          success: true,
          data: { messageIds: result.messageIds, responseText: result.responseText },
        };
      }

      console.error(
        `Admission confirmation SMS rejected by gateway (mobile=${cleanNumber}, admission=${safeAdmissionNumber}, dlt=${templateId}). Gateway response: ${responsePreview}`
      );
      return {
        success: false,
        error: 'gateway_rejected',
        gatewayMessage: responsePreview,
      };
    } catch (error) {
      console.error('Failed to send admission confirmation SMS:', error.message || error);
      return { success: false, error: error.message || 'sms_send_failed' };
    }
  },

  /**
   * Send parent portal SMS after joining approval (father/mother lines).
   * Template is fixed in code only (no message_templates row).
   *
   * DLT template id 1707178073635639145:
   *   Dear parent , To track your child progress please login to our college portal {#var#} - Pydah Group
   *
   * Variable: portal login URL (STUDENT_PORTAL_LOGIN_URL / sdms.pydah.edu.in).
   */
  sendParentPortalProgress: async (mobileNumber) => {
    if (!BULK_SMS_API_KEY) {
      console.warn('BULK_SMS_API_KEY is not set. Parent portal SMS skipped (Dev Mode).');
      return { success: true, message: 'SMS simulation successful (Dev Mode)' };
    }

    const cleanNumber = String(mobileNumber || '').replace(/\D/g, '').slice(-10);
    if (cleanNumber.length !== 10) {
      console.warn(`Parent portal SMS skipped — invalid mobile "${mobileNumber}".`);
      return { success: false, error: 'invalid_mobile_number' };
    }

    const templateId = PARENT_PORTAL_SMS_DLT_TEMPLATE_ID;
    try {
      const result = await sendSmsThroughBulkSmsApps({
        numbers: [cleanNumber],
        message: PARENT_PORTAL_SMS_MESSAGE,
        tempid: templateId,
      });

      const responsePreview = String(result.responseText || '')
        .replace(/\s+/g, ' ')
        .slice(0, 240);

      if (result.success) {
        console.log(
          `Parent portal SMS sent to ${cleanNumber} (dlt ${templateId}, messageIds=[${result.messageIds.join(',')}]).`
        );
        return {
          success: true,
          data: { messageIds: result.messageIds, responseText: result.responseText },
        };
      }

      console.error(
        `Parent portal SMS rejected by gateway (mobile=${cleanNumber}, dlt=${templateId}). Gateway response: ${responsePreview}`
      );
      return {
        success: false,
        error: 'gateway_rejected',
        gatewayMessage: responsePreview,
      };
    } catch (error) {
      console.error('Failed to send parent portal SMS:', error.message || error);
      return { success: false, error: error.message || 'sms_send_failed' };
    }
  },

  /**
   * Send student portal account-created SMS after secondary DB sync on joining approval.
   *
   * DLT template id 1707176525577028276:
   *   Hello {#var#} your account has been created. Username: {#var#} Password: {#var#}.
   *   Login: {#var#}- Pydah College
   *
   * Variables: student name, admission number (username), 6-char portal password, login URL.
   * Auto-sent from `approveJoining` only when new credentials are created — not via Communications UI.
   */
  sendStudentAccountCreated: async (
    mobileNumber,
    name,
    username,
    password,
    loginUrl = STUDENT_PORTAL_LOGIN_URL
  ) => {
    if (!BULK_SMS_API_KEY) {
      console.warn('BULK_SMS_API_KEY is not set. Student account SMS skipped (Dev Mode).');
      return { success: true, message: 'SMS simulation successful (Dev Mode)' };
    }

    const cleanNumber = String(mobileNumber || '').replace(/\D/g, '').slice(-10);
    if (cleanNumber.length !== 10) {
      console.warn(`Student account SMS skipped — invalid mobile "${mobileNumber}".`);
      return { success: false, error: 'invalid_mobile_number' };
    }

    const safeName = String(name || 'Student').trim() || 'Student';
    const safeUsername = String(username || '').trim();
    const safePassword = String(password || '').trim();
    const safeLoginUrl = String(loginUrl || STUDENT_PORTAL_LOGIN_URL).trim();
    if (!safeUsername || !safePassword) {
      console.warn('Student account SMS skipped — missing username or password.');
      return { success: false, error: 'missing_credentials' };
    }

    const message = `Hello ${safeName} your account has been created. Username: ${safeUsername} Password: ${safePassword} Login: ${safeLoginUrl}- Pydah College`;

    try {
      const result = await sendSmsThroughBulkSmsApps({
        numbers: [cleanNumber],
        message,
        tempid: STUDENT_ACCOUNT_CREATED_DLT_TEMPLATE_ID,
      });

      const responsePreview = String(result.responseText || '')
        .replace(/\s+/g, ' ')
        .slice(0, 240);

      if (result.success) {
        console.log(
          `Student account SMS sent to ${cleanNumber} (username ${safeUsername}, dlt ${STUDENT_ACCOUNT_CREATED_DLT_TEMPLATE_ID}, messageIds=[${result.messageIds.join(',')}]).`
        );
        return {
          success: true,
          data: { messageIds: result.messageIds, responseText: result.responseText },
        };
      }

      console.error(
        `Student account SMS rejected by gateway (mobile=${cleanNumber}, username=${safeUsername}, dlt=${STUDENT_ACCOUNT_CREATED_DLT_TEMPLATE_ID}). Gateway response: ${responsePreview}`
      );
      return {
        success: false,
        error: 'gateway_rejected',
        gatewayMessage: responsePreview,
      };
    } catch (error) {
      console.error('Failed to send student account SMS:', error.message || error);
      return { success: false, error: error.message || 'sms_send_failed' };
    }
  },

  /**
   * Send Password Reset Success SMS
   * Template: Hello {#var#} your password has been updated. Username: {#var#} New Password: {#var#} Login: {#var#}- Pydah College
   * Template ID: 1707176526611076697
   */
  sendPasswordResetSuccess: async (mobileNumber, name, username, newPassword, loginUrl) => {
    if (!BULK_SMS_API_KEY) {
      console.warn('BULKSMS_API_KEY is not set. Reset SMS skipping (Dev Mode).');
      return { success: true, message: 'SMS simulation successful (Dev Mode)' };
    }

    const cleanNumber = mobileNumber.replace(/\D/g, '').slice(-10);
    
    // Construct message: "Hello {name} your password has been updated. Username: {username} New Password: {newPassword} Login: {loginUrl}- Pydah College"
    const message = `Hello ${name} your password has been updated. Username: ${username} New Password: ${newPassword} Login: ${loginUrl}- Pydah College`;
    
    // URL Encode message
    const encodedMessage = encodeURIComponent(message);
    const templateId = '1707176526611076697';

    const url = `https://www.bulksmsapps.com/api/apismsv2.aspx?apikey=${BULK_SMS_API_KEY}&sender=${BULK_SMS_SENDER_ID}&mobile=${cleanNumber}&message=${encodedMessage}&type=1&tempid=${templateId}`;

    try {
      const response = await axios.get(url);
      console.log(`Password Reset SMS Sent to ${cleanNumber}. Response:`, response.data);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Failed to send Password Reset SMS:', error.message);
      // Don't throw here, as password is already reset. Just log error.
      return { success: false, error: error.message }; 
    }
  },

  /**
   * Send Document Notification SMS to student.
   * DLT template id: 1777178471122897474
   * Template: Dear Student {#var#}, the following certificates are pending - {#var#}. Kindly contact the Admissions Office immediately at {#var#} - Pydah Group
   */
  sendDocumentNotification: async (mobileNumber, name, pendingDocuments, collegePhone = '+91 73820 15999') => {
    if (!BULK_SMS_API_KEY) {
      console.warn('BULK_SMS_API_KEY is not set. Document Notification SMS skipped (Dev Mode).');
      return { success: true, message: 'SMS simulation successful (Dev Mode)' };
    }

    const cleanNumber = String(mobileNumber || '').replace(/\D/g, '').slice(-10);
    if (cleanNumber.length !== 10) {
      console.warn(`Document Notification SMS skipped — invalid mobile "${mobileNumber}".`);
      return { success: false, error: 'invalid_mobile_number' };
    }

    const safeName = String(name || 'Student').trim() || 'Student';
    const safePendingDocuments = Array.isArray(pendingDocuments) ? pendingDocuments.join(', ') : String(pendingDocuments || '');
    const templateId = '1777178471122897474';
    const message = `Dear Student ${safeName}, the following certificates are pending - ${safePendingDocuments}. Kindly contact the Admissions Office immediately at ${collegePhone} - Pydah Group`;

    try {
      const result = await sendSmsThroughBulkSmsApps({
        numbers: [cleanNumber],
        message,
        tempid: templateId,
      });

      const responsePreview = String(result.responseText || '')
        .replace(/\s+/g, ' ')
        .slice(0, 240);

      if (result.success) {
        console.log(
          `Document Notification SMS sent to ${cleanNumber} (dlt ${templateId}, messageIds=[${result.messageIds.join(',')}]).`
        );
        return {
          success: true,
          data: { messageIds: result.messageIds, responseText: result.responseText },
        };
      }

      console.error(
        `Document Notification SMS rejected by gateway (mobile=${cleanNumber}, dlt=${templateId}). Gateway response: ${responsePreview}`
      );
      return {
        success: false,
        error: 'gateway_rejected',
        gatewayMessage: responsePreview,
      };
    } catch (error) {
      console.error('Failed to send Document Notification SMS:', error.message || error);
      return { success: false, error: error.message || 'sms_send_failed' };
    }
  },
};

export default smsService;
