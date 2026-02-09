/**
 * Fuzzy string matching for district/mandal names.
 * Handles spelling mistakes and case differences when mapping leads to master data.
 */

/**
 * Levenshtein distance between two strings.
 */
function levenshtein(a, b) {
  if (!a || !b) return Math.max((a || '').length, (b || '').length);
  const m = a.length;
  const n = b.length;
  const dp = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/**
 * Similarity ratio (0–1): 1 = identical, 0 = completely different.
 * Uses 1 - (levenshtein / maxLen) for short strings.
 */
export function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const sa = String(a);
  const sb = String(b);
  if (sa === sb) return 1;
  const maxLen = Math.max(sa.length, sb.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(sa, sb);
  return 1 - dist / maxLen;
}

/**
 * Find best matching candidate from a list of strings.
 * @param {string} input - The value to match (e.g. "Teneli" from lead)
 * @param {string[]|Set<string>|Map} candidates - Master names to match against
 * @param {number} threshold - Minimum similarity (0–1) to accept. Default 0.85
 * @returns {string|null} Best matching candidate or null if none above threshold
 */
export function findBestMatch(input, candidates, threshold = 0.85) {
  if (!input || input.trim() === '') return null;
  const arr = Array.isArray(candidates)
    ? candidates
    : candidates instanceof Set
      ? [...candidates]
      : candidates instanceof Map
        ? [...candidates.keys()]
        : typeof candidates?.[Symbol.iterator] === 'function'
          ? [...candidates]
          : [];
  if (arr.length === 0) return null;

  const inputNorm = String(input).trim().toLowerCase();
  let best = null;
  let bestScore = threshold;

  for (const c of arr) {
    const candidate = String(c).trim().toLowerCase();
    if (candidate === inputNorm) return candidate;
    const score = similarity(inputNorm, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}
