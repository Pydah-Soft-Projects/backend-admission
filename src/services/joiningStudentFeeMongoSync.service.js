import mongoose from 'mongoose';
import { connectFeeManagement } from '../config-mongo/feeManagement.js';
import {
  previewJoiningBusSync,
  previewJoiningHostelSync,
  syncJoiningAccommodationToExternalDbs,
} from './joiningAccommodationSync.service.js';

const { Types: { ObjectId } } = mongoose;

export const JOINING_STUDENT_FEE_MONGO_COLLECTION = 'crm_joining_student_fee_details';

const BUS_FEE_STRUCTURE_ID_PREFIX = 'joining-bus-fee-year-';
const HOSTEL_FEE_STRUCTURE_ID_PREFIX = 'joining-hostel-fee-year-';

const BUS_FEE_HEAD = {
  id: '6996e24c2e1678e39883918a',
  code: 'TRN01',
  name: 'Bus Fee',
};

const HOSTEL_FEE_HEAD = {
  id: '6996e24d2e1678e398839196',
  code: 'HST01',
  name: 'Hostel Fee',
};

const QUOTA_TO_CATEGORY = {
  convenor: 'CONV',
  convener: 'CONV',
  conv: 'CONV',
  management: 'MANG',
  mang: 'MANG',
  spot: 'SPOT',
  'spot admission': 'SPOT',
  'lateral entry': 'CONV',
  'lateral spot': 'SPOT',
};

const normalize = (value) =>
  typeof value === 'string' ? value.trim() : value === undefined ? '' : String(value);

const mapQuotaToCategory = (quota) => {
  const key = normalize(quota).toLowerCase();
  if (!key) return '';
  if (QUOTA_TO_CATEGORY[key]) return QUOTA_TO_CATEGORY[key];
  for (const [needle, bucket] of Object.entries(QUOTA_TO_CATEGORY)) {
    if (key.includes(needle)) return bucket;
  }
  return key.toUpperCase();
};

const exactIRegex = (value) => {
  const escaped = normalize(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'i');
};

const isBusStructureId = (id) => String(id || '').startsWith(BUS_FEE_STRUCTURE_ID_PREFIX);
const isHostelStructureId = (id) => String(id || '').startsWith(HOSTEL_FEE_STRUCTURE_ID_PREFIX);

const getHostelFeeForYear = (transport, studentYear) => {
  const byYear = transport?.hostelFeesByYear;
  if (Array.isArray(byYear) && byYear.length > 0) {
    const row = byYear.find((fee) => Number(fee.studentYear) === studentYear);
    if (row?.amount != null && Number.isFinite(Number(row.amount))) return Number(row.amount);
  }
  if (transport?.hostelFee != null && Number.isFinite(Number(transport.hostelFee))) {
    return Number(transport.hostelFee);
  }
  return 0;
};

const buildAccommodationCatalogRows = (transportDetails, overrideMap) => {
  if (!transportDetails || typeof transportDetails !== 'object') return [];

  if (transportDetails.accommodationType === 'bus' && transportDetails.routeId && transportDetails.stageId) {
    const overrideIds = [...overrideMap.keys()].filter(isBusStructureId);
    const years = overrideIds.length
      ? overrideIds.map((id) => Number(String(id).replace(BUS_FEE_STRUCTURE_ID_PREFIX, ''))).filter((y) => y > 0)
      : [1];

    const uniqueYears = [...new Set(years.length ? years : [1])].sort((a, b) => a - b);
    return uniqueYears.map((studentYear) => ({
      _id: `${BUS_FEE_STRUCTURE_ID_PREFIX}${studentYear}`,
      studentYear,
      amount: Number(transportDetails.stageFare) || 0,
      feeHead: BUS_FEE_HEAD.id,
      feeHeadCode: BUS_FEE_HEAD.code,
      feeHeadName: BUS_FEE_HEAD.name,
      accommodationType: 'bus',
    }));
  }

  if (
    transportDetails.accommodationType === 'hostel' &&
    transportDetails.hostelId &&
    transportDetails.categoryId
  ) {
    const overrideIds = [...overrideMap.keys()].filter(isHostelStructureId);
    const years = overrideIds.length
      ? overrideIds
          .map((id) => Number(String(id).replace(HOSTEL_FEE_STRUCTURE_ID_PREFIX, '')))
          .filter((y) => y > 0)
      : (transportDetails.hostelFeesByYear || []).map((row) => Number(row.studentYear)).filter((y) => y > 0);

    const uniqueYears = [...new Set(years.length ? years : [1])].sort((a, b) => a - b);
    return uniqueYears.map((studentYear) => ({
      _id: `${HOSTEL_FEE_STRUCTURE_ID_PREFIX}${studentYear}`,
      studentYear,
      amount: getHostelFeeForYear(transportDetails, studentYear),
      feeHead: HOSTEL_FEE_HEAD.id,
      feeHeadCode: HOSTEL_FEE_HEAD.code,
      feeHeadName: HOSTEL_FEE_HEAD.name,
      accommodationType: 'hostel',
    }));
  }

  return [];
};

const enrichWithFeeHead = async (db, structures) => {
  const headIdStrings = [
    ...new Set(
      structures
        .map((doc) => doc.feeHead)
        .filter((id) => id !== undefined && id !== null && String(id).trim() !== '')
        .map((id) => String(id))
    ),
  ];
  if (headIdStrings.length === 0) return structures;

  const objectIds = headIdStrings
    .map((id) => {
      try {
        return new ObjectId(id);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const heads = await db
    .collection('feeheads')
    .find({ _id: { $in: [...objectIds, ...headIdStrings] } })
    .toArray();
  const byId = new Map(heads.map((head) => [String(head._id), head]));

  return structures.map((doc) => {
    const head = doc.feeHead ? byId.get(String(doc.feeHead)) : null;
    return {
      ...doc,
      feeHeadCode: doc.feeHeadCode || head?.code || '',
      feeHeadName: doc.feeHeadName || head?.name || '',
    };
  });
};

const loadCatalogFeeStructures = async (db, { course, branch, quota, batch }) => {
  const category = mapQuotaToCategory(quota);
  const requestedBatch = normalize(batch);

  const buildFilter = (batchVal) => {
    const filter = {};
    if (course) filter.course = exactIRegex(course);
    if (branch) filter.branch = exactIRegex(branch);
    if (category) filter.category = category;
    if (batchVal) filter.batch = exactIRegex(batchVal);
    return filter;
  };

  const queryRows = async (batchVal) => {
    const docs = await db
      .collection('feestructures')
      .find(buildFilter(batchVal))
      .sort({ studentYear: 1 })
      .toArray();
    return enrichWithFeeHead(db, docs.map((doc) => ({ ...doc, _id: String(doc._id) })));
  };

  let resolvedBatch = requestedBatch;
  let batchMatchMode = 'exact';
  let rows = await queryRows(requestedBatch);

  // B.Tech / other programs may have fee rows under a prior intake year (e.g. 2025 vs 2026).
  if (rows.length === 0 && requestedBatch && /^\d{4}$/.test(requestedBatch)) {
    for (let offset = 1; offset <= 3; offset++) {
      const candidate = String(Number(requestedBatch) - offset);
      const fallbackRows = await queryRows(candidate);
      if (fallbackRows.length > 0) {
        rows = fallbackRows;
        resolvedBatch = candidate;
        batchMatchMode = 'fallback';
        break;
      }
    }
  }

  return {
    rows,
    catalogLookup: {
      course: normalize(course),
      branch: normalize(branch),
      quota: normalize(quota),
      categoryMapped: category,
      requestedBatch,
      resolvedBatch,
      batchMatchMode,
    },
  };
};

const buildPortalLines = (catalogRows, accommodationRows, studentFeeDetails) => {
  const overrideMap = new Map();
  for (const line of studentFeeDetails?.lines || []) {
    const id = String(line?.structureId || '').trim();
    if (id) overrideMap.set(id, line);
  }

  const merged = new Map();
  for (const row of [...catalogRows, ...accommodationRows]) {
    merged.set(String(row._id), row);
  }

  return [...merged.values()].map((row) => {
    const structureId = String(row._id);
    const override = overrideMap.get(structureId);
    const actualAmount = Number(row.amount) || 0;
    const revisedAmount =
      override?.amount !== undefined &&
      override?.amount !== null &&
      Number.isFinite(Number(override.amount))
        ? Number(override.amount)
        : actualAmount;

    return {
      structureId,
      feeHeadId: row.feeHead ? String(row.feeHead) : null,
      feeHeadCode: row.feeHeadCode || '',
      feeHeadName: row.feeHeadName || '',
      studentYear: row.studentYear ?? null,
      actualAmount,
      revisedAmount,
      isRevised: revisedAmount !== actualAmount,
      remarks: typeof override?.remarks === 'string' ? override.remarks.trim() : '',
      accommodationType: row.accommodationType || null,
    };
  });
};

/**
 * Build Step 4 outbound sync plan without writing to any database (dry-run).
 */
export async function buildJoiningStepFourSyncPlan({
  joiningId,
  leadId = null,
  studentFeeDetails = null,
  joiningContext = null,
}) {
  if (!joiningId || typeof joiningId !== 'string') {
    return { error: 'joiningId is required', feePortal: null, transport: null, hostel: null, lines: [] };
  }

  const feeUri = process.env.FEE_MANAGEMENT_MONGO_URI?.trim();
  const linesIn = Array.isArray(studentFeeDetails?.lines) ? studentFeeDetails.lines : [];
  const batch =
    studentFeeDetails?.batch != null && String(studentFeeDetails.batch).trim() !== ''
      ? String(studentFeeDetails.batch).trim().slice(0, 32)
      : joiningContext?.batch || null;

  const overrideMap = new Map();
  for (const line of linesIn) {
    const id = String(line?.structureId || '').trim();
    if (id) overrideMap.set(id, line);
  }

  const transportDetails = joiningContext?.transportDetails || null;
  const accommodationType = transportDetails?.accommodationType || null;

  if (!feeUri) {
    return {
      joiningId,
      leadId,
      batch,
      accommodationType,
      feePortal: { skipped: true, reason: 'FEE_MANAGEMENT_MONGO_URI not set' },
      transport: previewJoiningBusSync({ joiningId, leadId, joiningContext, portalLines: [] }),
      hostel: previewJoiningHostelSync({ joiningId, leadId, joiningContext, portalLines: [] }),
      lines: [],
      revisedLineCount: 0,
    };
  }

  const conn = await connectFeeManagement();
  const db = conn.db;

  const catalogResult = await loadCatalogFeeStructures(db, {
    course: joiningContext?.course || '',
    branch: joiningContext?.branch || '',
    quota: joiningContext?.quota || '',
    batch: batch || '',
  });
  const catalogRows = catalogResult.rows;
  const resolvedBatch = catalogResult.catalogLookup.resolvedBatch || batch;

  const accommodationRows = buildAccommodationCatalogRows(
    joiningContext?.transportDetails,
    overrideMap
  );

  const portalLines = buildPortalLines(catalogRows, accommodationRows, studentFeeDetails);
  const revisedLineCount = portalLines.filter((line) => line.isRevised).length;

  const feePortalDoc =
    portalLines.length === 0 && !resolvedBatch && !accommodationType
      ? {
          skipped: false,
          collection: JOINING_STUDENT_FEE_MONGO_COLLECTION,
          database: 'fee_management',
          operation: 'deleteOne',
          filter: { joiningId },
        }
      : {
          skipped: false,
          collection: JOINING_STUDENT_FEE_MONGO_COLLECTION,
          database: 'fee_management',
          operation: 'replaceOne',
          filter: { joiningId },
          document: {
            joiningId,
            leadId: leadId && String(leadId).trim() !== '' ? String(leadId).trim() : null,
            admissionNumber: joiningContext?.admissionNumber || '',
            studentName: joiningContext?.studentName || '',
            course: joiningContext?.course || '',
            branch: joiningContext?.branch || '',
            quota: joiningContext?.quota || '',
            batch: resolvedBatch,
            requestedBatch: batch,
            batchMatchMode: catalogResult.catalogLookup.batchMatchMode,
            accommodationType,
            transportDetails,
            lines: portalLines,
            legacyLines: linesIn,
            source: 'admissions_crm',
          },
        };

  return {
    joiningId,
    leadId,
    joiningContext: {
      course: joiningContext?.course || '',
      branch: joiningContext?.branch || '',
      quota: joiningContext?.quota || '',
      batch: resolvedBatch || '',
      requestedBatch: batch || '',
      admissionNumber: joiningContext?.admissionNumber || '',
      studentName: joiningContext?.studentName || '',
      accommodationType,
    },
    catalogLookup: catalogResult.catalogLookup,
    catalogRowCount: catalogRows.length,
    accommodationRowCount: accommodationRows.length,
    lineCount: portalLines.length,
    revisedLineCount,
    lines: portalLines,
    feePortal: feePortalDoc,
    transport: previewJoiningBusSync({ joiningId, leadId, joiningContext, portalLines }),
    hostel: previewJoiningHostelSync({ joiningId, leadId, joiningContext, portalLines }),
  };
}

/**
 * Push joining fee snapshot to Fee Management Mongo and external bus/hostel DBs.
 *
 * @param {object} params
 * @param {string} params.joiningId
 * @param {string | null} [params.leadId]
 * @param {object | null} [params.studentFeeDetails]
 * @param {object | null} [params.joiningContext]
 */
export async function syncJoiningStudentFeeDetailsToFeeMongo({
  joiningId,
  leadId = null,
  studentFeeDetails = null,
  joiningContext = null,
}) {
  if (!joiningId || typeof joiningId !== 'string') return { lines: [] };

  const uri = process.env.FEE_MANAGEMENT_MONGO_URI?.trim();
  if (!uri) {
    console.warn(
      '[joiningStudentFeeMongoSync] FEE_MANAGEMENT_MONGO_URI not set; skipping Fee DB mirror'
    );
    return { lines: [] };
  }

  const linesIn = Array.isArray(studentFeeDetails?.lines) ? studentFeeDetails.lines : [];
  const batch =
    studentFeeDetails?.batch != null && String(studentFeeDetails.batch).trim() !== ''
      ? String(studentFeeDetails.batch).trim().slice(0, 32)
      : joiningContext?.batch || null;

  const overrideMap = new Map();
  for (const line of linesIn) {
    const id = String(line?.structureId || '').trim();
    if (id) overrideMap.set(id, line);
  }

  let portalLines = [];

  try {
    const conn = await connectFeeManagement();
    const db = conn.db;

    const catalogResult = await loadCatalogFeeStructures(db, {
      course: joiningContext?.course || '',
      branch: joiningContext?.branch || '',
      quota: joiningContext?.quota || '',
      batch: batch || '',
    });
    const catalogRows = catalogResult.rows;
    const resolvedBatch = catalogResult.catalogLookup.resolvedBatch || batch;

    const accommodationRows = buildAccommodationCatalogRows(
      joiningContext?.transportDetails,
      overrideMap
    );

    portalLines = buildPortalLines(catalogRows, accommodationRows, studentFeeDetails);

    const coll = conn.db.collection(JOINING_STUDENT_FEE_MONGO_COLLECTION);
    const transportDetails = joiningContext?.transportDetails || null;
    const accommodationType = transportDetails?.accommodationType || null;

    if (portalLines.length === 0 && !resolvedBatch && !accommodationType) {
      await coll.deleteOne({ joiningId });
    } else {
      await coll.replaceOne(
        { joiningId },
        {
          joiningId,
          leadId: leadId && String(leadId).trim() !== '' ? String(leadId).trim() : null,
          admissionNumber: joiningContext?.admissionNumber || '',
          studentName: joiningContext?.studentName || '',
          course: joiningContext?.course || '',
          branch: joiningContext?.branch || '',
          quota: joiningContext?.quota || '',
          batch: resolvedBatch,
          requestedBatch: batch,
          batchMatchMode: catalogResult.catalogLookup.batchMatchMode,
          accommodationType,
          transportDetails,
          lines: portalLines,
          legacyLines: linesIn,
          updatedAt: new Date(),
          source: 'admissions_crm',
        },
        { upsert: true }
      );
    }
  } catch (err) {
    console.error(
      '[joiningStudentFeeMongoSync] Fee Mongo mirror failed (SQL save still succeeded):',
      err?.message || err
    );
  }

  await syncJoiningAccommodationToExternalDbs({
    joiningId,
    leadId,
    joiningContext,
    portalLines,
  });

  return { lines: portalLines };
}
