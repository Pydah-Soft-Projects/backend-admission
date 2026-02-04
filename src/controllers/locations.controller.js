/**
 * Public read-only locations API (states, districts, mandals).
 * Used for dropdowns in lead forms, joining forms, etc. No auth required.
 */
import { getPool } from '../config-sql/database.js';
import { successResponse, errorResponse } from '../utils/response.util.js';

const formatStateSimple = (row) => (row ? { id: row.id, name: row.name } : null);
const formatDistrictSimple = (row) => (row ? { id: row.id, name: row.name } : null);
const formatMandalSimple = (row) => (row ? { id: row.id, name: row.name } : null);
const formatSchoolSimple = (row) => (row ? { id: row.id, name: row.name } : null);
const formatCollegeSimple = (row) => (row ? { id: row.id, name: row.name } : null);

export const listStates = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      'SELECT id, name FROM states WHERE is_active = 1 ORDER BY display_order ASC, name ASC'
    );
    const data = rows.map(formatStateSimple);
    return successResponse(res, data);
  } catch (err) {
    console.error('locations listStates error:', err);
    return errorResponse(res, err.message || 'Failed to list states', 500);
  }
};

export const listDistricts = async (req, res) => {
  try {
    const pool = getPool();
    const stateId = req.query.stateId;
    const stateName = req.query.stateName;

    if (!stateId && !stateName) {
      return errorResponse(res, 'stateId or stateName is required', 400);
    }

    let resolvedStateId = stateId;
    if (stateName && !stateId) {
      const [stateRows] = await pool.execute(
        'SELECT id FROM states WHERE LOWER(name) = LOWER(?) AND is_active = 1',
        [String(stateName).trim()]
      );
      if (stateRows.length === 0) {
        return successResponse(res, []);
      }
      resolvedStateId = stateRows[0].id;
    }

    const [rows] = await pool.execute(
      'SELECT id, name FROM districts WHERE state_id = ? AND is_active = 1 ORDER BY display_order ASC, name ASC',
      [resolvedStateId]
    );
    const data = rows.map(formatDistrictSimple);
    return successResponse(res, data);
  } catch (err) {
    console.error('locations listDistricts error:', err);
    return errorResponse(res, err.message || 'Failed to list districts', 500);
  }
};

export const listMandals = async (req, res) => {
  try {
    const pool = getPool();
    const districtId = req.query.districtId;
    const stateName = req.query.stateName;
    const districtName = req.query.districtName;

    if (!districtId && !(stateName && districtName)) {
      return errorResponse(res, 'districtId or (stateName and districtName) is required', 400);
    }

    let resolvedDistrictId = districtId;
    if (stateName && districtName && !districtId) {
      const [stateRows] = await pool.execute(
        'SELECT id FROM states WHERE LOWER(name) = LOWER(?) AND is_active = 1',
        [String(stateName).trim()]
      );
      if (stateRows.length === 0) {
        return successResponse(res, []);
      }
      const [districtRows] = await pool.execute(
        'SELECT id FROM districts WHERE state_id = ? AND LOWER(name) = LOWER(?) AND is_active = 1',
        [stateRows[0].id, String(districtName).trim()]
      );
      if (districtRows.length === 0) {
        return successResponse(res, []);
      }
      resolvedDistrictId = districtRows[0].id;
    }

    const [rows] = await pool.execute(
      'SELECT id, name FROM mandals WHERE district_id = ? AND is_active = 1 ORDER BY display_order ASC, name ASC',
      [resolvedDistrictId]
    );
    const data = rows.map(formatMandalSimple);
    return successResponse(res, data);
  } catch (err) {
    console.error('locations listMandals error:', err);
    return errorResponse(res, err.message || 'Failed to list mandals', 500);
  }
};

export const listSchools = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      'SELECT id, name FROM schools WHERE is_active = 1 ORDER BY name ASC'
    );
    const data = rows.map(formatSchoolSimple);
    return successResponse(res, data);
  } catch (err) {
    console.error('locations listSchools error:', err);
    return errorResponse(res, err.message || 'Failed to list schools', 500);
  }
};

export const listColleges = async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      'SELECT id, name FROM colleges WHERE is_active = 1 ORDER BY name ASC'
    );
    const data = rows.map(formatCollegeSimple);
    return successResponse(res, data);
  } catch (err) {
    console.error('locations listColleges error:', err);
    return errorResponse(res, err.message || 'Failed to list colleges', 500);
  }
};
