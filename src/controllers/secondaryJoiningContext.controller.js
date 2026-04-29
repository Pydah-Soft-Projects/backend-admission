import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { getTableColumnSet } from '../utils/secondarySchema.util.js';
import { normalizeJsonObject, resolveCourseLevelFromRow } from '../utils/secondaryCourseLevel.util.js';

const isMissingTableError = (err) =>
  err?.code === 'ER_NO_SUCH_TABLE' ||
  err?.errno === 1146 ||
  String(err?.sqlMessage || '').includes("doesn't exist");

/**
 * Distinct program levels from `courses` (active): `level` column or metadata.* keys.
 */
export const listCourseProgramLevels = async (req, res) => {
  try {
    const pool = getSecondaryPool();
    const cols = await getTableColumnSet(pool, 'courses');
    if (cols.size === 0) {
      return successResponse(res, []);
    }

    const levels = new Set();
    if (cols.has('level')) {
      const [rows] = await pool.execute(
        `SELECT DISTINCT level AS v FROM courses WHERE is_active = 1 AND level IS NOT NULL AND TRIM(level) <> '' ORDER BY level ASC`
      );
      rows.forEach((r) => {
        if (r.v != null && String(r.v).trim()) levels.add(String(r.v).trim());
      });
    } else if (cols.has('program_level')) {
      const [rows] = await pool.execute(
        `SELECT DISTINCT program_level AS v FROM courses WHERE is_active = 1 AND program_level IS NOT NULL AND TRIM(program_level) <> '' ORDER BY program_level ASC`
      );
      rows.forEach((r) => {
        if (r.v != null && String(r.v).trim()) levels.add(String(r.v).trim());
      });
    } else if (cols.has('metadata')) {
      const [rows] = await pool.execute(
        `SELECT metadata FROM courses WHERE is_active = 1`
      );
      rows.forEach((row) => {
        const lv = resolveCourseLevelFromRow(row);
        if (lv) levels.add(lv);
      });
    }

    return successResponse(res, Array.from(levels).sort((a, b) => a.localeCompare(b)));
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
 * Load `certificate_config` from student_database.settings (key/value style row).
 */
async function loadCertificateConfigObject(pool, colSet) {
  const keyCol = pickFirstExistingColumn(colSet, [
    'setting_key',
    'config_key',
    'key',
    'name',
    'slug',
    'code',
  ]);
  const valueCol = pickFirstExistingColumn(colSet, [
    'value',
    'setting_value',
    'config_value',
    'config_data',
    'data',
    'content',
    'json',
  ]);
  if (!keyCol || !valueCol) {
    return null;
  }
  const [rows] = await pool.execute(
    `SELECT \`${valueCol}\` AS cfg_json FROM \`settings\` WHERE LOWER(TRIM(CAST(\`${keyCol}\` AS CHAR))) = 'certificate_config' LIMIT 1`
  );
  if (!rows?.length) return null;
  return parseCertificateConfigRoot(rows[0].cfg_json);
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
