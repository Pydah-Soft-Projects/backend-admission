import { successResponse, errorResponse } from '../utils/response.util.js';
import { buildUtmUrl } from '../services/urlShortener.service.js';
import { getPool } from '../config-sql/database.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// Helper functions for short code generation (from service)
const generateShortCode = (length = 6) => {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
};

const generateMeaningfulCode = (campaign, medium) => {
  const cleanCampaign = campaign
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 10);
  const cleanMedium = medium
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 6);
  const randomSuffix = crypto.randomBytes(2).toString('hex');
  return `${cleanCampaign}-${cleanMedium}-${randomSuffix}`;
};

// Helper function to format short URL data
const formatShortUrl = (urlData, clicks = []) => {
  if (!urlData) return null;
  return {
    id: urlData.id,
    _id: urlData.id,
    shortCode: urlData.short_code,
    originalUrl: urlData.original_url,
    utmSource: urlData.utm_source,
    utmMedium: urlData.utm_medium,
    utmCampaign: urlData.utm_campaign,
    utmTerm: urlData.utm_term,
    utmContent: urlData.utm_content,
    clickCount: urlData.click_count || 0,
    createdBy: urlData.created_by,
    isActive: urlData.is_active === 1 || urlData.is_active === true,
    expiresAt: urlData.expires_at,
    createdAt: urlData.created_at,
    updatedAt: urlData.updated_at,
    clicks: clicks.map(c => ({
      clickedAt: c.clicked_at,
      ipAddress: c.ip_address,
      userAgent: c.user_agent,
      referer: c.referer,
    })),
  };
};

/**
 * @desc    Build UTM-tracked URL
 * @route   POST /api/utm/build-url
 * @access  Private (Super Admin)
 */
export const buildUtmTrackedUrl = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only.', 403);
    }

    const { baseUrl, utmSource, utmMedium, utmCampaign, utmTerm, utmContent } = req.body;

    if (!baseUrl) {
      return errorResponse(res, 'Base URL is required', 400);
    }

    // Build UTM URL with redirect=false (long URL - will be counted at lead form)
    const utmUrl = buildUtmUrl({
      baseUrl,
      utmSource,
      utmMedium,
      utmCampaign,
      utmTerm,
      utmContent,
      redirect: false, // Long URLs: redirect=false means lead form will count the click
    });

    const pool = getPool();
    const userId = req.user.id || req.user._id;

    // Check if a record with this URL already exists (without short code)
    const [existing] = await pool.execute(
      'SELECT * FROM short_urls WHERE original_url = ? AND short_code IS NULL AND created_by = ?',
      [utmUrl, userId]
    );

    let urlRecord;
    if (existing.length > 0) {
      // Update existing record
      await pool.execute(
        `UPDATE short_urls SET 
          utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_term = ?, utm_content = ?, updated_at = NOW()
         WHERE id = ?`,
        [utmSource || null, utmMedium || null, utmCampaign || null, utmTerm || null, utmContent || null, existing[0].id]
      );
      urlRecord = existing[0];
    } else {
      // Create new record without short code
      const urlId = uuidv4();
      await pool.execute(
        `INSERT INTO short_urls (
          id, original_url, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          click_count, created_by, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          urlId,
          utmUrl,
          utmSource || null,
          utmMedium || null,
          utmCampaign || null,
          utmTerm || null,
          utmContent || null,
          0,
          userId,
          true,
        ]
      );
      const [newRecord] = await pool.execute('SELECT * FROM short_urls WHERE id = ?', [urlId]);
      urlRecord = newRecord[0];
    }

    return successResponse(
      res,
      {
        url: utmUrl,
        urlId: urlRecord.id,
      },
      'UTM URL built successfully',
      200
    );
  } catch (error) {
    console.error('Error building UTM URL:', error);
    return errorResponse(res, error.message || 'Failed to build UTM URL', 500);
  }
};

/**
 * @desc    Create short URL with UTM parameters
 * @route   POST /api/utm/shorten
 * @access  Private (Super Admin)
 */
export const shortenUtmUrl = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only.', 403);
    }

    const {
      baseUrl,
      utmSource,
      utmMedium,
      utmCampaign,
      utmTerm,
      utmContent,
      shortCode,
      useMeaningfulCode,
      expiresAt,
    } = req.body;

    if (!baseUrl) {
      return errorResponse(res, 'Base URL is required', 400);
    }

    // Build full UTM URL first with redirect=false (will be updated to redirect=true when redirecting)
    const fullUrl = buildUtmUrl({
      baseUrl,
      utmSource,
      utmMedium,
      utmCampaign,
      utmTerm,
      utmContent,
      redirect: false, // Initial URL stored with redirect=false
    });

    const pool = getPool();
    const userId = req.user.id || req.user._id;

    // Try to find existing long URL record
    const [existingUrls] = await pool.execute(
      'SELECT * FROM short_urls WHERE original_url = ? AND created_by = ?',
      [fullUrl, userId]
    );

    let shortUrl;
    if (existingUrls.length > 0 && !existingUrls[0].short_code) {
      // Update existing long URL with short code
      // Generate short code
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
        const [existing] = await pool.execute(
          'SELECT id FROM short_urls WHERE short_code = ?',
          [finalCode]
        );
        if (existing.length === 0) {
          break;
        }
        finalCode = `${code}-${crypto.randomBytes(2).toString('hex')}`;
        attempts++;
      }

      if (attempts >= 10) {
        throw new Error('Failed to generate unique short code');
      }

      // Update existing record
      const updateFields = ['short_code = ?', 'updated_at = NOW()'];
      const updateValues = [finalCode];
      
      if (expiresAt) {
        updateFields.splice(1, 0, 'expires_at = ?');
        updateValues.push(new Date(expiresAt).toISOString().slice(0, 19).replace('T', ' '));
      }
      
      updateValues.push(existingUrls[0].id);
      await pool.execute(
        `UPDATE short_urls SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );
      
      const [updated] = await pool.execute('SELECT * FROM short_urls WHERE id = ?', [existingUrls[0].id]);
      shortUrl = updated[0];
    } else if (existingUrls.length > 0 && existingUrls[0].short_code) {
      // Short URL already exists - return it
      shortUrl = existingUrls[0];
    } else {
      // Create new short URL
      // Generate short code
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
        const [existing] = await pool.execute(
          'SELECT id FROM short_urls WHERE short_code = ?',
          [finalCode]
        );
        if (existing.length === 0) {
          break;
        }
        finalCode = `${code}-${crypto.randomBytes(2).toString('hex')}`;
        attempts++;
      }

      if (attempts >= 10) {
        throw new Error('Failed to generate unique short code');
      }

      const urlId = uuidv4();
      await pool.execute(
        `INSERT INTO short_urls (
          id, short_code, original_url, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          click_count, created_by, is_active, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          urlId,
          finalCode,
          fullUrl,
          utmSource || null,
          utmMedium || null,
          utmCampaign || null,
          utmTerm || null,
          utmContent || null,
          0,
          userId,
          true,
          expiresAt ? new Date(expiresAt).toISOString().slice(0, 19).replace('T', ' ') : null,
        ]
      );
      
      const [newUrl] = await pool.execute('SELECT * FROM short_urls WHERE id = ?', [urlId]);
      shortUrl = newUrl[0];
    }

    // Get clicks for this URL
    const [clicks] = await pool.execute(
      'SELECT * FROM short_url_clicks WHERE short_url_id = ? ORDER BY clicked_at DESC',
      [shortUrl.id]
    );

    const formattedUrl = formatShortUrl(shortUrl, clicks);

    // Get frontend URL from environment
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const shortUrlLink = `${frontendUrl}/s/${formattedUrl.shortCode}`;

    return successResponse(
      res,
      {
        shortUrl: shortUrlLink,
        shortCode: formattedUrl.shortCode,
        originalUrl: fullUrl,
        utmParams: {
          utmSource: formattedUrl.utmSource,
          utmMedium: formattedUrl.utmMedium,
          utmCampaign: formattedUrl.utmCampaign,
          utmTerm: formattedUrl.utmTerm,
          utmContent: formattedUrl.utmContent,
        },
        clickCount: formattedUrl.clickCount,
        expiresAt: formattedUrl.expiresAt,
        clicks: formattedUrl.clicks || [],
      },
      'Short URL created successfully',
      201
    );
  } catch (error) {
    console.error('Error creating short URL:', error);
    return errorResponse(res, error.message || 'Failed to create short URL', 500);
  }
};

/**
 * @desc    Get URL analytics with click timeline
 * @route   GET /api/utm/analytics/:urlId
 * @access  Private (Super Admin)
 */
export const getUrlAnalytics = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only.', 403);
    }

    const { urlId } = req.params;
    const pool = getPool();

    // Get URL record with user info
    const [urlRecords] = await pool.execute(
      `SELECT s.*, u.name as created_by_name, u.email as created_by_email
       FROM short_urls s
       LEFT JOIN users u ON s.created_by = u.id
       WHERE s.id = ?`,
      [urlId]
    );

    if (urlRecords.length === 0) {
      return errorResponse(res, 'URL record not found', 404);
    }

    const urlRecord = urlRecords[0];

    // Get clicks
    const [clicks] = await pool.execute(
      'SELECT * FROM short_url_clicks WHERE short_url_id = ? ORDER BY clicked_at DESC',
      [urlId]
    );

    const formattedClicks = clicks.map(c => ({
      clickedAt: c.clicked_at,
      ipAddress: c.ip_address,
      userAgent: c.user_agent,
      referer: c.referer,
    }));

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const shortUrlLink = urlRecord.short_code
      ? `${frontendUrl}/s/${urlRecord.short_code}`
      : null;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    return successResponse(
      res,
      {
        url: {
          _id: urlRecord.id,
          id: urlRecord.id,
          originalUrl: urlRecord.original_url,
          shortUrl: shortUrlLink,
          shortCode: urlRecord.short_code,
          utmSource: urlRecord.utm_source,
          utmMedium: urlRecord.utm_medium,
          utmCampaign: urlRecord.utm_campaign,
          utmTerm: urlRecord.utm_term,
          utmContent: urlRecord.utm_content,
          clickCount: urlRecord.click_count || 0,
          createdAt: urlRecord.created_at,
          updatedAt: urlRecord.updated_at,
        },
        clicks: formattedClicks,
        analytics: {
          totalClicks: formattedClicks.length,
          clicksToday: formattedClicks.filter(
            (c) => new Date(c.clickedAt) >= today
          ).length,
          clicksThisWeek: formattedClicks.filter((c) => {
            return new Date(c.clickedAt) >= weekAgo;
          }).length,
          clicksThisMonth: formattedClicks.filter((c) => {
            return new Date(c.clickedAt) >= monthAgo;
          }).length,
        },
      },
      'URL analytics retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting URL analytics:', error);
    return errorResponse(res, error.message || 'Failed to get URL analytics', 500);
  }
};

/**
 * @desc    Track click on long URL (from lead form)
 * @route   POST /api/utm/track-click
 * @access  Public
 */
export const trackLongUrlClick = async (req, res) => {
  try {
    const { originalUrl } = req.body;

    if (!originalUrl) {
      return errorResponse(res, 'Original URL is required', 400);
    }

    const pool = getPool();

    // Find URL record by original URL (without redirect parameter)
    const baseUrl = originalUrl.split('?')[0];
    const urlParams = new URLSearchParams(originalUrl.split('?')[1] || '');
    
    // Remove redirect parameter for matching
    urlParams.delete('redirect');
    const urlWithoutRedirect = urlParams.toString() 
      ? `${baseUrl}?${urlParams.toString()}`
      : baseUrl;

    // Find matching URL record
    const [urlRecords] = await pool.execute(
      'SELECT * FROM short_urls WHERE original_url = ? OR original_url LIKE ?',
      [urlWithoutRedirect, `${urlWithoutRedirect}%`]
    );

    if (urlRecords.length === 0) {
      // URL not found in database, return success anyway (not critical)
      return successResponse(res, { tracked: false }, 'Click tracking attempted', 200);
    }

    const urlRecord = urlRecords[0];

    // Track click with metadata
    const clickData = {
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent'),
      referer: req.get('referer'),
    };

    // Increment click count
    await pool.execute(
      'UPDATE short_urls SET click_count = click_count + 1, updated_at = NOW() WHERE id = ?',
      [urlRecord.id]
    );

    // Insert click record
    const clickId = uuidv4();
    await pool.execute(
      `INSERT INTO short_url_clicks (id, short_url_id, clicked_at, ip_address, user_agent, referer)
       VALUES (?, ?, NOW(), ?, ?, ?)`,
      [
        clickId,
        urlRecord.id,
        clickData.ipAddress || null,
        clickData.userAgent || null,
        clickData.referer || null,
      ]
    );

    return successResponse(res, { tracked: true }, 'Click tracked successfully', 200);
  } catch (error) {
    console.error('Error tracking long URL click:', error);
    // Don't fail the request if tracking fails
    return successResponse(res, { tracked: false }, 'Click tracking attempted', 200);
  }
};

/**
 * @desc    Redirect short URL to original URL with UTM parameters
 * @route   GET /api/utm/redirect/:shortCode
 * @access  Public
 */
export const redirectShortUrl = async (req, res) => {
  try {
    const { shortCode } = req.params;

    if (!shortCode) {
      return errorResponse(res, 'Short code is required', 400);
    }

    const pool = getPool();

    // Get short URL
    const [shortUrls] = await pool.execute(
      'SELECT * FROM short_urls WHERE short_code = ? AND is_active = ?',
      [shortCode, true]
    );

    if (shortUrls.length === 0) {
      return errorResponse(res, 'Short URL not found or expired', 404);
    }

    const shortUrl = shortUrls[0];

    // Check if expired
    if (shortUrl.expires_at && new Date() > new Date(shortUrl.expires_at)) {
      return errorResponse(res, 'Short URL not found or expired', 404);
    }

    // Track click with metadata
    const clickData = {
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent'),
      referer: req.get('referer'),
    };

    // Increment click count
    await pool.execute(
      'UPDATE short_urls SET click_count = click_count + 1, updated_at = NOW() WHERE id = ?',
      [shortUrl.id]
    );

    // Insert click record
    const clickId = uuidv4();
    await pool.execute(
      `INSERT INTO short_url_clicks (id, short_url_id, clicked_at, ip_address, user_agent, referer)
       VALUES (?, ?, NOW(), ?, ?, ?)`,
      [
        clickId,
        shortUrl.id,
        clickData.ipAddress || null,
        clickData.userAgent || null,
        clickData.referer || null,
      ]
    );

    // Update the original URL to include redirect=true parameter
    // This tells the lead form NOT to count the click (since we already counted it at redirect)
    const redirectUrl = new URL(shortUrl.original_url);
    redirectUrl.searchParams.set('redirect', 'true');
    
    // Redirect to original URL with redirect=true parameter
    return res.redirect(302, redirectUrl.toString());
  } catch (error) {
    console.error('Error redirecting short URL:', error);
    return errorResponse(res, error.message || 'Failed to redirect', 500);
  }
};

/**
 * @desc    Get all short URLs (for Super Admin)
 * @route   GET /api/utm/short-urls
 * @access  Private (Super Admin)
 */
export const getAllShortUrls = async (req, res) => {
  try {
    if (!hasElevatedAdminPrivileges(req.user.roleName)) {
      return errorResponse(res, 'Access denied. Super Admin only.', 403);
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = (page - 1) * limit;
    const pool = getPool();
    const userId = req.user.id || req.user._id;

    // Get total count
    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM short_urls WHERE created_by = ?',
      [userId]
    );
    const total = countResult[0].total;

    // Get all URLs (including long URLs without short codes) for current user
    // Note: Using string interpolation for LIMIT/OFFSET as mysql2 has issues with placeholders for these
    const [shortUrls] = await pool.execute(
      `SELECT s.*, u.name as created_by_name, u.email as created_by_email
       FROM short_urls s
       LEFT JOIN users u ON s.created_by = u.id
       WHERE s.created_by = ?
       ORDER BY s.created_at DESC
       LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      [userId]
    );

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const shortUrlsWithLinks = shortUrls.map((url) => {
      const formatted = formatShortUrl(url);
      return {
        ...formatted,
        shortUrl: formatted.shortCode ? `${frontendUrl}/s/${formatted.shortCode}` : null,
        createdBy: url.created_by_name ? {
          id: url.created_by,
          _id: url.created_by,
          name: url.created_by_name,
          email: url.created_by_email,
        } : url.created_by,
      };
    });

    return successResponse(
      res,
      {
        shortUrls: shortUrlsWithLinks,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
      'Short URLs retrieved successfully',
      200
    );
  } catch (error) {
    console.error('Error getting short URLs:', error);
    return errorResponse(res, error.message || 'Failed to get short URLs', 500);
  }
};

