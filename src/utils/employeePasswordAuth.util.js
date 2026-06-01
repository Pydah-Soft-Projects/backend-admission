import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

function getCollectionModel(conn, collectionName) {
  const modelName = `hrms_${collectionName}`;
  return (
    conn.models[modelName] ||
    conn.model(
      modelName,
      new conn.base.Schema({}, { strict: false, collection: collectionName })
    )
  );
}

export function getHrmsUsersModel(conn) {
  return getCollectionModel(conn, 'users');
}

export function getHrmsEmployeesModel(conn) {
  return getCollectionModel(conn, 'employees');
}

/** emp_no / employeeId — string and numeric variants. */
export function buildEmployeeIdOrConditions(empNo) {
  const empNoStr = String(empNo ?? '').trim();
  if (!empNoStr) return [];

  const empNoNum = Number(empNoStr);
  const or = [
    { emp_no: empNoStr },
    { employeeId: empNoStr },
    { employee_id: empNoStr },
  ];
  if (Number.isFinite(empNoNum) && !Number.isNaN(empNoNum)) {
    or.push(
      { emp_no: empNoNum },
      { employeeId: String(empNoNum) },
      { employee_id: String(empNoNum) }
    );
  }
  return or;
}

export async function findHrmsAuthDocument(Model, { emp_no, hrms_id }) {
  let doc = null;

  if (emp_no != null && String(emp_no).trim() !== '') {
    const or = buildEmployeeIdOrConditions(emp_no);
    if (or.length === 1) {
      doc = await Model.findOne(or[0]);
    } else if (or.length > 1) {
      doc = await Model.findOne({ $or: or });
    }
  }

  if (!doc && hrms_id != null && String(hrms_id).trim() !== '') {
    const hrmsIdStr = String(hrms_id).trim();
    if (mongoose.Types.ObjectId.isValid(hrmsIdStr)) {
      doc = await Model.findById(hrmsIdStr);
    }
  }

  return doc;
}

export function extractPasswordFromDocument(doc) {
  if (!doc) return null;
  const o = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return o.password ?? o.Password ?? null;
}

/** bcrypt hash or legacy plain-text. */
export async function verifyEmployeePassword(plainPassword, storedPassword) {
  if (storedPassword == null || storedPassword === '') return false;

  const stored = String(storedPassword);
  if (/^\$2[aby]?\$/.test(stored)) {
    return bcrypt.compare(plainPassword, stored);
  }
  return plainPassword === stored;
}

export async function matchHrmsCollectionPassword(Model, { plainPassword, emp_no, hrms_id }) {
  const doc = await findHrmsAuthDocument(Model, { emp_no, hrms_id });
  if (!doc) {
    return { matched: false, doc: null, reason: 'not_found' };
  }

  const storedPassword = extractPasswordFromDocument(doc);
  if (!storedPassword) {
    return { matched: false, doc, reason: 'no_password' };
  }

  const matched = await verifyEmployeePassword(plainPassword, storedPassword);
  return { matched, doc, reason: matched ? 'ok' : 'mismatch' };
}

/**
 * HRMS Mongo (HRMS_MONGO_URI): password on `users` collection; `employees` as fallback.
 */
export async function matchHrmsEmployeePassword(hrmsConn, { plainPassword, emp_no, hrms_id }) {
  const Users = getHrmsUsersModel(hrmsConn);
  const usersResult = await matchHrmsCollectionPassword(Users, {
    plainPassword,
    emp_no,
    hrms_id,
  });
  if (usersResult.matched) {
    return { ...usersResult, collection: 'users' };
  }

  const Employees = getHrmsEmployeesModel(hrmsConn);
  const employeesResult = await matchHrmsCollectionPassword(Employees, {
    plainPassword,
    emp_no,
    hrms_id,
  });
  return { ...employeesResult, collection: 'employees' };
}
