import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { getTableColumnSet } from '../utils/secondarySchema.util.js';
import { normalizeJsonObject, resolveCourseLevelFromRow } from '../utils/secondaryCourseLevel.util.js';
import { fetchActiveStudentQuotas } from '../utils/studentQuotas.util.js';

const isMissingTableError = (err) =>
  err?.code === 'ER_NO_SUCH_TABLE' ||
  err?.errno === 1146 ||
  String(err?.sqlMessage || '').includes("doesn't exist");

/**
 * Active student quota catalog from secondary `student_quotas` (Course & Quota dropdown).
 */
export const listStudentQuotas = async (req, res) => {
  try {
    const quotas = await fetchActiveStudentQuotas();
    return successResponse(res, quotas);
  } catch (error) {
    console.error('listStudentQuotas error:', error);
    return errorResponse(res, error.message || 'Failed to load student quotas', 500);
  }
};

/**
 * Distinct program levels for the joining workspace dropdown.
 *
 * Merged (case-insensitive dedup) from:
 *  1. `student_database.courses.level` (or `program_level` / `metadata.level`)
 *  2. Top-level bucket keys of `student_database.settings.certificate_config`
 */
export const listCourseProgramLevels = async (req, res) => {
  try {
    const pool = getSecondaryPool();
    const levels = new Map(); // key: lower-cased label, value: original label

    const addLevel = (raw) => {
      if (raw == null) return;
      const trimmed = String(raw).trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (!levels.has(key)) levels.set(key, trimmed);
    };

    // ── 1. Levels declared on courses ─────────────────────────────────────────
    try {
      const cols = await getTableColumnSet(pool, 'courses');
      if (cols.size > 0) {
        if (cols.has('level')) {
          const [rows] = await pool.execute(
            `SELECT DISTINCT level AS v FROM courses WHERE is_active = 1 AND level IS NOT NULL AND TRIM(level) <> '' ORDER BY level ASC`
          );
          rows.forEach((r) => addLevel(r.v));
        } else if (cols.has('program_level')) {
          const [rows] = await pool.execute(
            `SELECT DISTINCT program_level AS v FROM courses WHERE is_active = 1 AND program_level IS NOT NULL AND TRIM(program_level) <> '' ORDER BY program_level ASC`
          );
          rows.forEach((r) => addLevel(r.v));
        } else if (cols.has('metadata')) {
          const [rows] = await pool.execute(
            `SELECT metadata FROM courses WHERE is_active = 1`
          );
          rows.forEach((row) => addLevel(resolveCourseLevelFromRow(row)));
        }
      }
    } catch (err) {
      if (!isMissingTableError(err)) {
        console.warn('[program-levels] courses lookup failed:', err.message || err);
      }
    }

    // ── 2. Bucket keys from settings.certificate_config ───────────────────────
    try {
      const settingsCols = await getTableColumnSet(pool, 'settings');
      if (settingsCols.size > 0) {
        const certRoot = await loadCertificateConfigObject(pool, settingsCols);
        if (certRoot && typeof certRoot === 'object') {
          for (const key of Object.keys(certRoot)) {
            if (Array.isArray(certRoot[key])) addLevel(key);
          }
        }
      }
    } catch (err) {
      if (!isMissingTableError(err)) {
        console.warn('[program-levels] settings.certificate_config lookup failed:', err.message || err);
      }
    }

    const result = Array.from(levels.values()).sort((a, b) => a.localeCompare(b));
    return successResponse(res, result);
  } catch (error) {
    console.error('listCourseProgramLevels error:', error);
    return errorResponse(res, error.message || 'Failed to load program levels', 500);
  }
};

function pickFirstExistingColumn(colSet, candidates) {
  return candidates.find((c) => colSet.has(c)) || null;
}

/**
 * Map CRM program level string to a top-level key inside certificate_config JSON.
 * @param {string} requestedLevel
 * @param {string[]} configKeys — keys present on parsed root (e.g. diploma, ug, pg)
 */
function mapLevelToCertificateConfigKey(requestedLevel, configKeys) {
  if (!requestedLevel || !Array.isArray(configKeys) || configKeys.length === 0) {
    return null;
  }
  const lowerKeys = new Map(configKeys.map((k) => [String(k).toLowerCase(), k]));
  const raw = String(requestedLevel).trim().toLowerCase().replace(/\s+/g, '_');
  if (lowerKeys.has(raw)) {
    return lowerKeys.get(raw);
  }
  const hay = String(requestedLevel).trim().toLowerCase();
  if (/(diploma|10th|intermediate|\binter\b|ssc)/i.test(hay) && lowerKeys.has('diploma')) {
    return lowerKeys.get('diploma');
  }
  if (/(^ug\b|under\s*grad|b\.?tech|b\.?e\b|btech|undergraduate)/i.test(hay) && lowerKeys.has('ug')) {
    return lowerKeys.get('ug');
  }
  if (/(^pg\b|post\s*grad|m\.?tech|mtech|mba|postgraduate)/i.test(hay) && lowerKeys.has('pg')) {
    return lowerKeys.get('pg');
  }
  for (const k of configKeys) {
    if (k && hay === String(k).toLowerCase()) return k;
  }
  return null;
}

function parseCertificateConfigRoot(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    try {
      const parsed = JSON.parse(t);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Load `certificate_config` from `student_database.settings`.
 *
 * The table is maintained outside this app, so we try the few sensible
 * `(key, value)` column conventions that appear in the wild. The row we want
 * is the one whose key equals `'certificate_config'`.
 */
async function loadCertificateConfigObject(pool, colSet) {
  const keyCols = ['setting_key', 'config_key', 'key', 'name'].filter((c) => colSet.has(c));
  const valueCols = ['value', 'setting_value', 'config_value', 'data'].filter((c) =>
    colSet.has(c)
  );

  for (const keyCol of keyCols) {
    for (const valueCol of valueCols) {
      if (keyCol === valueCol) continue;
      try {
        const [rows] = await pool.execute(
          `SELECT \`${valueCol}\` AS cfg_json FROM \`settings\` WHERE LOWER(TRIM(CAST(\`${keyCol}\` AS CHAR))) = 'certificate_config' LIMIT 1`
        );
        if (rows?.length) {
          const parsed = parseCertificateConfigRoot(rows[0].cfg_json);
          if (parsed) return parsed;
        }
      } catch (err) {
        if (err?.code === 'ER_BAD_FIELD_ERROR') continue;
        throw err;
      }
    }
  }

  return null;
}

/**
 * Certificate / document guidance from secondary `settings`, filtered by program level.
 * Prefers JSON `certificate_config` (diploma / ug / pg arrays). Falls back to legacy text rows.
 */
export const getCertificateGuidanceForLevel = async (req, res) => {
  try {
    const raw = req.query.level ?? req.params?.level;
    const level = raw != null ? String(raw).trim() : '';
    if (!level) {
      return successResponse(res, { level: '', body: '', format: 'text', matchedRows: 0, items: [] });
    }

    const pool = getSecondaryPool();
    let colSet;
    try {
      colSet = await getTableColumnSet(pool, 'settings');
    } catch (e) {
      if (isMissingTableError(e)) {
        return successResponse(res, { level, body: '', format: 'text', matchedRows: 0, items: [] });
      }
      throw e;
    }

    if (!colSet.size) {
      return successResponse(res, { level, body: '', format: 'text', matchedRows: 0, items: [] });
    }

    const certRoot = await loadCertificateConfigObject(pool, colSet);
    if (certRoot && typeof certRoot === 'object') {
      const configKeys = Object.keys(certRoot).filter((k) => Array.isArray(certRoot[k]));
      const bucketKey = mapLevelToCertificateConfigKey(level, configKeys);
      if (bucketKey) {
        const arr = certRoot[bucketKey];
        const items = (Array.isArray(arr) ? arr : [])
          .filter((x) => x && typeof x === 'object')
          .map((x) => ({
            id: String(x.id ?? ''),
            name: String(x.name ?? ''),
            required: Boolean(x.required),
            options: Array.isArray(x.options) ? x.options : [],
          }));
        return successResponse(res, {
          level,
          format: 'certificate_config',
          configKey: bucketKey,
          items,
          body: '',
          matchedRows: items.length,
        });
      }
      return successResponse(res, {
        level,
        format: 'certificate_config',
        configKey: null,
        items: [],
        body: '',
        matchedRows: 0,
      });
    }

    const levelCol = pickFirstExistingColumn(colSet, [
      'level',
      'program_level',
      'course_level',
      'student_level',
    ]);
    const bodyCol = pickFirstExistingColumn(colSet, [
      'certificate_information',
      'certificate_info',
      'certificate_text',
      'certificate_html',
      'content',
      'description',
      'value',
      'setting_value',
      'config_value',
    ]);

    if (levelCol && bodyCol) {
      const [rows] = await pool.execute(
        `SELECT \`${bodyCol}\` AS body FROM \`settings\` WHERE \`${levelCol}\` = ? LIMIT 10`,
        [level]
      );
      const parts = rows
        .map((r) => (r.body === undefined || r.body === null ? '' : String(r.body)))
        .map((s) => s.trim())
        .filter(Boolean);
      const body = parts.join('\n\n');
      const format = /certificate_html/i.test(bodyCol) ? 'html' : 'text';
      return successResponse(res, {
        level,
        body,
        format,
        matchedRows: parts.length,
      });
    }

    if (colSet.has('config_key') && colSet.has('config_value')) {
      const keys = [
        `certificate.${level}`,
        `certificate_info.${level}`,
        `certificates.${level}`,
        `level.${level}.certificates`,
      ];
      const placeholders = keys.map(() => '?').join(',');
      const [rows] = await pool.execute(
        `SELECT config_value AS body FROM \`settings\` WHERE config_key IN (${placeholders}) LIMIT 10`,
        keys
      );
      const parts = rows
        .map((r) => (r.body === undefined || r.body === null ? '' : String(r.body)))
        .map((s) => s.trim())
        .filter(Boolean);
      return successResponse(res, {
        level,
        body: parts.join('\n\n'),
        format: 'text',
        matchedRows: parts.length,
      });
    }

    if (colSet.has('metadata')) {
      const [rows] = await pool.execute(`SELECT metadata FROM \`settings\` LIMIT 200`);
      const chunks = [];
      for (const row of rows) {
        const meta = normalizeJsonObject(row.metadata);
        if (!meta) continue;
        const rowLevel = resolveCourseLevelFromRow(meta) || meta.level_id;
        if (rowLevel !== undefined && rowLevel !== null && String(rowLevel).trim() === level) {
          const text =
            meta.certificate_information ??
            meta.certificate_info ??
            meta.certificateText ??
            meta.body;
          if (text !== undefined && text !== null && String(text).trim()) {
            chunks.push(String(text).trim());
          }
        }
      }
      return successResponse(res, {
        level,
        body: chunks.join('\n\n'),
        format: 'text',
        matchedRows: chunks.length,
      });
    }

    return successResponse(res, { level, body: '', format: 'text', matchedRows: 0, items: [] });
  } catch (error) {
    if (isMissingTableError(error)) {
      return successResponse(res, {
        level: String(req.query.level || req.params?.level || '').trim(),
        body: '',
        format: 'text',
        matchedRows: 0,
        items: [],
      });
    }
    console.error('getCertificateGuidanceForLevel error:', error);
    return errorResponse(res, error.message || 'Failed to load certificate guidance', 500);
  }
};
