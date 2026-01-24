import { getPool } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

/**
 * Generate a short code for URL shortening
 * @param {number} length - Length of the short code (default: 6)
 * @returns {string} Short code
 */
export const generateShortCode = (length = 6) => {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
};

/**
 * Generate a meaningful short code with custom words
 * @param {string} campaign - Campaign name
 * @param {string} medium - Medium (e.g., facebook, instagram)
 * @returns {string} Meaningful short code
 */
export const generateMeaningfulCode = (campaign, medium) => {
  // Clean and shorten campaign name
  const cleanCampaign = campaign
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 10);
  
  // Clean and shorten medium
  const cleanMedium = medium
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 6);
  
  // Generate random suffix
  const randomSuffix = crypto.randomBytes(2).toString('hex');
  
  return `${cleanCampaign}-${cleanMedium}-${randomSuffix}`;
};

/**
 * Create a short URL
 * @param {Object} options - URL options
 * @param {string} options.originalUrl - Original URL
 * @param {string} [options.shortCode] - Custom short code (optional)
 * @param {string} [options.utmSource] - UTM source
 * @param {string} [options.utmMedium] - UTM medium
 * @param {string} [options.utmCampaign] - UTM campaign
 * @param {string} [options.utmTerm] - UTM term
 * @param {string} [options.utmContent] - UTM content
 * @param {string} [options.userId] - User ID who created it
 * @param {Date} [options.expiresAt] - Expiration date
 * @param {boolean} [options.useMeaningfulCode] - Use meaningful code instead of random
 * @returns {Promise<Object>} Created short URL
 */
export const createShortUrl = async ({
  originalUrl,
  shortCode,
  utmSource,
  utmMedium,
  utmCampaign,
  utmTerm,
  utmContent,
  userId,
  expiresAt,
  useMeaningfulCode = false,
}) => {
  if (!originalUrl) {
    throw new Error('Original URL is required');
  }

  // Generate short code if not provided
  let code = shortCode;
  if (!code) {
    if (useMeaningfulCode && utmCampaign && utmMedium) {
      code = generateMeaningfulCode(utmCampaign, utmMedium);
    } else {
      code = generateShortCode(6);
    }
  }

  // Ensure code is unique
  const pool = getPool();
  let attempts = 0;
  let finalCode = code;
  while (attempts < 10) {
    const [existing] = await pool.execute(
      'SELECT id FROM short_urls WHERE short_code = ?',
      [finalCode]
    );
    if (!existing || existing.length === 0) {
      break;
    }
    // If code exists, append random suffix
    finalCode = `${code}-${crypto.randomBytes(2).toString('hex')}`;
    attempts++;
  }

  if (attempts >= 10) {
    throw new Error('Failed to generate unique short code');
  }

  // Create short URL
  const shortUrlId = uuidv4();
  await pool.execute(
    `INSERT INTO short_urls (
      id, short_code, original_url, utm_source, utm_medium, utm_campaign,
      utm_term, utm_content, created_by, expires_at, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      shortUrlId,
      finalCode,
      originalUrl,
      utmSource || null,
      utmMedium || null,
      utmCampaign || null,
      utmTerm || null,
      utmContent || null,
      userId || null,
      expiresAt || null,
      true,
    ]
  );

  // Fetch created short URL
  const [rows] = await pool.execute(
    'SELECT * FROM short_urls WHERE id = ?',
    [shortUrlId]
  );

  return rows[0];
};

/**
 * Get short URL by code and increment click count
 * @param {string} shortCode - Short code
 * @param {Object} [clickData] - Click tracking data
 * @param {string} [clickData.ipAddress] - IP address
 * @param {string} [clickData.userAgent] - User agent
 * @param {string} [clickData.referer] - Referer
 * @returns {Promise<Object>} Short URL with UTM parameters
 */
export const getShortUrl = async (shortCode, clickData = {}) => {
  const pool = getPool();
  const [rows] = await pool.execute(
    'SELECT * FROM short_urls WHERE short_code = ? AND is_active = ?',
    [shortCode, true]
  );

  if (!rows || rows.length === 0) {
    return null;
  }

  const shortUrl = rows[0];

  // Check if expired
  if (shortUrl.expires_at && new Date() > new Date(shortUrl.expires_at)) {
    return null;
  }

  // Increment click count
  await pool.execute(
    'UPDATE short_urls SET click_count = click_count + 1, updated_at = NOW() WHERE id = ?',
    [shortUrl.id]
  );

  // Add click record to short_url_clicks table
  if (clickData.ipAddress || clickData.userAgent || clickData.referer) {
    const clickId = uuidv4();
    await pool.execute(
      `INSERT INTO short_url_clicks (
        id, short_url_id, clicked_at, ip_address, user_agent, referer
      ) VALUES (?, ?, NOW(), ?, ?, ?)`,
      [
        clickId,
        shortUrl.id,
        clickData.ipAddress || null,
        clickData.userAgent || null,
        clickData.referer || null,
      ]
    );
  }

  // Fetch updated short URL
  const [updatedRows] = await pool.execute(
    'SELECT * FROM short_urls WHERE id = ?',
    [shortUrl.id]
  );

  return updatedRows[0];
};

/**
 * Create or update a long URL record (without short code)
 * @param {Object} options - URL options
 * @param {string} options.originalUrl - Original URL
 * @param {string} [options.utmSource] - UTM source
 * @param {string} [options.utmMedium] - UTM medium
 * @param {string} [options.utmCampaign] - UTM campaign
 * @param {string} [options.utmTerm] - UTM term
 * @param {string} [options.utmContent] - UTM content
 * @param {string} [options.userId] - User ID who created it
 * @returns {Promise<Object>} Created or updated URL record
 */
export const createOrUpdateLongUrl = async ({
  originalUrl,
  utmSource,
  utmMedium,
  utmCampaign,
  utmTerm,
  utmContent,
  userId,
}) => {
  if (!originalUrl) {
    throw new Error('Original URL is required');
  }

  const pool = getPool();

  // Check if a record with this URL already exists (without short code)
  const [existing] = await pool.execute(
    'SELECT * FROM short_urls WHERE original_url = ? AND short_code IS NULL AND created_by = ?',
    [originalUrl, userId]
  );

  if (existing && existing.length > 0) {
    // Update existing record
    await pool.execute(
      `UPDATE short_urls SET
        utm_source = ?, utm_medium = ?, utm_campaign = ?,
        utm_term = ?, utm_content = ?, updated_at = NOW()
      WHERE id = ?`,
      [
        utmSource || null,
        utmMedium || null,
        utmCampaign || null,
        utmTerm || null,
        utmContent || null,
        existing[0].id,
      ]
    );

    // Fetch updated record
    const [updated] = await pool.execute(
      'SELECT * FROM short_urls WHERE id = ?',
      [existing[0].id]
    );
    return updated[0];
  }

  // Create new record without short code
  const urlRecordId = uuidv4();
  await pool.execute(
    `INSERT INTO short_urls (
      id, original_url, utm_source, utm_medium, utm_campaign,
      utm_term, utm_content, created_by, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      urlRecordId,
      originalUrl,
      utmSource || null,
      utmMedium || null,
      utmCampaign || null,
      utmTerm || null,
      utmContent || null,
      userId || null,
      true,
    ]
  );

  // Fetch created record
  const [rows] = await pool.execute(
    'SELECT * FROM short_urls WHERE id = ?',
    [urlRecordId]
  );

  return rows[0];
};

/**
 * Update existing URL record to add short code
 * @param {string} originalUrl - Original URL to find
 * @param {string} shortCode - Short code to add
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Updated URL record
 */
export const addShortCodeToUrl = async (originalUrl, shortCode, userId) => {
  const pool = getPool();

  // Find existing record by original URL and user
  const [rows] = await pool.execute(
    'SELECT * FROM short_urls WHERE original_url = ? AND created_by = ?',
    [originalUrl, userId]
  );

  if (!rows || rows.length === 0) {
    throw new Error('URL record not found');
  }

  const urlRecord = rows[0];

  // Check if short code already exists
  const [existingCode] = await pool.execute(
    'SELECT id FROM short_urls WHERE short_code = ?',
    [shortCode]
  );

  if (existingCode && existingCode.length > 0 && existingCode[0].id !== urlRecord.id) {
    throw new Error('Short code already exists');
  }

  // Update with short code
  await pool.execute(
    'UPDATE short_urls SET short_code = ?, updated_at = NOW() WHERE id = ?',
    [shortCode, urlRecord.id]
  );

  // Fetch updated record
  const [updated] = await pool.execute(
    'SELECT * FROM short_urls WHERE id = ?',
    [urlRecord.id]
  );

  return updated[0];
};

/**
 * Build UTM-tracked URL
 * @param {Object} options - UTM parameters
 * @param {string} options.baseUrl - Base URL
 * @param {string} [options.utmSource] - UTM source
 * @param {string} [options.utmMedium] - UTM medium
 * @param {string} [options.utmCampaign] - UTM campaign
 * @param {string} [options.utmTerm] - UTM term
 * @param {string} [options.utmContent] - UTM content
 * @returns {string} URL with UTM parameters
 */
export const buildUtmUrl = ({
  baseUrl,
  utmSource,
  utmMedium,
  utmCampaign,
  utmTerm,
  utmContent,
  redirect = false, // Add redirect parameter (false for long URLs, true for short URLs)
}) => {
  const url = new URL(baseUrl);
  
  if (utmSource) url.searchParams.set('utm_source', utmSource);
  if (utmMedium) url.searchParams.set('utm_medium', utmMedium);
  if (utmCampaign) url.searchParams.set('utm_campaign', utmCampaign);
  if (utmTerm) url.searchParams.set('utm_term', utmTerm);
  if (utmContent) url.searchParams.set('utm_content', utmContent);
  
  // Add redirect parameter: false for long URLs (will be counted at lead form), true for short URLs (already counted at redirect)
  url.searchParams.set('redirect', redirect ? 'true' : 'false');
  
  return url.toString();
};

