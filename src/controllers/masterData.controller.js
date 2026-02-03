import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

const formatState = (row) =>
  row
    ? {
        id: row.id,
        name: row.name,
        isActive: row.is_active === 1 || row.is_active === true,
        displayOrder: row.display_order ?? 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const formatDistrict = (row) =>
  row
    ? {
        id: row.id,
        stateId: row.state_id,
        name: row.name,
        isActive: row.is_active === 1 || row.is_active === true,
        displayOrder: row.display_order ?? 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const formatMandal = (row) =>
  row
    ? {
        id: row.id,
        districtId: row.district_id,
        name: row.name,
        isActive: row.is_active === 1 || row.is_active === true,
        displayOrder: row.display_order ?? 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const formatSchool = (row) =>
  row
    ? {
        id: row.id,
        name: row.name,
        isActive: row.is_active === 1 || row.is_active === true,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const formatCollege = (row) =>
  row
    ? {
        id: row.id,
        name: row.name,
        isActive: row.is_active === 1 || row.is_active === true,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

// ---- States ----
export const listStates = async (req, res) => {
  try {
    const pool = getPool();
    const showInactive = req.query.showInactive === 'true';
    let query =
      'SELECT id, name, is_active, display_order, created_at, updated_at FROM states';
    const params = [];
    if (!showInactive) {
      query += ' WHERE is_active = ?';
      params.push(1);
    }
    query += ' ORDER BY display_order ASC, name ASC';
    const [rows] = await pool.execute(query, params);
    return successResponse(res, rows.map(formatState));
  } catch (err) {
    console.error('listStates error:', err);
    return errorResponse(res, err.message || 'Failed to list states', 500);
  }
};

export const getState = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      'SELECT id, name, is_active, display_order, created_at, updated_at FROM states WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return errorResponse(res, 'State not found', 404);
    return successResponse(res, formatState(rows[0]));
  } catch (err) {
    console.error('getState error:', err);
    return errorResponse(res, err.message || 'Failed to get state', 500);
  }
};

export const createState = async (req, res) => {
  try {
    const { name, isActive = true, displayOrder = 0 } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim())
      return errorResponse(res, 'name is required', 400);
    const pool = getPool();
    const id = uuidv4();
    await pool.execute(
      'INSERT INTO states (id, name, is_active, display_order) VALUES (?, ?, ?, ?)',
      [id, name.trim(), isActive ? 1 : 0, displayOrder ?? 0]
    );
    const [rows] = await pool.execute(
      'SELECT id, name, is_active, display_order, created_at, updated_at FROM states WHERE id = ?',
      [id]
    );
    return successResponse(res, formatState(rows[0]), 'State created', 201);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return errorResponse(res, 'State with this name already exists', 409);
    console.error('createState error:', err);
    return errorResponse(res, err.message || 'Failed to create state', 500);
  }
};

export const updateState = async (req, res) => {
  try {
    const { name, isActive, displayOrder } = req.body || {};
    const pool = getPool();
    const updates = [];
    const params = [];
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim())
        return errorResponse(res, 'name must be a non-empty string', 400);
      updates.push('name = ?');
      params.push(name.trim());
    }
    if (isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(isActive ? 1 : 0);
    }
    if (displayOrder !== undefined) {
      updates.push('display_order = ?');
      params.push(displayOrder ?? 0);
    }
    if (updates.length === 0)
      return errorResponse(res, 'No valid fields to update', 400);
    params.push(req.params.id);
    await pool.execute(
      `UPDATE states SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    const [rows] = await pool.execute(
      'SELECT id, name, is_active, display_order, created_at, updated_at FROM states WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return errorResponse(res, 'State not found', 404);
    return successResponse(res, formatState(rows[0]));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return errorResponse(res, 'State with this name already exists', 409);
    console.error('updateState error:', err);
    return errorResponse(res, err.message || 'Failed to update state', 500);
  }
};

export const deleteState = async (req, res) => {
  try {
    const pool = getPool();
    const [result] = await pool.execute('DELETE FROM states WHERE id = ?', [
      req.params.id,
    ]);
    if (result.affectedRows === 0)
      return errorResponse(res, 'State not found', 404);
    return successResponse(res, null, 'State deleted');
  } catch (err) {
    console.error('deleteState error:', err);
    return errorResponse(res, err.message || 'Failed to delete state', 500);
  }
};

// ---- Districts ----
export const listDistricts = async (req, res) => {
  try {
    const pool = getPool();
    const stateId = req.query.stateId;
    const showInactive = req.query.showInactive === 'true';
    let query =
      'SELECT id, state_id, name, is_active, display_order, created_at, updated_at FROM districts';
    const params = [];
    const conditions = [];
    if (stateId) {
      conditions.push('state_id = ?');
      params.push(stateId);
    }
    if (!showInactive) {
      conditions.push('is_active = ?');
      params.push(1);
    }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY display_order ASC, name ASC';
    const [rows] = await pool.execute(query, params);
    return successResponse(res, rows.map(formatDistrict));
  } catch (err) {
    console.error('listDistricts error:', err);
    return errorResponse(res, err.message || 'Failed to list districts', 500);
  }
};

export const getDistrict = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      'SELECT id, state_id, name, is_active, display_order, created_at, updated_at FROM districts WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return errorResponse(res, 'District not found', 404);
    return successResponse(res, formatDistrict(rows[0]));
  } catch (err) {
    console.error('getDistrict error:', err);
    return errorResponse(res, err.message || 'Failed to get district', 500);
  }
};

export const createDistrict = async (req, res) => {
  try {
    const { stateId, name, isActive = true, displayOrder = 0 } = req.body || {};
    if (!stateId || !name || typeof name !== 'string' || !name.trim())
      return errorResponse(res, 'stateId and name are required', 400);
    const pool = getPool();
    const id = uuidv4();
    await pool.execute(
      'INSERT INTO districts (id, state_id, name, is_active, display_order) VALUES (?, ?, ?, ?, ?)',
      [id, stateId, name.trim(), isActive ? 1 : 0, displayOrder ?? 0]
    );
    const [rows] = await pool.execute(
      'SELECT id, state_id, name, is_active, display_order, created_at, updated_at FROM districts WHERE id = ?',
      [id]
    );
    return successResponse(res, formatDistrict(rows[0]), 'District created', 201);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return errorResponse(
        res,
        'District with this name already exists in this state',
        409
      );
    if (err.code === 'ER_NO_REFERENCED_ROW_2')
      return errorResponse(res, 'State not found', 404);
    console.error('createDistrict error:', err);
    return errorResponse(res, err.message || 'Failed to create district', 500);
  }
};

export const updateDistrict = async (req, res) => {
  try {
    const { stateId, name, isActive, displayOrder } = req.body || {};
    const pool = getPool();
    const updates = [];
    const params = [];
    if (stateId !== undefined) {
      updates.push('state_id = ?');
      params.push(stateId);
    }
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim())
        return errorResponse(res, 'name must be a non-empty string', 400);
      updates.push('name = ?');
      params.push(name.trim());
    }
    if (isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(isActive ? 1 : 0);
    }
    if (displayOrder !== undefined) {
      updates.push('display_order = ?');
      params.push(displayOrder ?? 0);
    }
    if (updates.length === 0)
      return errorResponse(res, 'No valid fields to update', 400);
    params.push(req.params.id);
    await pool.execute(
      `UPDATE districts SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    const [rows] = await pool.execute(
      'SELECT id, state_id, name, is_active, display_order, created_at, updated_at FROM districts WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return errorResponse(res, 'District not found', 404);
    return successResponse(res, formatDistrict(rows[0]));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return errorResponse(
        res,
        'District with this name already exists in this state',
        409
      );
    console.error('updateDistrict error:', err);
    return errorResponse(res, err.message || 'Failed to update district', 500);
  }
};

export const deleteDistrict = async (req, res) => {
  try {
    const pool = getPool();
    const [result] = await pool.execute('DELETE FROM districts WHERE id = ?', [
      req.params.id,
    ]);
    if (result.affectedRows === 0)
      return errorResponse(res, 'District not found', 404);
    return successResponse(res, null, 'District deleted');
  } catch (err) {
    console.error('deleteDistrict error:', err);
    return errorResponse(res, err.message || 'Failed to delete district', 500);
  }
};

// ---- Mandals ----
export const listMandals = async (req, res) => {
  try {
    const pool = getPool();
    const districtId = req.query.districtId;
    const showInactive = req.query.showInactive === 'true';
    let query =
      'SELECT id, district_id, name, is_active, display_order, created_at, updated_at FROM mandals';
    const params = [];
    const conditions = [];
    if (districtId) {
      conditions.push('district_id = ?');
      params.push(districtId);
    }
    if (!showInactive) {
      conditions.push('is_active = ?');
      params.push(1);
    }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY display_order ASC, name ASC';
    const [rows] = await pool.execute(query, params);
    return successResponse(res, rows.map(formatMandal));
  } catch (err) {
    console.error('listMandals error:', err);
    return errorResponse(res, err.message || 'Failed to list mandals', 500);
  }
};

export const getMandal = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      'SELECT id, district_id, name, is_active, display_order, created_at, updated_at FROM mandals WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return errorResponse(res, 'Mandal not found', 404);
    return successResponse(res, formatMandal(rows[0]));
  } catch (err) {
    console.error('getMandal error:', err);
    return errorResponse(res, err.message || 'Failed to get mandal', 500);
  }
};

export const createMandal = async (req, res) => {
  try {
    const {
      districtId,
      name,
      isActive = true,
      displayOrder = 0,
    } = req.body || {};
    if (
      !districtId ||
      !name ||
      typeof name !== 'string' ||
      !name.trim()
    )
      return errorResponse(res, 'districtId and name are required', 400);
    const pool = getPool();
    const id = uuidv4();
    await pool.execute(
      'INSERT INTO mandals (id, district_id, name, is_active, display_order) VALUES (?, ?, ?, ?, ?)',
      [id, districtId, name.trim(), isActive ? 1 : 0, displayOrder ?? 0]
    );
    const [rows] = await pool.execute(
      'SELECT id, district_id, name, is_active, display_order, created_at, updated_at FROM mandals WHERE id = ?',
      [id]
    );
    return successResponse(res, formatMandal(rows[0]), 'Mandal created', 201);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return errorResponse(
        res,
        'Mandal with this name already exists in this district',
        409
      );
    if (err.code === 'ER_NO_REFERENCED_ROW_2')
      return errorResponse(res, 'District not found', 404);
    console.error('createMandal error:', err);
    return errorResponse(res, err.message || 'Failed to create mandal', 500);
  }
};

export const updateMandal = async (req, res) => {
  try {
    const { districtId, name, isActive, displayOrder } = req.body || {};
    const pool = getPool();
    const updates = [];
    const params = [];
    if (districtId !== undefined) {
      updates.push('district_id = ?');
      params.push(districtId);
    }
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim())
        return errorResponse(res, 'name must be a non-empty string', 400);
      updates.push('name = ?');
      params.push(name.trim());
    }
    if (isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(isActive ? 1 : 0);
    }
    if (displayOrder !== undefined) {
      updates.push('display_order = ?');
      params.push(displayOrder ?? 0);
    }
    if (updates.length === 0)
      return errorResponse(res, 'No valid fields to update', 400);
    params.push(req.params.id);
    await pool.execute(
      `UPDATE mandals SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    const [rows] = await pool.execute(
      'SELECT id, district_id, name, is_active, display_order, created_at, updated_at FROM mandals WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return errorResponse(res, 'Mandal not found', 404);
    return successResponse(res, formatMandal(rows[0]));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return errorResponse(
        res,
        'Mandal with this name already exists in this district',
        409
      );
    console.error('updateMandal error:', err);
    return errorResponse(res, err.message || 'Failed to update mandal', 500);
  }
};

export const deleteMandal = async (req, res) => {
  try {
    const pool = getPool();
    const [result] = await pool.execute('DELETE FROM mandals WHERE id = ?', [
      req.params.id,
    ]);
    if (result.affectedRows === 0)
      return errorResponse(res, 'Mandal not found', 404);
    return successResponse(res, null, 'Mandal deleted');
  } catch (err) {
    console.error('deleteMandal error:', err);
    return errorResponse(res, err.message || 'Failed to delete mandal', 500);
  }
};

// ---- Schools ----
export const listSchools = async (req, res) => {
  try {
    const pool = getPool();
    const showInactive = req.query.showInactive === 'true';
    let query =
      'SELECT id, name, is_active, created_at, updated_at FROM schools';
    const params = [];
    if (!showInactive) {
      query += ' WHERE is_active = ?';
      params.push(1);
    }
    query += ' ORDER BY name ASC';
    const [rows] = await pool.execute(query, params);
    return successResponse(res, rows.map(formatSchool));
  } catch (err) {
    console.error('listSchools error:', err);
    return errorResponse(res, err.message || 'Failed to list schools', 500);
  }
};

export const getSchool = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      'SELECT id, name, is_active, created_at, updated_at FROM schools WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return errorResponse(res, 'School not found', 404);
    return successResponse(res, formatSchool(rows[0]));
  } catch (err) {
    console.error('getSchool error:', err);
    return errorResponse(res, err.message || 'Failed to get school', 500);
  }
};

export const createSchool = async (req, res) => {
  try {
    const { name, isActive = true } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim())
      return errorResponse(res, 'name is required', 400);
    const pool = getPool();
    const id = uuidv4();
    await pool.execute(
      'INSERT INTO schools (id, name, is_active) VALUES (?, ?, ?)',
      [id, name.trim(), isActive ? 1 : 0]
    );
    const [rows] = await pool.execute(
      'SELECT id, name, is_active, created_at, updated_at FROM schools WHERE id = ?',
      [id]
    );
    return successResponse(res, formatSchool(rows[0]), 'School created', 201);
  } catch (err) {
    console.error('createSchool error:', err);
    return errorResponse(res, err.message || 'Failed to create school', 500);
  }
};

export const updateSchool = async (req, res) => {
  try {
    const { name, isActive } = req.body || {};
    const pool = getPool();
    const updates = [];
    const params = [];
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim())
        return errorResponse(res, 'name must be a non-empty string', 400);
      updates.push('name = ?');
      params.push(name.trim());
    }
    if (isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(isActive ? 1 : 0);
    }
    if (updates.length === 0)
      return errorResponse(res, 'No valid fields to update', 400);
    params.push(req.params.id);
    await pool.execute(
      `UPDATE schools SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    const [rows] = await pool.execute(
      'SELECT id, name, is_active, created_at, updated_at FROM schools WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return errorResponse(res, 'School not found', 404);
    return successResponse(res, formatSchool(rows[0]));
  } catch (err) {
    console.error('updateSchool error:', err);
    return errorResponse(res, err.message || 'Failed to update school', 500);
  }
};

export const deleteSchool = async (req, res) => {
  try {
    const pool = getPool();
    const [result] = await pool.execute('DELETE FROM schools WHERE id = ?', [
      req.params.id,
    ]);
    if (result.affectedRows === 0)
      return errorResponse(res, 'School not found', 404);
    return successResponse(res, null, 'School deleted');
  } catch (err) {
    console.error('deleteSchool error:', err);
    return errorResponse(res, err.message || 'Failed to delete school', 500);
  }
};

export const bulkCreateSchools = async (req, res) => {
  try {
    const { names } = req.body || {};
    if (!Array.isArray(names))
      return errorResponse(res, 'names array is required', 400);
    const pool = getPool();
    const trimmed = names
      .map((n) => (typeof n === 'string' ? n.trim() : String(n || '').trim()))
      .filter((n) => n.length > 0);
    const unique = [...new Set(trimmed)];
    const [existingRows] = await pool.execute(
      'SELECT name FROM schools'
    );
    const existingSet = new Set(
      (existingRows || []).map((r) => (r.name || '').toLowerCase())
    );
    let created = 0;
    for (const name of unique) {
      if (existingSet.has(name.toLowerCase())) continue;
      const id = uuidv4();
      await pool.execute(
        'INSERT INTO schools (id, name, is_active) VALUES (?, ?, 1)',
        [id, name]
      );
      existingSet.add(name.toLowerCase());
      created++;
    }
    return successResponse(res, {
      total: names.length,
      valid: unique.length,
      created,
      skipped: unique.length - created,
      invalid: names.length - trimmed.length,
    });
  } catch (err) {
    console.error('bulkCreateSchools error:', err);
    return errorResponse(res, err.message || 'Bulk create schools failed', 500);
  }
};

// ---- Colleges ----
export const listColleges = async (req, res) => {
  try {
    const pool = getPool();
    const showInactive = req.query.showInactive === 'true';
    let query =
      'SELECT id, name, is_active, created_at, updated_at FROM colleges';
    const params = [];
    if (!showInactive) {
      query += ' WHERE is_active = ?';
      params.push(1);
    }
    query += ' ORDER BY name ASC';
    const [rows] = await pool.execute(query, params);
    return successResponse(res, rows.map(formatCollege));
  } catch (err) {
    console.error('listColleges error:', err);
    return errorResponse(res, err.message || 'Failed to list colleges', 500);
  }
};

export const getCollege = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      'SELECT id, name, is_active, created_at, updated_at FROM colleges WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return errorResponse(res, 'College not found', 404);
    return successResponse(res, formatCollege(rows[0]));
  } catch (err) {
    console.error('getCollege error:', err);
    return errorResponse(res, err.message || 'Failed to get college', 500);
  }
};

export const createCollege = async (req, res) => {
  try {
    const { name, isActive = true } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim())
      return errorResponse(res, 'name is required', 400);
    const pool = getPool();
    const id = uuidv4();
    await pool.execute(
      'INSERT INTO colleges (id, name, is_active) VALUES (?, ?, ?)',
      [id, name.trim(), isActive ? 1 : 0]
    );
    const [rows] = await pool.execute(
      'SELECT id, name, is_active, created_at, updated_at FROM colleges WHERE id = ?',
      [id]
    );
    return successResponse(res, formatCollege(rows[0]), 'College created', 201);
  } catch (err) {
    console.error('createCollege error:', err);
    return errorResponse(res, err.message || 'Failed to create college', 500);
  }
};

export const updateCollege = async (req, res) => {
  try {
    const { name, isActive } = req.body || {};
    const pool = getPool();
    const updates = [];
    const params = [];
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim())
        return errorResponse(res, 'name must be a non-empty string', 400);
      updates.push('name = ?');
      params.push(name.trim());
    }
    if (isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(isActive ? 1 : 0);
    }
    if (updates.length === 0)
      return errorResponse(res, 'No valid fields to update', 400);
    params.push(req.params.id);
    await pool.execute(
      `UPDATE colleges SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    const [rows] = await pool.execute(
      'SELECT id, name, is_active, created_at, updated_at FROM colleges WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return errorResponse(res, 'College not found', 404);
    return successResponse(res, formatCollege(rows[0]));
  } catch (err) {
    console.error('updateCollege error:', err);
    return errorResponse(res, err.message || 'Failed to update college', 500);
  }
};

export const deleteCollege = async (req, res) => {
  try {
    const pool = getPool();
    const [result] = await pool.execute('DELETE FROM colleges WHERE id = ?', [
      req.params.id,
    ]);
    if (result.affectedRows === 0)
      return errorResponse(res, 'College not found', 404);
    return successResponse(res, null, 'College deleted');
  } catch (err) {
    console.error('deleteCollege error:', err);
    return errorResponse(res, err.message || 'Failed to delete college', 500);
  }
};

export const bulkCreateColleges = async (req, res) => {
  try {
    const { names } = req.body || {};
    if (!Array.isArray(names))
      return errorResponse(res, 'names array is required', 400);
    const pool = getPool();
    const trimmed = names
      .map((n) => (typeof n === 'string' ? n.trim() : String(n || '').trim()))
      .filter((n) => n.length > 0);
    const unique = [...new Set(trimmed)];
    const [existingRows] = await pool.execute(
      'SELECT name FROM colleges'
    );
    const existingSet = new Set(
      (existingRows || []).map((r) => (r.name || '').toLowerCase())
    );
    let created = 0;
    for (const name of unique) {
      if (existingSet.has(name.toLowerCase())) continue;
      const id = uuidv4();
      await pool.execute(
        'INSERT INTO colleges (id, name, is_active) VALUES (?, ?, 1)',
        [id, name]
      );
      existingSet.add(name.toLowerCase());
      created++;
    }
    return successResponse(res, {
      total: names.length,
      valid: unique.length,
      created,
      skipped: unique.length - created,
      invalid: names.length - trimmed.length,
    });
  } catch (err) {
    console.error('bulkCreateColleges error:', err);
    return errorResponse(res, err.message || 'Bulk create colleges failed', 500);
  }
};
