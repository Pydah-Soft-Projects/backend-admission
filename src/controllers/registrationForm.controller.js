/**
 * Registration form definitions for joining / CRM reads.
 *
 * Primary admissions DB (DB_HOST / DB_NAME): `form_builder_forms` + `form_builder_fields` (see config-sql/schema.sql).
 *
 * Secondary student_database (DB_SECONDARY_*): may use either:
 *   - Same normalized tables (`form_builder_forms` / `form_builder_fields`), or
 *   - Single `forms` table with a JSON `form_fields` column (see Workbench: form_id, form_name, form_fields).
 *
 * REGISTRATION_FORM_SOURCE (default `auto`):
 *   - `auto` — secondary if a usable forms table exists; else primary.
 *   - `secondary` — only secondary (fails if no usable table).
 *   - `primary` — only primary admissions DB.
 *
 * Table names:
 *   Primary: PRIMARY_REGISTRATION_FORMS_TABLE / PRIMARY_REGISTRATION_FIELDS_TABLE (default form_builder_*).
 *   Secondary: SECONDARY_REGISTRATION_FORMS_TABLE or SECONDARY_FORM_TABLE_FORMS (optional).
 *     If unset on secondary, probes `forms` then `form_builder_forms`.
 *   SECONDARY_REGISTRATION_FIELDS_TABLE — only used for normalized secondary layout.
 *
 * Default slug for isDefault on embedded `forms` rows: SECONDARY_REGISTRATION_DEFAULT_FORM_ID (default `default_student_form`).
 */
import { getPool as getPrimaryPool } from '../config-sql/database.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

function safeSqlIdent(raw, fallback) {
  const s = String(raw ?? '').trim();
  if (!/^[a-zA-Z0-9_]+$/.test(s)) return fallback;
  return s;
}

const primaryFormsTable = safeSqlIdent(
  process.env.PRIMARY_REGISTRATION_FORMS_TABLE,
  'form_builder_forms'
);
const primaryFieldsTable = safeSqlIdent(
  process.env.PRIMARY_REGISTRATION_FIELDS_TABLE,
  'form_builder_fields'
);

const secondaryFieldsTable = safeSqlIdent(
  process.env.SECONDARY_REGISTRATION_FIELDS_TABLE || process.env.SECONDARY_FORM_TABLE_FIELDS,
  'form_builder_fields'
);

const defaultEmbeddedFormSlug =
  String(process.env.SECONDARY_REGISTRATION_DEFAULT_FORM_ID || 'default_student_form').trim() ||
  'default_student_form';

const secondaryConfigured = () =>
  Boolean(process.env.DB_SECONDARY_HOST && process.env.DB_SECONDARY_NAME);

const isMissingTableError = (err) =>
  err?.code === 'ER_NO_SUCH_TABLE' ||
  err?.errno === 1146 ||
  String(err?.sqlMessage || '').includes("doesn't exist");

async function probeTableExists(pool, tableName) {
  try {
    await pool.execute(`SELECT 1 FROM \`${tableName}\` LIMIT 1`);
    return true;
  } catch (e) {
    if (isMissingTableError(e)) return false;
    throw e;
  }
}

/** @param {import('mysql2/promise').Pool} secPool */
async function resolveSecondaryFormsTableName(secPool) {
  const explicit = String(
    process.env.SECONDARY_REGISTRATION_FORMS_TABLE || process.env.SECONDARY_FORM_TABLE_FORMS || ''
  ).trim();
  if (explicit) {
    const t = safeSqlIdent(explicit, 'form_builder_forms');
    if (!(await probeTableExists(secPool, t))) {
      const err = new Error(`Secondary registration forms table "${t}" does not exist or is not readable`);
      err.statusCode = 503;
      throw err;
    }
    return t;
  }
  if (await probeTableExists(secPool, 'forms')) return 'forms';
  if (await probeTableExists(secPool, 'form_builder_forms')) return 'form_builder_forms';
  return null;
}

const columnCache = new Map();
const COLUMN_CACHE_TTL_MS = 60_000;

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} tableName
 * @returns {Promise<Set<string>>}
 */
async function getTableColumns(pool, tableName) {
  const [connDbRows] = await pool.execute('SELECT DATABASE() AS d');
  const schema = connDbRows[0]?.d;
  if (!schema) {
    return new Set();
  }
  const cacheKey = `${schema}:${tableName}`;
  const hit = columnCache.get(cacheKey);
  if (hit && Date.now() - hit.at < COLUMN_CACHE_TTL_MS) {
    return hit.cols;
  }
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [schema, tableName]
  );
  const cols = new Set(rows.map((r) => r.COLUMN_NAME));
  columnCache.set(cacheKey, { cols, at: Date.now() });
  return cols;
}

/**
 * @param {Set<string>} cols
 */
function layoutForColumns(cols) {
  const layoutEnv = String(process.env.REGISTRATION_FORM_LAYOUT || 'auto').toLowerCase();
  if (layoutEnv === 'embedded_json' || layoutEnv === 'embedded') return 'embedded_json';
  if (layoutEnv === 'form_builder') return 'form_builder';
  if (cols.has('form_fields') && (cols.has('form_id') || cols.has('form_name'))) {
    return 'embedded_json';
  }
  return 'form_builder';
}

const formatForm = (formData) => {
  if (!formData) return null;
  return {
    id: formData.id,
    _id: formData.id,
    name: formData.name,
    description: formData.description || null,
    isDefault: formData.is_default === 1 || formData.is_default === true,
    isActive: formData.is_active === 1 || formData.is_active === true,
    createdBy: formData.created_by,
    updatedBy: formData.updated_by,
    createdAt: formData.created_at,
    updatedAt: formData.updated_at,
  };
};

const formatField = (fieldData) => {
  if (!fieldData) return null;

  let validationRules = {};
  let options = [];

  try {
    if (fieldData.validation_rules) {
      validationRules =
        typeof fieldData.validation_rules === 'string'
          ? JSON.parse(fieldData.validation_rules)
          : fieldData.validation_rules;
    }
  } catch (e) {
    console.error('[registrationForm] validation_rules parse:', e);
  }

  try {
    if (fieldData.options) {
      options =
        typeof fieldData.options === 'string' ? JSON.parse(fieldData.options) : fieldData.options;
    }
  } catch (e) {
    console.error('[registrationForm] options parse:', e);
  }

  return {
    id: fieldData.id,
    _id: fieldData.id,
    formId: fieldData.form_id,
    fieldName: fieldData.field_name,
    fieldType: fieldData.field_type,
    fieldLabel: fieldData.field_label,
    placeholder: fieldData.placeholder || null,
    isRequired: fieldData.is_required === 1 || fieldData.is_required === true,
    validationRules,
    displayOrder: fieldData.display_order || 0,
    options,
    defaultValue: fieldData.default_value || null,
    helpText: fieldData.help_text || null,
    isActive: fieldData.is_active === 1 || fieldData.is_active === true,
    createdBy: fieldData.created_by,
    updatedBy: fieldData.updated_by,
    createdAt: fieldData.created_at,
    updatedAt: fieldData.updated_at,
  };
};

const TYPE_ALIASES = {
  select: 'dropdown',
  phone: 'tel',
  mobile: 'tel',
  telphone: 'tel',
  int: 'number',
  integer: 'number',
  bool: 'checkbox',
  boolean: 'checkbox',
};

/**
 * @param {object} item
 * @param {number} index
 * @param {string} formSlug
 */
function mapEmbeddedJsonItemToField(item, index, formSlug) {
  if (!item || typeof item !== 'object') return null;
  const fieldName = String(
    item.key ?? item.fieldName ?? item.name ?? item.id ?? item.field_name ?? ''
  ).trim();
  if (!fieldName) return null;

  const rawType = String(item.type ?? item.fieldType ?? item.field_type ?? 'text').toLowerCase();
  const fieldType = TYPE_ALIASES[rawType] || rawType;

  let options = item.options ?? item.choices ?? [];
  if (typeof options === 'string') {
    try {
      options = JSON.parse(options);
    } catch {
      options = [];
    }
  }
  if (!Array.isArray(options)) options = [];

  let validationRules = item.validationRules ?? item.validation_rules ?? item.validation ?? {};
  if (typeof validationRules === 'string') {
    try {
      validationRules = JSON.parse(validationRules);
    } catch {
      validationRules = {};
    }
  }
  if (!validationRules || typeof validationRules !== 'object') validationRules = {};

  const syntheticId = `${formSlug}:${index}:${fieldName}`;

  return {
    id: syntheticId,
    _id: syntheticId,
    formId: formSlug,
    fieldName,
    fieldType: fieldType || 'text',
    fieldLabel: String(item.label ?? item.fieldLabel ?? item.field_label ?? fieldName),
    placeholder: item.placeholder != null ? String(item.placeholder) : null,
    isRequired: Boolean(item.required ?? item.isRequired ?? item.is_required),
    validationRules,
    displayOrder: Number(item.displayOrder ?? item.display_order ?? item.order ?? index + 1) || index + 1,
    options,
    defaultValue: item.defaultValue ?? item.default_value ?? null,
    helpText: item.helpText ?? item.help_text ?? null,
    isActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * @param {import('mysql2/promise').RowDataPacket} row
 */
function formatEmbeddedFormRowForList(row) {
  const slug =
    row.form_id != null && String(row.form_id).trim() !== ''
      ? String(row.form_id).trim()
      : String(row.id);
  let fieldCount = 0;
  try {
    const raw = row.form_fields;
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    fieldCount = Array.isArray(arr) ? arr.length : 0;
  } catch {
    fieldCount = 0;
  }
  const nameCol = row.form_name ?? row.name ?? slug;
  const descCol = row.form_description ?? row.description ?? null;
  const isDefault = String(row.form_id || '').trim() === defaultEmbeddedFormSlug;

  return {
    id: slug,
    _id: slug,
    name: nameCol,
    description: descCol,
    isDefault,
    isActive: row.is_active === 1 || row.is_active === true,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    fieldCount,
  };
}

/**
 * @param {import('mysql2/promise').RowDataPacket} row
 */
function buildEmbeddedFormResponse(row) {
  const slug =
    row.form_id != null && String(row.form_id).trim() !== ''
      ? String(row.form_id).trim()
      : String(row.id);
  const listRow = formatEmbeddedFormRowForList(row);
  let items = [];
  try {
    const raw = row.form_fields;
    items = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(items)) items = [];
  } catch (e) {
    console.error('[registrationForm] form_fields JSON parse:', e);
    items = [];
  }
  const fields = items
    .map((item, index) => mapEmbeddedJsonItemToField(item, index, slug))
    .filter(Boolean);
  return {
    ...listRow,
    fields,
  };
}

/**
 * @returns {Promise<{
 *   pool: import('mysql2/promise').Pool;
 *   definitionSource: string;
 *   formsTable: string;
 *   fieldsTable: string;
 *   layout: 'form_builder' | 'embedded_json';
 * }>}
 */
async function resolveRegistrationFormContext() {
  const mode = (process.env.REGISTRATION_FORM_SOURCE || 'auto').toLowerCase();

  if (mode === 'primary') {
    return {
      pool: getPrimaryPool(),
      definitionSource: 'primary',
      formsTable: primaryFormsTable,
      fieldsTable: primaryFieldsTable,
      layout: 'form_builder',
    };
  }

  if (mode === 'secondary') {
    if (!secondaryConfigured()) {
      const err = new Error(
        'REGISTRATION_FORM_SOURCE=secondary but DB_SECONDARY_HOST / DB_SECONDARY_NAME are not set'
      );
      err.statusCode = 503;
      throw err;
    }
    const secPool = getSecondaryPool();
    const formsTable = await resolveSecondaryFormsTableName(secPool);
    const cols = await getTableColumns(secPool, formsTable);
    const layout = layoutForColumns(cols);
    return {
      pool: secPool,
      definitionSource: 'secondary',
      formsTable,
      fieldsTable: secondaryFieldsTable,
      layout,
    };
  }

  // auto
  if (!secondaryConfigured()) {
    return {
      pool: getPrimaryPool(),
      definitionSource: 'primary_no_secondary_config',
      formsTable: primaryFormsTable,
      fieldsTable: primaryFieldsTable,
      layout: 'form_builder',
    };
  }

  const secPool = getSecondaryPool();
  try {
    const formsTable = await resolveSecondaryFormsTableName(secPool);
    if (!formsTable) {
      console.warn(
        `[registrationForm] No "forms" or "form_builder_forms" on ${process.env.DB_SECONDARY_NAME}; using primary.`
      );
      return {
        pool: getPrimaryPool(),
        definitionSource: 'primary_fallback_missing_secondary_tables',
        formsTable: primaryFormsTable,
        fieldsTable: primaryFieldsTable,
        layout: 'form_builder',
      };
    }
    const cols = await getTableColumns(secPool, formsTable);
    const layout = layoutForColumns(cols);
    return {
      pool: secPool,
      definitionSource: 'secondary',
      formsTable,
      fieldsTable: secondaryFieldsTable,
      layout,
    };
  } catch (e) {
    if (mode === 'auto' && (isMissingTableError(e) || e.statusCode === 503)) {
      console.warn(
        `[registrationForm] Secondary registration unavailable (${e.message}); using primary admissions DB.`
      );
      return {
        pool: getPrimaryPool(),
        definitionSource: 'primary_fallback_missing_secondary_tables',
        formsTable: primaryFormsTable,
        fieldsTable: primaryFieldsTable,
        layout: 'form_builder',
      };
    }
    throw e;
  }
}

function attachDefinitionSourceHeader(res, definitionSource) {
  res.setHeader('X-Registration-Form-Definition-Source', definitionSource);
}

/**
 * @route GET /api/registration-form/forms
 */
export const listRegistrationForms = async (req, res) => {
  try {
    const ctx = await resolveRegistrationFormContext();
    attachDefinitionSourceHeader(res, ctx.definitionSource);

    const showInactive = req.query.showInactive === 'true';
    const includeFieldCount = req.query.includeFieldCount !== 'false';

    if (ctx.layout === 'embedded_json') {
      const cols = await getTableColumns(ctx.pool, ctx.formsTable);
      const hasIsActive = cols.has('is_active');
      const hasFormId = cols.has('form_id');
      const orderParts = [];
      let orderNeedsDefaultSlug = false;
      if (hasFormId) {
        orderParts.push(`CASE WHEN form_id = ? THEN 0 ELSE 1 END`);
        orderNeedsDefaultSlug = true;
      }
      if (cols.has('updated_at')) orderParts.push('updated_at DESC');
      else if (cols.has('created_at')) orderParts.push('created_at DESC');
      const orderSql = orderParts.length ? `ORDER BY ${orderParts.join(', ')}` : '';

      let query = `SELECT * FROM \`${ctx.formsTable}\``;
      const params = [];
      if (!showInactive && hasIsActive) {
        query += ' WHERE is_active = ?';
        params.push(true);
      }
      if (orderSql) {
        query += ` ${orderSql}`;
      }
      if (orderNeedsDefaultSlug) {
        params.push(defaultEmbeddedFormSlug);
      }

      const [forms] = await ctx.pool.execute(query, params);
      const formattedForms = forms.map((row) => {
        const base = formatEmbeddedFormRowForList(row);
        if (!includeFieldCount) delete base.fieldCount;
        return base;
      });
      return successResponse(res, formattedForms);
    }

    let query = `SELECT * FROM \`${ctx.formsTable}\``;
    const params = [];

    if (!showInactive) {
      query += ' WHERE is_active = ?';
      params.push(true);
    }

    query += ' ORDER BY is_default DESC, name ASC';

    const [forms] = await ctx.pool.execute(query, params);
    const formattedForms = forms.map(formatForm);

    if (includeFieldCount && formattedForms.length > 0) {
      const formIds = formattedForms.map((f) => f.id);
      const placeholders = formIds.map(() => '?').join(',');
      let fieldCountQuery = `SELECT form_id, COUNT(*) as field_count FROM \`${ctx.fieldsTable}\` WHERE form_id IN (${placeholders})`;
      const fieldCountParams = [...formIds];

      if (!showInactive) {
        fieldCountQuery += ' AND is_active = ?';
        fieldCountParams.push(true);
      }

      fieldCountQuery += ' GROUP BY form_id';

      const [fieldCounts] = await ctx.pool.execute(fieldCountQuery, fieldCountParams);
      const fieldCountMap = new Map();
      fieldCounts.forEach((row) => {
        const count =
          typeof row.field_count === 'bigint' ? Number(row.field_count) : row.field_count;
        fieldCountMap.set(row.form_id, count);
      });
      formattedForms.forEach((form) => {
        form.fieldCount = fieldCountMap.get(form.id) || 0;
      });
    }

    return successResponse(res, formattedForms);
  } catch (error) {
    console.error('[registrationForm] listForms:', error);
    const status = error.statusCode || 500;
    return errorResponse(
      res,
      error.message || 'Failed to load registration forms',
      status
    );
  }
};

/**
 * @route GET /api/registration-form/forms/:formId
 */
export const getRegistrationForm = async (req, res) => {
  try {
    const ctx = await resolveRegistrationFormContext();
    attachDefinitionSourceHeader(res, ctx.definitionSource);

    const { formId } = req.params;
    const includeFields = req.query.includeFields !== 'false';
    const showInactive = req.query.showInactive === 'true';

    if (ctx.layout === 'embedded_json') {
      const cols = await getTableColumns(ctx.pool, ctx.formsTable);
      const hasIsActive = cols.has('is_active');
      const hasFormId = cols.has('form_id');

      let formQuery = `SELECT * FROM \`${ctx.formsTable}\` WHERE (`;
      const formParams = [];
      if (hasFormId) {
        formQuery += 'form_id = ? OR ';
        formParams.push(formId);
      }
      formQuery += 'CAST(id AS CHAR) = ?)';
      formParams.push(formId);

      if (!showInactive && hasIsActive) {
        formQuery += ' AND is_active = ?';
        formParams.push(true);
      }

      formQuery += ' LIMIT 1';

      const [forms] = await ctx.pool.execute(formQuery, formParams);

      if (forms.length === 0) {
        return errorResponse(res, 'Registration form not found', 404);
      }

      if (!includeFields) {
        const summary = formatEmbeddedFormRowForList(forms[0]);
        delete summary.fieldCount;
        return successResponse(res, summary);
      }

      const full = buildEmbeddedFormResponse(forms[0]);
      return successResponse(res, full);
    }

    let formQuery = `SELECT * FROM \`${ctx.formsTable}\` WHERE id = ?`;
    const formParams = [formId];

    if (!showInactive) {
      formQuery += ' AND is_active = ?';
      formParams.push(true);
    }

    const [forms] = await ctx.pool.execute(formQuery, formParams);

    if (forms.length === 0) {
      return errorResponse(res, 'Registration form not found', 404);
    }

    const form = formatForm(forms[0]);

    if (!includeFields) {
      return successResponse(res, form);
    }

    let fieldQuery = `SELECT * FROM \`${ctx.fieldsTable}\` WHERE form_id = ?`;
    const fieldParams = [formId];

    if (!showInactive) {
      fieldQuery += ' AND is_active = ?';
      fieldParams.push(true);
    }

    fieldQuery += ' ORDER BY display_order ASC, created_at ASC';

    const [fields] = await ctx.pool.execute(fieldQuery, fieldParams);
    const formattedFields = fields.map(formatField);

    return successResponse(res, {
      ...form,
      fields: formattedFields,
    });
  } catch (error) {
    console.error('[registrationForm] getForm:', error);
    const status = error.statusCode || 500;
    return errorResponse(res, error.message || 'Failed to load registration form', status);
  }
};
