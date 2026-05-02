import axios from 'axios';

const BULK_SMS_API_KEY = process.env.BULK_SMS_API_KEY || '';
const BULK_SMS_SENDER_ID = process.env.BULK_SMS_SENDER_ID || 'PYDAHK';
/** Portal login name (e.g. pydahsoft) — shown in UI only; not sent to balance API. */
const BULK_SMS_ACCOUNT_USERNAME =
  process.env.BULK_SMS_ACCOUNT_USERNAME || process.env.BULKSMS_USERNAME || '';
const BULK_SMS_BALANCE_URL =
  process.env.BULK_SMS_BALANCE_URL || 'https://www.bulksmsapps.com/api/apicheckbalancev2.aspx';
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

/** Strip query secrets if provider echoes them inside HTML. */
const redactSensitiveInText = (str) =>
  String(str || '')
    .replace(/apikey=[^&\s"'<>]+/gi, 'apikey=***')
    .replace(/password=[^&\s"'<>]+/gi, 'password=***');

/**
 * BulkSMSApps balance API often returns a short text line plus ASP.NET HTML, e.g.
 * "111070 credit balance <BR> <!DOCTYPE html>..."
 */
const parseCreditsFromBalanceResponse = (raw) => {
  const textBeforeFirstTag = raw.split('<')[0].replace(/\s+/g, ' ').trim();
  const creditPhrase =
    textBeforeFirstTag.match(/(\d[\d,\s]*)\s*credit\s*balance/i) ||
    raw.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/gi, ' ').replace(/\s+/g, ' ').trim()
      .match(/(\d[\d,\s]*)\s*credit\s*balance/i);

  if (creditPhrase) {
    const n = Number(String(creditPhrase[1]).replace(/[\s,]/g, ''));
    if (Number.isFinite(n) && n >= 0) {
      return {
        balanceCredits: n,
        balanceRaw: `${n} credit balance`.trim(),
      };
    }
  }

  const compact = textBeforeFirstTag.replace(/,/g, '');
  const simpleNum = compact.match(/^(-?\d+(?:\.\d+)?)\s*$/);
  if (simpleNum) {
    const n = Number(simpleNum[1]);
    if (Number.isFinite(n)) {
      return { balanceCredits: n, balanceRaw: textBeforeFirstTag };
    }
  }

  const flat = raw.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/gi, ' ').replace(/\s+/g, ' ').trim();
  const errProbe = (textBeforeFirstTag || flat).slice(0, 400);
  if (/invalid|authentication|unauthor|wrong\s*api|api\s*key|^error\b|failed|denied/i.test(errProbe)) {
    return { balanceCredits: null, balanceRaw: errProbe.slice(0, 200), providerMessage: errProbe.slice(0, 300) };
  }

  const firstNum = textBeforeFirstTag.match(/-?\d+(?:\.\d+)?/);
  if (firstNum && textBeforeFirstTag.length <= 80) {
    const n = Number(firstNum[0]);
    if (Number.isFinite(n)) {
      return { balanceCredits: n, balanceRaw: textBeforeFirstTag };
    }
  }

  return {
    balanceCredits: null,
    balanceRaw: textBeforeFirstTag.slice(0, 120) || flat.slice(0, 120),
    providerMessage: 'Could not parse credit balance from provider response.',
  };
};

/**
 * Check account SMS credits (BulkSMSApps HTTP API v2).
 * @see https://www.bulksmsapps.com/api/apicheckbalancev2.aspx?apikey=...
 */
export const getBulkSmsAccountInfo = async () => {
  const username = BULK_SMS_ACCOUNT_USERNAME.trim() || null;
  const senderId = BULK_SMS_SENDER_ID;

  if (!BULK_SMS_API_KEY) {
    return {
      configured: false,
      username,
      senderId,
      balanceCredits: null,
      balanceRaw: null,
      providerMessage: 'Bulk SMS API key is not configured on the server (BULK_SMS_API_KEY).',
    };
  }

  const response = await axios.get(BULK_SMS_BALANCE_URL, {
    params: { apikey: BULK_SMS_API_KEY },
    timeout: 15000,
    headers: { Accept: 'text/plain' },
  });

  const raw =
    typeof response.data === 'string'
      ? response.data.trim()
      : String(response.data ?? '').trim();

  if (!raw) {
    return {
      configured: true,
      username,
      senderId,
      balanceCredits: null,
      balanceRaw: null,
      providerMessage: 'Empty response from balance API',
    };
  }

  const parsed = parseCreditsFromBalanceResponse(raw);
  const safeRaw = parsed.balanceRaw != null ? redactSensitiveInText(parsed.balanceRaw) : null;
  const safeMsg = parsed.providerMessage != null ? redactSensitiveInText(parsed.providerMessage) : null;

  if (parsed.providerMessage && parsed.balanceCredits === null) {
    return {
      configured: true,
      username,
      senderId,
      balanceCredits: null,
      balanceRaw: safeRaw,
      providerMessage: safeMsg,
    };
  }

  return {
    configured: true,
    username,
    senderId,
    balanceCredits: parsed.balanceCredits,
    balanceRaw: safeRaw,
    providerMessage: null,
  };
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

/**
 * Send Visitor Code SMS
 * Template: Visitor Code Dear {#var#}, Your Visitor Code for admission is {#var#}. Your Counsellor is {#var#}. Please use this code during your campus visit - Pydah Group
 * Template ID: 1707177753294074438
 */
export const sendVisitorCode = async (mobileNumber, leadName, code, counselorName) => {
  const templateId = '1707177753294074438';
  const message = `Dear ${leadName}, Your Visitor Code for admission is ${code}. Your Counsellor is ${counselorName}. Please use this code during your campus visit - Pydah Group`;

  return sendSmsThroughBulkSmsApps({
    numbers: [mobileNumber],
    message,
    tempid: templateId,
  });
};

export default {
  sendOTP,
  sendPasswordResetSuccess,
  sendVisitorCode,
  getBulkSmsAccountInfo,
};
