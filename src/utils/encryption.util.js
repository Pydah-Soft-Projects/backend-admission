import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce recommended for GCM
let cachedKeyBuffer = null;

const getKeyBuffer = () => {
  if (cachedKeyBuffer) {
    return cachedKeyBuffer;
  }

  const secret = process.env.JOINING_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('JOINING_ENCRYPTION_KEY is not configured');
  }

  if (secret.length < 32) {
    // Pad the key deterministically (not ideal, but ensures correct length)
    const padded = secret.padEnd(32, '0').slice(0, 32);
    cachedKeyBuffer = Buffer.from(padded, 'utf8');
  } else if (secret.length > 32) {
    cachedKeyBuffer = Buffer.from(secret.slice(0, 32), 'utf8');
  } else {
    cachedKeyBuffer = Buffer.from(secret, 'utf8');
  }

  return cachedKeyBuffer;
};

export const encryptSensitiveValue = (value) => {
  if (value === undefined || value === null || value === '') {
    return value;
  }

  const key = getKeyBuffer();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
};

export const decryptSensitiveValue = (value) => {
  if (!value || typeof value !== 'string') {
    return value;
  }

  try {
    const [ivPart, authTagPart, encryptedPart] = value.split(':');
    if (!ivPart || !authTagPart || !encryptedPart) {
      return value;
    }

    const key = getKeyBuffer();
    const iv = Buffer.from(ivPart, 'base64');
    const authTag = Buffer.from(authTagPart, 'base64');
    const encrypted = Buffer.from(encryptedPart, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    console.error('Failed to decrypt sensitive value:', error);
    return null;
  }
};

export const maskSensitiveValue = (value, visibleDigits = 4) => {
  if (!value) return value;
  const clean = String(value).replace(/\s+/g, '');
  if (clean.length <= visibleDigits) return clean;
  const maskedSection = clean.slice(0, -visibleDigits).replace(/./g, 'X');
  return `${maskedSection}${clean.slice(-visibleDigits)}`;
};


