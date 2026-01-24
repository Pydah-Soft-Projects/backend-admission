import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce recommended for GCM
let cachedKeyBuffer = undefined;
let encryptionWarningLogged = false;

const getKeyBuffer = () => {
  if (cachedKeyBuffer !== undefined) {
    return cachedKeyBuffer;
  }

  const secret = process.env.JOINING_ENCRYPTION_KEY;
  if (!secret) {
    if (!encryptionWarningLogged) {
      console.warn(
        '[encryption] JOINING_ENCRYPTION_KEY is not configured. Sensitive fields will be stored as plain text.'
      );
      encryptionWarningLogged = true;
    }
    cachedKeyBuffer = null;
    return cachedKeyBuffer;
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
  if (!key) {
    return String(value);
  }

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

  const key = getKeyBuffer();
  if (!key) {
    // If encryption key is not set, return value as-is (plain text)
    return value;
  }

  // Check if value is encrypted (encrypted values have format: iv:authTag:encrypted)
  const parts = value.split(':');
  if (parts.length !== 3) {
    // Not encrypted format, return as plain text (backward compatibility)
    return value;
  }

  try {
    const [ivPart, authTagPart, encryptedPart] = parts;
    if (!ivPart || !authTagPart || !encryptedPart) {
      // Invalid format, return as plain text
      return value;
    }

    const iv = Buffer.from(ivPart, 'base64');
    const authTag = Buffer.from(authTagPart, 'base64');
    const encrypted = Buffer.from(encryptedPart, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    // If decryption fails, it might be plain text (backward compatibility)
    console.warn('Failed to decrypt value, treating as plain text:', error.message);
    return value;
  }
};

export const maskSensitiveValue = (value, visibleDigits = 4) => {
  if (!value) return value;
  const clean = String(value).replace(/\s+/g, '');
  if (clean.length <= visibleDigits) return clean;
  const maskedSection = clean.slice(0, -visibleDigits).replace(/./g, 'X');
  return `${maskedSection}${clean.slice(-visibleDigits)}`;
};


