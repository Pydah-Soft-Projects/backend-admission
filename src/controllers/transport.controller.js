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
  capacity: doc.capacity ?? null,
  type: doc.type || '',
  driverName: doc.driverName || '',
  status: doc.status || '',
  assignedRouteId: doc.assignedRouteId || '',
});

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

    return successResponse(res, {
      data: routes.map(formatRouteSummary),
      total: routes.length,
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

    return successResponse(res, {
      data: {
        ...formatRouteSummary(route),
        estimatedTime: route.estimatedTime || '',
        stages: (Array.isArray(route.stages) ? route.stages : []).map(formatStage),
        buses: buses.map(formatBusSummary),
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

    let pool;
    try {
      pool = getSecondaryPool();
    } catch (err) {
      return errorResponse(res, 'Secondary database is not available', 503);
    }

    const normalizedAY = academicYear ? calendarYearToAcademicYearSession(academicYear) : null;

    let query = `SELECT id, admission_number, student_name, route_id, route_name, stage_name, bus_id, fare, status, request_date, academic_year, application_number, application_serial 
                 FROM transport_requests 
                 WHERE admission_number = ?`;
    const params = [admissionNumber];

    if (normalizedAY) {
      query += ' AND academic_year = ?';
      params.push(normalizedAY);
    }

    query += ' ORDER BY request_date DESC LIMIT 1';

    const [rows] = await pool.execute(query, params);

    return successResponse(res, rows[0] || null);
  } catch (error) {
    console.error('getStudentTransportRequest error:', error);
    return errorResponse(res, error.message || 'Failed to fetch student transport request', 500);
  }
};
