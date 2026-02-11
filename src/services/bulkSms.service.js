import axios from 'axios';

const BULK_SMS_API_KEY = process.env.BULK_SMS_API_KEY || '7c9c967a-4ce9-4748-9dc7-d2aaef847275';
const BULK_SMS_SENDER_ID = process.env.BULK_SMS_SENDER_ID || 'PYDAHK';
const BULK_SMS_ENGLISH_API_URL =
  process.env.BULK_SMS_ENGLISH_API_URL || 'https://www.bulksmsapps.com/api/apismsv2.aspx';
const BULK_SMS_UNICODE_API_URL =
  process.env.BULK_SMS_UNICODE_API_URL || 'https://www.bulksmsapps.com/api/apibulkv2.aspx';

if (!BULK_SMS_API_KEY) {
  console.warn(
    '[BulkSMS] Missing BULK_SMS_API_KEY. SMS sending will fail until the environment variable is set.'
  );
}

const SUCCESS_TEXT_REGEX = /successfully submitted/i;
const MESSAGE_ID_REGEX = /MessageId-(\d+)/gi;

const normalizeNumbers = (numbers = []) =>
  numbers
    .map((num) => String(num).replace(/[^\d+]/g, ''))
    .filter(Boolean);

const isValidSmsResponse = (responseText) => {
  if (!responseText || typeof responseText !== 'string') {
    return false;
  }

  const trimmed = responseText.trim();

  if (trimmed.length === 0) {
    return false;
  }

  if (SUCCESS_TEXT_REGEX.test(trimmed)) {
    return true;
  }

  if (MESSAGE_ID_REGEX.test(trimmed)) {
    MESSAGE_ID_REGEX.lastIndex = 0;
    return true;
  }

  if (/^\d+(,\d+)*$/.test(trimmed)) {
    return true;
  }

  return false;
};

const extractMessageIds = (responseText) => {
  if (!responseText || typeof responseText !== 'string') {
    return [];
  }

  const ids = new Set();

  MESSAGE_ID_REGEX.lastIndex = 0;
  let match;
  while ((match = MESSAGE_ID_REGEX.exec(responseText)) !== null) {
    if (match[1]) {
      ids.add(match[1]);
    }
  }
  MESSAGE_ID_REGEX.lastIndex = 0;

  const numericIds = responseText.match(/\b\d+\b/g);
  if (numericIds) {
    numericIds.forEach((id) => ids.add(id));
  }

  return Array.from(ids);
};

export const sendSmsThroughBulkSmsApps = async ({
  numbers,
  message,
  isUnicode = false,
  senderId = BULK_SMS_SENDER_ID,
  tempid = null,
}) => {
  if (!Array.isArray(numbers) || numbers.length === 0) {
    throw new Error('At least one recipient number is required');
  }

  if (!message || !message.trim()) {
    throw new Error('Message content is required');
  }

  if (!BULK_SMS_API_KEY) {
    throw new Error('Bulk SMS API key is not configured');
  }

  const sanitizedNumbers = normalizeNumbers(numbers);

  if (sanitizedNumbers.length === 0) {
    throw new Error('No valid recipient numbers provided');
  }

  const paramsObject = {
    apikey: BULK_SMS_API_KEY,
    sender: senderId,
    number: sanitizedNumbers.join(','),
    message,
  };

  if (tempid) {
    paramsObject.tempid = tempid;
  }

  if (isUnicode) {
    paramsObject.coding = '3';
  }

  const endpoint =
    sanitizedNumbers.length > 1 || isUnicode
      ? BULK_SMS_UNICODE_API_URL
      : BULK_SMS_ENGLISH_API_URL;

  const startTime = Date.now();

  const response = await axios.get(endpoint, {
    params: paramsObject,
    headers: { Accept: 'text/plain' },
    timeout: 15000,
  });

  const durationMs = Date.now() - startTime;
  const responseText =
    typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data);

  const success = isValidSmsResponse(responseText);
  const messageIds = extractMessageIds(responseText);

  console.log(`[BulkSMS] Sent to ${sanitizedNumbers.join(',')}. Message: "${message}". Success: ${success}. Response: ${responseText}`);

  return {
    success,
    messageIds,
    durationMs,
    responseText,
    endpoint,
    transport: 'GET',
    numbers: sanitizedNumbers,
  };
};



/**
 * Send OTP
 */
export const sendOTP = async (mobileNumber, otp) => {
  const otpTemplateId = process.env.OTP_TEMPLATE_ID || '1007482811215703964'; // Env or Fallback
  const message = `Your OTP for recovering your password is ${otp} - PYDAH`;

  return sendSmsThroughBulkSmsApps({
    numbers: [mobileNumber],
    message,
    tempid: otpTemplateId,
  });
};

/**
 * Send Password Reset Success
 * Template ID: 1707176526611076697
 */
export const sendPasswordResetSuccess = async (mobileNumber, name, username, newPassword, loginUrl) => {
  const templateId = '1707176526611076697';
  const message = `Hello ${name} your password has been updated. Username: ${username} New Password: ${newPassword} Login: ${loginUrl}- Pydah College`;

  return sendSmsThroughBulkSmsApps({
    numbers: [mobileNumber],
    message,
    tempid: templateId,
  });
};

export default {
  sendSmsThroughBulkSmsApps,
  sendOTP,
  sendPasswordResetSuccess
};
