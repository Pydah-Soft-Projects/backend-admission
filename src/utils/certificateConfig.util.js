import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { getTableColumnSet } from './secondarySchema.util.js';

const isMissingTableError = (err) =>
  err?.code === 'ER_NO_SUCH_TABLE' ||
  err?.errno === 1146 ||
  String(err?.sqlMessage || '').includes("doesn't exist");

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
 * Map CRM program level string to a top-level key inside certificate_config JSON.
 * @param {string} requestedLevel
 * @param {string[]} configKeys
 */
export function mapLevelToCertificateConfigKey(requestedLevel, configKeys) {
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

/** Load secondary `settings.certificate_config` root object (or null). */
export async function loadCertificateConfigRoot() {
  try {
    const pool = getSecondaryPool();
    const colSet = await getTableColumnSet(pool, 'settings');
    if (!colSet?.size) return null;
    return await loadCertificateConfigObject(pool, colSet);
  } catch (err) {
    if (isMissingTableError(err)) return null;
    console.warn('[certificateConfig] load failed:', err?.message || err);
    return null;
  }
}

/**
 * Normalize certificate_config bucket into checklist items for a program level.
 * @returns {{ id: string, name: string, required: boolean }[]}
 */
export function getCertificateItemsForLevel(certRoot, programLevel) {
  if (!certRoot || typeof certRoot !== 'object') return [];
  const configKeys = Object.keys(certRoot).filter((k) => Array.isArray(certRoot[k]));
  const bucketKey = mapLevelToCertificateConfigKey(String(programLevel || '').trim(), configKeys);
  if (!bucketKey) return [];
  const arr = certRoot[bucketKey];
  return (Array.isArray(arr) ? arr : [])
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      id: String(x.id ?? x.name ?? '').trim(),
      name: String(x.name ?? x.id ?? '').trim(),
      required: Boolean(x.required),
    }))
    .filter((x) => x.id);
}

/** Same rules as frontend `parseCertificateChecklistEntry`. */
export function parseCertificateChecklistEntry(raw) {
  if (raw === 'received' || raw === 'pending') {
    return { status: raw };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw;
    const st = o.status === 'received' || o.status === 'pending' ? o.status : 'pending';
    const opt = typeof o.option === 'string' && o.option.trim() ? o.option.trim() : undefined;
    return { status: st, option: opt };
  }
  return { status: 'pending' };
}

function normalizeChecklistMap(raw) {
  if (!raw) return {};
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (Buffer.isBuffer(value)) {
    try {
      value = JSON.parse(value.toString('utf8'));
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

/**
 * Pending Important Documents labels from Step 2 certificate checklist (dynamic config).
 * Uses program-level certificate_config items when available; falls back to checklist keys.
 */
export function pendingImportantDocumentLabels({ checklistRaw, items }) {
  const map = normalizeChecklistMap(checklistRaw);
  const labels = [];

  if (Array.isArray(items) && items.length > 0) {
    for (const item of items) {
      const entry = parseCertificateChecklistEntry(map[item.id]);
      if (entry.status !== 'received') {
        labels.push(item.name || item.id);
      }
    }
    return labels;
  }

  // No config items for this level — still surface checklist entries that are pending.
  for (const [id, raw] of Object.entries(map)) {
    if (parseCertificateChecklistEntry(raw).status !== 'received') {
      labels.push(String(id));
    }
  }
  return labels;
}

/**
 * Important Documents considered complete (mirrors UI Verified rule):
 * all `required` items received; if none are required, treated as complete.
 */
export function importantDocumentsComplete({ checklistRaw, items }) {
  if (!Array.isArray(items) || items.length === 0) {
    return true;
  }
  const map = normalizeChecklistMap(checklistRaw);
  const required = items.filter((it) => it.required);
  const toCheck = required.length > 0 ? required : [];
  if (toCheck.length === 0) return true;
  return toCheck.every(
    (item) => parseCertificateChecklistEntry(map[item.id]).status === 'received'
  );
}
