/**
 * In-memory cache for GET /api/leads/analytics/users (getUserAnalytics).
 * Exported so maintenance scripts can clear it after bulk lead/call_status updates.
 */

export const USER_ANALYTICS_CACHE_MS = Number(
  process.env.USER_ANALYTICS_CACHE_MS || process.env.ANALYTICS_CACHE_MS || 600000
);
export const MAX_USER_ANALYTICS_CACHE_ENTRIES = Number(process.env.MAX_USER_ANALYTICS_CACHE_ENTRIES || 200);

export const analyticsCache = new Map();

export function clearUserAnalyticsCache() {
  const n = analyticsCache.size;
  analyticsCache.clear();
  return n;
}
