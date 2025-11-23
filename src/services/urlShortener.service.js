import ShortUrl from '../models/ShortUrl.model.js';
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
  let attempts = 0;
  let finalCode = code;
  while (attempts < 10) {
    const existing = await ShortUrl.findOne({ shortCode: finalCode });
    if (!existing) {
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
  const shortUrl = await ShortUrl.create({
    shortCode: finalCode,
    originalUrl,
    utmSource,
    utmMedium,
    utmCampaign,
    utmTerm,
    utmContent,
    createdBy: userId,
    expiresAt,
    isActive: true,
  });

  return shortUrl;
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
  const shortUrl = await ShortUrl.findOne({
    shortCode,
    isActive: true,
  });

  if (!shortUrl) {
    return null;
  }

  // Check if expired
  if (shortUrl.expiresAt && new Date() > shortUrl.expiresAt) {
    return null;
  }

  // Increment click count and add click record
  shortUrl.clickCount += 1;
  shortUrl.clicks.push({
    clickedAt: new Date(),
    ipAddress: clickData.ipAddress,
    userAgent: clickData.userAgent,
    referer: clickData.referer,
  });
  await shortUrl.save();

  return shortUrl;
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

  // Check if a record with this URL already exists (without short code)
  let urlRecord = await ShortUrl.findOne({
    originalUrl,
    shortCode: null,
    createdBy: userId,
  });

  if (urlRecord) {
    // Update existing record
    urlRecord.utmSource = utmSource;
    urlRecord.utmMedium = utmMedium;
    urlRecord.utmCampaign = utmCampaign;
    urlRecord.utmTerm = utmTerm;
    urlRecord.utmContent = utmContent;
    await urlRecord.save();
    return urlRecord;
  }

  // Create new record without short code
  urlRecord = await ShortUrl.create({
    originalUrl,
    utmSource,
    utmMedium,
    utmCampaign,
    utmTerm,
    utmContent,
    createdBy: userId,
    isActive: true,
    // shortCode is null for long URLs
  });

  return urlRecord;
};

/**
 * Update existing URL record to add short code
 * @param {string} originalUrl - Original URL to find
 * @param {string} shortCode - Short code to add
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Updated URL record
 */
export const addShortCodeToUrl = async (originalUrl, shortCode, userId) => {
  // Find existing record by original URL and user
  let urlRecord = await ShortUrl.findOne({
    originalUrl,
    createdBy: userId,
  });

  if (!urlRecord) {
    throw new Error('URL record not found');
  }

  // Check if short code already exists
  const existingCode = await ShortUrl.findOne({ shortCode });
  if (existingCode && existingCode._id.toString() !== urlRecord._id.toString()) {
    throw new Error('Short code already exists');
  }

  // Update with short code
  urlRecord.shortCode = shortCode;
  await urlRecord.save();

  return urlRecord;
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

