import {
  connectTransport,
  getTransportConnection,
} from '../config-mongo/transport.js';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { getPool as getSecondaryPool } from '../config-sql/database-secondary.js';
import {
  resolveTransportApplicationCodes,
  peekNextTransportApplicationNumber,
  calendarYearToAcademicYearSession,
} from '../utils/transportApplicationNumber.util.js';
import { cancelStudentTransportRequest } from '../services/transportRequestCancellation.service.js';

const getActiveConnection = async () => {
  try {
    return getTransportConnection();
  } catch {
    return connectTransport();
  }
};

const formatRouteSummary = (doc) => ({
  _id: String(doc._id),
  routeId: doc.routeId || '',
  routeName: doc.routeName || '',
  startPoint: doc.startPoint || '',
  endPoint: doc.endPoint || '',
  totalDistance: doc.totalDistance ?? null,
  stageCount: Array.isArray(doc.stages) ? doc.stages.length : 0,
});

const formatStage = (stage) => ({
  _id: stage?._id ? String(stage._id) : '',
  stageName: stage?.stageName || '',
  distanceFromStart: stage?.distanceFromStart ?? null,
  fare: stage?.fare ?? null,
});

const formatBusSummary = (doc) => ({
  _id: String(doc._id),
  busNumber: doc.busNumber || '',
  capacity: doc.capacity ?? 40,
  type: doc.type || '',
  driverName: doc.driverName || '',
  status: doc.status || '',
  assignedRouteId: doc.assignedRouteId || '',
});

const getBusOccupancyMap = async (db, busNumbers = [], routeIds = []) => {
  const busStudentsMap = {};
  const routeStudentsMap = {};

  const addRequestToMap = (busId, routeId, key) => {
    if (busId) {
      if (!busStudentsMap[busId]) busStudentsMap[busId] = new Set();
      busStudentsMap[busId].add(key);
    }
    if (routeId) {
      if (!routeStudentsMap[routeId]) routeStudentsMap[routeId] = new Set();
      routeStudentsMap[routeId].add(key);
    }
  };

  if (db) {
    try {
      const mongoOr = [];
      if (busNumbers.length > 0) mongoOr.push({ bus_id: { $in: busNumbers } });
      if (routeIds.length > 0) mongoOr.push({ route_id: { $in: routeIds } });

      if (mongoOr.length > 0) {
        const mongoReqs = await db
          .collection('transport_requests')
          .find({
            status: { $in: ['pending', 'approved'] },
            $or: mongoOr,
          })
          .project({ bus_id: 1, route_id: 1, admission_number: 1, employee_id: 1 })
          .toArray();

        for (const req of mongoReqs) {
          const key = String(req.admission_number || req.employee_id || req._id).trim();
          if (key) {
            addRequestToMap(req.bus_id, req.route_id, key);
          }
        }
      }
    } catch (err) {
      console.warn('[getBusOccupancyMap] Mongo query warning:', err?.message || err);
    }
  }

  try {
    const pool = getSecondaryPool();
    if (pool) {
      const sqlWhere = [];
      const sqlParams = [];
      if (busNumbers.length > 0) {
        const placeholders = busNumbers.map(() => '?').join(',');
        sqlWhere.push(`bus_id IN (${placeholders})`);
        sqlParams.push(...busNumbers);
      }
      if (routeIds.length > 0) {
        const placeholders = routeIds.map(() => '?').join(',');
        sqlWhere.push(`route_id IN (${placeholders})`);
        sqlParams.push(...routeIds);
      }

      if (sqlWhere.length > 0) {
        const [rows] = await pool.execute(
          `SELECT bus_id, route_id, admission_number, employee_id, id FROM transport_requests WHERE status IN ('pending', 'approved') AND (${sqlWhere.join(' OR ')})`,
          sqlParams
        );
        for (const r of rows) {
          const key = String(r.admission_number || r.employee_id || r.id).trim();
          if (key) {
            addRequestToMap(r.bus_id, r.route_id, key);
          }
        }
      }
    }
  } catch {
    // Secondary DB optional
  }

  const busCountMap = {};
  for (const [busId, set] of Object.entries(busStudentsMap)) {
    busCountMap[busId] = set.size;
  }

  const routeCountMap = {};
  for (const [routeId, set] of Object.entries(routeStudentsMap)) {
    routeCountMap[routeId] = set.size;
  }

  return { busCountMap, routeCountMap };
};

/** GET /api/transport/routes — list bus routes from the transport database. */
export const listTransportRoutes = async (_req, res) => {
  try {
    const conn = await getActiveConnection();
    const db = conn.db;
    const routes = await db
      .collection('routes')
      .find({})
      .project({
        routeId: 1,
        routeName: 1,
        startPoint: 1,
        endPoint: 1,
        totalDistance: 1,
        stages: 1,
      })
      .sort({ routeName: 1 })
      .toArray();

    const routeIds = routes.map((r) => r.routeId).filter(Boolean);
    const buses = await db
      .collection('buses')
      .find({ assignedRouteId: { $in: routeIds } })
      .project({ busNumber: 1, capacity: 1, assignedRouteId: 1 })
      .toArray();

    const busNumbers = buses.map((b) => b.busNumber).filter(Boolean);
    const { busCountMap, routeCountMap } = await getBusOccupancyMap(db, busNumbers, routeIds);

    const busesByRoute = {};
    for (const b of buses) {
      if (!b.assignedRouteId) continue;
      if (!busesByRoute[b.assignedRouteId]) busesByRoute[b.assignedRouteId] = [];
      busesByRoute[b.assignedRouteId].push(b);
    }

    const formattedRoutes = routes.map((r) => {
      const summary = formatRouteSummary(r);
      const assignedBuses = busesByRoute[r.routeId] || [];
      let totalCapacity = 0;
      let totalFilled = 0;
      if (assignedBuses.length > 0) {
        for (const b of assignedBuses) {
          const cap = Number(b.capacity) || 40;
          const filled = busCountMap[b.busNumber] || 0;
          totalCapacity += cap;
          totalFilled += filled;
        }
      } else {
        totalCapacity = 40;
        totalFilled = routeCountMap[r.routeId] || 0;
      }
      const seatsAvailable = Math.max(0, totalCapacity - totalFilled);
      return {
        ...summary,
        capacity: totalCapacity,
        seatsFilled: totalFilled,
        seatsAvailable,
      };
    });

    return successResponse(res, {
      data: formattedRoutes,
      total: formattedRoutes.length,
    });
  } catch (error) {
    console.error('listTransportRoutes error:', error);
    return errorResponse(res, error.message || 'Failed to load transport routes', 500);
  }
};

/** GET /api/transport/routes/:routeId — route detail with stages and assigned buses. */
export const getTransportRouteDetail = async (req, res) => {
  try {
    const routeKey = String(req.params.routeId || '').trim();
    if (!routeKey) {
      return errorResponse(res, 'Route id is required', 400);
    }

    const conn = await getActiveConnection();
    const db = conn.db;

    const route = await db.collection('routes').findOne({ routeId: routeKey });

    if (!route) {
      return errorResponse(res, 'Route not found', 404);
    }

    const buses = await db
      .collection('buses')
      .find({ assignedRouteId: route.routeId })
      .project({
        busNumber: 1,
        capacity: 1,
        type: 1,
        driverName: 1,
        attendantName: 1,
        status: 1,
        assignedRouteId: 1,
      })
      .sort({ busNumber: 1 })
      .toArray();

    const busNumbers = buses.map((b) => b.busNumber).filter(Boolean);
    const { busCountMap, routeCountMap } = await getBusOccupancyMap(db, busNumbers, [route.routeId]);

    let totalCapacity = 0;
    let totalSeatsFilled = 0;

    const formattedBuses = buses.map((b) => {
      const cap = Number(b.capacity) || 40;
      const filled = busCountMap[b.busNumber] ?? (routeCountMap[route.routeId] || 0);
      const available = Math.max(0, cap - filled);
      totalCapacity += cap;
      totalSeatsFilled += filled;
      return {
        ...formatBusSummary(b),
        capacity: cap,
        seatsFilled: filled,
        seatsAvailable: available,
      };
    });

    if (buses.length === 0) {
      totalCapacity = 40;
      totalSeatsFilled = routeCountMap[route.routeId] || 0;
    }

    const totalSeatsAvailable = Math.max(0, totalCapacity - totalSeatsFilled);

    return successResponse(res, {
      data: {
        ...formatRouteSummary(route),
        capacity: totalCapacity,
        seatsFilled: totalSeatsFilled,
        seatsAvailable: totalSeatsAvailable,
        estimatedTime: route.estimatedTime || '',
        stages: (Array.isArray(route.stages) ? route.stages : []).map(formatStage),
        buses: formattedBuses,
      },
    });
  } catch (error) {
    console.error('getTransportRouteDetail error:', error);
    return errorResponse(res, error.message || 'Failed to load transport route', 500);
  }
};

/** GET /api/transport/next-application-number — peek next sequence number for college/course/AY. */
export const getNextTransportApplicationNumberPreview = async (req, res) => {
  try {
    const { academicYear, collegeId, managedCourseId, courseName, collegeName } = req.query;

    if (!academicYear) {
      return errorResponse(res, 'academicYear is required', 400);
    }

    let pool;
    try {
      pool = getSecondaryPool();
    } catch (err) {
      return errorResponse(res, 'Secondary database is not available', 503);
    }

    const { collegeCode, courseCode } = await resolveTransportApplicationCodes(pool, {
      collegeId: collegeId ? Number(collegeId) : null,
      managedCourseId: managedCourseId ? Number(managedCourseId) : null,
      courseName,
      collegeName,
    });

    const normalizedAY = calendarYearToAcademicYearSession(academicYear);
    const nextNumberInfo = await peekNextTransportApplicationNumber(
      pool,
      normalizedAY,
      collegeCode,
      courseCode
    );

    return successResponse(res, nextNumberInfo);
  } catch (error) {
    console.error('getNextTransportApplicationNumberPreview error:', error);
    return errorResponse(res, error.message || 'Failed to peek next transport application number', 500);
  }
};

/** GET /api/transport/requests — fetch student's transport request for a given admission number & academic year. */
export const getStudentTransportRequest = async (req, res) => {
  try {
    const { admissionNumber, academicYear } = req.query;

    if (!admissionNumber) {
      return errorResponse(res, 'admissionNumber is required', 400);
    }

    const normalizedAY = academicYear ? calendarYearToAcademicYearSession(academicYear) : null;
    const admNo = String(admissionNumber).trim();

    try {
      const conn = await getActiveConnection();
      const coll = conn.db.collection('transport_requests');
      let mongoDoc = null;
      if (normalizedAY) {
        mongoDoc = await coll.findOne({
          admission_number: admNo,
          $or: [{ academic_year: normalizedAY }, { academic_year: academicYear }],
        }, { sort: { request_date: -1, updated_at: -1 } });
      }
      if (!mongoDoc) {
        mongoDoc = await coll.findOne({ admission_number: admNo }, { sort: { request_date: -1, updated_at: -1 } });
      }

      if (mongoDoc) {
        return successResponse(res, {
          id: String(mongoDoc._id),
          admission_number: mongoDoc.admission_number,
          student_name: mongoDoc.student_name,
          route_id: mongoDoc.route_id,
          route_name: mongoDoc.route_name,
          stage_name: mongoDoc.stage_name,
          bus_id: mongoDoc.bus_id,
          fare: mongoDoc.fare,
          status: mongoDoc.status,
          cancellation_reason: mongoDoc.cancellation_reason || null,
          request_date: mongoDoc.request_date,
          academic_year: mongoDoc.academic_year,
          application_number: mongoDoc.application_number,
          application_serial: mongoDoc.application_serial,
        });
      }
    } catch (mongoErr) {
      console.warn('[getStudentTransportRequest] Mongo query error:', mongoErr?.message || mongoErr);
    }

    let pool;
    try {
      pool = getSecondaryPool();
      let query = `SELECT id, admission_number, student_name, route_id, route_name, stage_name, bus_id, fare, status, cancellation_reason, request_date, academic_year, application_number, application_serial 
                   FROM transport_requests 
                   WHERE admission_number = ?`;
      const params = [admNo];

      if (normalizedAY) {
        query += ' AND academic_year = ?';
        params.push(normalizedAY);
      }

      query += ' ORDER BY request_date DESC LIMIT 1';

      const [rows] = await pool.execute(query, params);
      return successResponse(res, rows[0] || null);
    } catch {
      return successResponse(res, null);
    }
  } catch (error) {
    console.error('getStudentTransportRequest error:', error);
    return errorResponse(res, error.message || 'Failed to fetch student transport request', 500);
  }
};

/** POST /api/transport/requests/cancel — cancel active transport request + deactivate bus fee rows. */
export const cancelStudentTransportRequestHandler = async (req, res) => {
  try {
    const admissionNumber = String(req.body?.admissionNumber || req.body?.admission_number || '').trim();
    const academicYear = String(req.body?.academicYear || req.body?.academic_year || '').trim();
    const reason = String(req.body?.reason || req.body?.cancellationReason || '').trim();
    const requestId = req.body?.requestId != null ? Number(req.body.requestId) : null;
    const joiningId = String(req.body?.joiningId || req.body?.joining_id || '').trim() || null;

    if (!admissionNumber && !requestId) {
      return errorResponse(res, 'admissionNumber or requestId is required', 400);
    }
    if (!reason) {
      return errorResponse(res, 'Cancellation reason is required', 400);
    }

    try {
      getSecondaryPool();
    } catch (err) {
      return errorResponse(res, 'Secondary database is not available', 503);
    }

    const result = await cancelStudentTransportRequest({
      admissionNumber: admissionNumber || undefined,
      academicYear: academicYear || undefined,
      requestId: Number.isFinite(requestId) ? requestId : undefined,
      reason,
      joiningId,
    });

    return successResponse(res, result);
  } catch (error) {
    console.error('cancelStudentTransportRequestHandler error:', error);
    const status = /not found|already/i.test(String(error.message || '')) ? 400 : 500;
    return errorResponse(res, error.message || 'Failed to cancel transport request', status);
  }
};
