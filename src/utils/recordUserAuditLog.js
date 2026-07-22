import { getPool } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Build a stable, password-free snapshot for audit diffs.
 * Accepts either SQL snake_case rows or formatted camelCase user objects.
 */
export const snapshotUserForAudit = (row) => {
  if (!row) return null;
  const permissionsRaw = row.permissions;
  let permissions = {};
  if (typeof permissionsRaw === 'string') {
    try {
      permissions = JSON.parse(permissionsRaw) || {};
    } catch {
      permissions = {};
    }
  } else if (permissionsRaw && typeof permissionsRaw === 'object') {
    permissions = permissionsRaw;
  }

  const managedByRaw = row.managed_by ?? row.managedBy ?? null;
  let managedBy = null;
  if (managedByRaw != null && managedByRaw !== '') {
    managedBy =
      typeof managedByRaw === 'object'
        ? managedByRaw._id || managedByRaw.id || null
        : String(managedByRaw);
  }

  return {
    name: row.name ?? null,
    email: row.email ?? null,
    mobileNumber: row.mobile_number ?? row.mobileNumber ?? null,
    roleName: row.role_name ?? row.roleName ?? null,
    designation: row.designation ?? null,
    isActive:
      row.is_active === undefined && row.isActive === undefined
        ? true
        : row.is_active === 1 || row.is_active === true || row.isActive === true,
    isManager:
      row.is_manager === 1 || row.is_manager === true || row.isManager === true,
    managedBy,
    permissions,
    hrms_id: row.hrms_id ?? null,
    emp_no: row.emp_no ?? null,
  };
};

/**
 * Diff two snapshots into { field: { from, to } }.
 * @param {object|null} before
 * @param {object|null} after
 * @param {{ passwordChanged?: boolean }} [extras]
 */
export const diffUserAuditSnapshots = (before, after, extras = {}) => {
  const changes = {};
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);

  for (const key of keys) {
    const fromVal = before ? before[key] : undefined;
    const toVal = after ? after[key] : undefined;
    if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
      changes[key] = { from: fromVal ?? null, to: toVal ?? null };
    }
  }

  if (extras.passwordChanged) {
    changes.password = { from: '(hidden)', to: '(changed)' };
  }

  return changes;
};

export const getRequestAuditMeta = (req) => {
  const forwarded = req.headers?.['x-forwarded-for'];
  const ipAddress =
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ||
    req.ip ||
    req.connection?.remoteAddress ||
    null;
  const userAgent = req.get?.('user-agent') || req.headers?.['user-agent'] || null;
  return { ipAddress, userAgent };
};

/**
 * Record a user-management audit event.
 * Non-fatal: failures are logged but do not fail the main request.
 */
export const recordUserAuditLog = async ({
  targetUserId = null,
  targetUserName = null,
  targetUserEmail = null,
  action,
  changedBy = null,
  changedByName = null,
  changes = {},
  ipAddress = null,
  userAgent = null,
}) => {
  try {
    if (!action || !['create', 'update', 'delete'].includes(action)) {
      console.error('recordUserAuditLog: invalid action', action);
      return;
    }
    const pool = getPool();
    const id = uuidv4();
    await pool.execute(
      `INSERT INTO user_audit_logs (
        id, target_user_id, target_user_name, target_user_email,
        action, changed_by, changed_by_name, changes_json, ip_address, user_agent, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        id,
        targetUserId,
        targetUserName,
        targetUserEmail,
        action,
        changedBy,
        changedByName,
        JSON.stringify(changes || {}),
        ipAddress,
        userAgent,
      ]
    );
  } catch (err) {
    console.error('Failed to record user audit log:', err.message);
  }
};
