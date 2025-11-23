import { successResponse, errorResponse } from '../utils/response.util.js';
import { buildUtmUrl, createShortUrl, getShortUrl } from '../services/urlShortener.service.js';
import ShortUrl from '../models/ShortUrl.model.js';
import { hasElevatedAdminPrivileges } from '../utils/role.util.js';
import crypto from 'crypto';

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

    // Store long URL in database (without short code)
    const { createOrUpdateLongUrl } = await import('../services/urlShortener.service.js');
    const urlRecord = await createOrUpdateLongUrl({
      originalUrl: utmUrl,
      utmSource,
      utmMedium,
      utmCampaign,
      utmTerm,
      utmContent,
      userId: req.user._id,
    });

    return successResponse(
      res,
      {
        url: utmUrl,
        urlId: urlRecord._id,
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

    // Check if long URL already exists
    const { addShortCodeToUrl, createOrUpdateLongUrl } = await import('../services/urlShortener.service.js');
    let shortUrl;

    // Try to find existing long URL record
    const existingUrl = await ShortUrl.findOne({
      originalUrl: fullUrl,
      createdBy: req.user._id,
    });

    if (existingUrl && !existingUrl.shortCode) {
      // Update existing long URL with short code
      const { generateShortCode, generateMeaningfulCode } = await import('../services/urlShortener.service.js');
      
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
        const existing = await ShortUrl.findOne({ shortCode: finalCode });
        if (!existing) {
          break;
        }
        finalCode = `${code}-${crypto.randomBytes(2).toString('hex')}`;
        attempts++;
      }

      if (attempts >= 10) {
        throw new Error('Failed to generate unique short code');
      }

      // Update existing record
      existingUrl.shortCode = finalCode;
      if (expiresAt) existingUrl.expiresAt = new Date(expiresAt);
      await existingUrl.save();
      shortUrl = existingUrl;
    } else if (existingUrl && existingUrl.shortCode) {
      // Short URL already exists - return it
      shortUrl = existingUrl;
    } else {
      // Create new short URL
      shortUrl = await createShortUrl({
        originalUrl: fullUrl,
        shortCode,
        utmSource,
        utmMedium,
        utmCampaign,
        utmTerm,
        utmContent,
        userId: req.user._id,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        useMeaningfulCode: useMeaningfulCode || false,
      });
    }

    // Get frontend URL from environment
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const shortUrlLink = `${frontendUrl}/s/${shortUrl.shortCode}`;

    return successResponse(
      res,
      {
        shortUrl: shortUrlLink,
        shortCode: shortUrl.shortCode,
        originalUrl: fullUrl,
        utmParams: {
          utmSource: shortUrl.utmSource,
          utmMedium: shortUrl.utmMedium,
          utmCampaign: shortUrl.utmCampaign,
          utmTerm: shortUrl.utmTerm,
          utmContent: shortUrl.utmContent,
        },
      clickCount: shortUrl.clickCount,
      expiresAt: shortUrl.expiresAt,
      clicks: shortUrl.clicks || [],
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

    const urlRecord = await ShortUrl.findById(urlId)
      .populate('createdBy', 'name email')
      .lean();

    if (!urlRecord) {
      return errorResponse(res, 'URL record not found', 404);
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const shortUrlLink = urlRecord.shortCode
      ? `${frontendUrl}/s/${urlRecord.shortCode}`
      : null;

    // Sort clicks by date (newest first)
    const clicks = (urlRecord.clicks || []).sort(
      (a, b) => new Date(b.clickedAt).getTime() - new Date(a.clickedAt).getTime()
    );

    return successResponse(
      res,
      {
        url: {
          _id: urlRecord._id,
          originalUrl: urlRecord.originalUrl,
          shortUrl: shortUrlLink,
          shortCode: urlRecord.shortCode,
          utmSource: urlRecord.utmSource,
          utmMedium: urlRecord.utmMedium,
          utmCampaign: urlRecord.utmCampaign,
          utmTerm: urlRecord.utmTerm,
          utmContent: urlRecord.utmContent,
          clickCount: urlRecord.clickCount || 0,
          createdAt: urlRecord.createdAt,
          updatedAt: urlRecord.updatedAt,
        },
        clicks,
        analytics: {
          totalClicks: clicks.length,
          clicksToday: clicks.filter(
            (c) => new Date(c.clickedAt).toDateString() === new Date().toDateString()
          ).length,
          clicksThisWeek: clicks.filter((c) => {
            const clickDate = new Date(c.clickedAt);
            const weekAgo = new Date();
            weekAgo.setDate(weekAgo.getDate() - 7);
            return clickDate >= weekAgo;
          }).length,
          clicksThisMonth: clicks.filter((c) => {
            const clickDate = new Date(c.clickedAt);
            const monthAgo = new Date();
            monthAgo.setMonth(monthAgo.getMonth() - 1);
            return clickDate >= monthAgo;
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

    // Find URL record by original URL (without redirect parameter)
    const baseUrl = originalUrl.split('?')[0];
    const urlParams = new URLSearchParams(originalUrl.split('?')[1] || '');
    
    // Remove redirect parameter for matching
    urlParams.delete('redirect');
    const urlWithoutRedirect = urlParams.toString() 
      ? `${baseUrl}?${urlParams.toString()}`
      : baseUrl;

    // Find matching URL record
    const urlRecord = await ShortUrl.findOne({
      $or: [
        { originalUrl: urlWithoutRedirect },
        { originalUrl: { $regex: urlWithoutRedirect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } },
      ],
    });

    if (!urlRecord) {
      // URL not found in database, return success anyway (not critical)
      return successResponse(res, { tracked: false }, 'Click tracking attempted', 200);
    }

    // Track click with metadata
    const clickData = {
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent'),
      referer: req.get('referer'),
    };

    urlRecord.clickCount = (urlRecord.clickCount || 0) + 1;
    urlRecord.clicks.push({
      clickedAt: new Date(),
      ipAddress: clickData.ipAddress,
      userAgent: clickData.userAgent,
      referer: clickData.referer,
    });
    await urlRecord.save();

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

    // Track click with metadata
    const clickData = {
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent'),
      referer: req.get('referer'),
    };

    const shortUrl = await getShortUrl(shortCode, clickData);

    if (!shortUrl) {
      return errorResponse(res, 'Short URL not found or expired', 404);
    }

    // Update the original URL to include redirect=true parameter
    // This tells the lead form NOT to count the click (since we already counted it at redirect)
    const redirectUrl = new URL(shortUrl.originalUrl);
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

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Get all URLs (including long URLs without short codes) for current user
    const shortUrls = await ShortUrl.find({
      createdBy: req.user._id,
    })
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await ShortUrl.countDocuments({
      createdBy: req.user._id,
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const shortUrlsWithLinks = shortUrls.map((url) => ({
      ...url,
      shortUrl: url.shortCode ? `${frontendUrl}/s/${url.shortCode}` : null,
    }));

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

