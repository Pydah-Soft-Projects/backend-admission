import { getPool } from '../config-sql/database.js';
import Excel from 'exceljs';
import { successResponse, errorResponse } from '../utils/response.util.js';

const STAGING_TABLE = 'lead_location_staging';

/**
 * Normalize header cell to match common Excel column titles
 */
const normHeader = (v) => {
  const s = (typeof v === 'string' ? v : (v?.result != null ? String(v.result) : String(v || '')))
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, '');
  return s;
};

const isEnquiryColumn = (h) =>
  h.includes('enquirynumber') ||
  h === 'enquiry' ||
  h.includes('enquiryno') ||
  h.includes('enqno') ||
  h.includes('enquiry_num');

const isNameColumn = (h) =>
  h === 'name' ||
  h.includes('stuname') ||
  h.includes('studentname') ||
  h.includes('candidate') ||
  h.includes('fullname');

const isVillageColumn = (h) => h.includes('village') || h === 'vill' || h.includes('town');

const isMandalColumn = (h) => h.includes('mandal') || h.includes('mandalam');

/**
 * @desc    Stage Excel rows: Enquiry Number, Name, village, mandal → lead_location_staging
 * @route   POST /api/leads/bulk-group-update
 */
export const bulkUpdateLeadGroups = async (req, res) => {
  if (!req.file) {
    return errorResponse(res, 'Please upload an Excel file', 400);
  }

  const pool = getPool();
  const filePath = req.file.path;

  try {
    await pool.execute(`TRUNCATE TABLE ${STAGING_TABLE}`);

    const workbookReader = new Excel.stream.xlsx.WorkbookReader(filePath, {
      entries: 'emit',
      sharedStrings: 'cache',
      worksheets: 'emit',
    });

    let enquiryIdx = 0;
    let nameIdx = 0;
    let villageIdx = 0;
    let mandalIdx = 0;
    let headerRowNumber = 0;
    let batch = [];
    let count = 0;
    const BATCH_SIZE = 2000;

    const cellStr = (val) => {
      if (val == null) return '';
      if (typeof val === 'string') return val.trim();
      if (typeof val === 'object' && val.result != null) return String(val.result).trim();
      return String(val).trim();
    };

    for await (const worksheetReader of workbookReader) {
      enquiryIdx = 0;
      nameIdx = 0;
      villageIdx = 0;
      mandalIdx = 0;
      headerRowNumber = 0;

      for await (const row of worksheetReader) {
        if (!enquiryIdx || !nameIdx || !villageIdx || !mandalIdx) {
          row.eachCell((cell, colNumber) => {
            const h = normHeader(cell.value);
            if (isEnquiryColumn(h)) enquiryIdx = colNumber;
            if (isNameColumn(h)) nameIdx = colNumber;
            if (isVillageColumn(h)) villageIdx = colNumber;
            if (isMandalColumn(h)) mandalIdx = colNumber;
          });
          if (enquiryIdx && nameIdx && villageIdx && mandalIdx) {
            headerRowNumber = row.number;
          }
          if (row.number > 20 && (!enquiryIdx || !nameIdx || !villageIdx || !mandalIdx)) {
            throw new Error(
              'Could not find required columns in the first 20 rows. Add headers: Enquiry Number, Name, village, mandal.'
            );
          }
          continue;
        }

        if (row.number <= headerRowNumber) {
          continue;
        }

        const enquiry = cellStr(row.getCell(enquiryIdx).value);
        const name = cellStr(row.getCell(nameIdx).value);
        const village = cellStr(row.getCell(villageIdx).value);
        const mandal = cellStr(row.getCell(mandalIdx).value);

        if (!enquiry && !name && !village && !mandal) continue;
        if (!enquiry || !name) continue;

        batch.push([enquiry, name, village || null, mandal || null]);
        count++;

        if (batch.length >= BATCH_SIZE) {
          const placeholders = batch.map(() => '(?, ?, ?, ?)').join(',');
          await pool.execute(
            `INSERT INTO ${STAGING_TABLE} (enquiry_number, name, village, mandal) VALUES ${placeholders}`,
            batch.flat()
          );
          batch = [];
        }
      }
    }

    if (batch.length > 0) {
      const placeholders = batch.map(() => '(?, ?, ?, ?)').join(',');
      await pool.execute(
        `INSERT INTO ${STAGING_TABLE} (enquiry_number, name, village, mandal) VALUES ${placeholders}`,
        batch.flat()
      );
    }

    return successResponse(
      res,
      {
        totalInExcel: count,
        stagedInTempTable: count,
        message: `${count.toLocaleString()} row(s) staged in ${STAGING_TABLE}. Use the second tab to compare with leads (read-only; leads are not modified).`,
      },
      'Excel data staged successfully',
      200
    );
  } catch (error) {
    console.error('[Location staging] Error:', error);
    return errorResponse(res, error.message || 'Failed to stage Excel file', 500);
  }
};

/**
 * @desc    Read-only: match staging rows to leads by enquiry_number + name (TRIMmed, strict equality).
 *          Returns comparison rows including needs_manual_update from leads. Does NOT UPDATE leads.
 * @route   POST /api/leads/execute-group-sync
 */
const MAX_COMPARE_ROWS = Number(process.env.LEAD_LOCATION_COMPARE_MAX_ROWS || 200000);

export const executeLeadGroupSync = async (req, res) => {
  const pool = getPool();

  try {
    const [countRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM ${STAGING_TABLE}`);
    const cnt = Number(countRows[0]?.cnt ?? 0);

    // Always return every staged row in one response (up to MAX_COMPARE_ROWS cap)
    const limit = Math.min(cnt, MAX_COMPARE_ROWS);
    const truncated = cnt > MAX_COMPARE_ROWS;

    const [rows] =
      limit === 0
        ? [[]]
        : await pool.query(
            `
      SELECT
        s.id AS stagingId,
        s.enquiry_number AS excelEnquiryNumber,
        s.name AS excelName,
        s.village AS excelVillage,
        s.mandal AS excelMandal,
        l.id AS leadId,
        l.enquiry_number AS leadEnquiryNumber,
        l.name AS leadName,
        l.village AS leadVillage,
        l.mandal AS leadMandal,
        l.needs_manual_update AS needsManualUpdate,
        CASE
          WHEN l.id IS NULL THEN 'not_found'
          WHEN TRIM(COALESCE(s.village, '')) = TRIM(COALESCE(l.village, ''))
           AND TRIM(COALESCE(s.mandal, '')) = TRIM(COALESCE(l.mandal, '')) THEN 'matches'
          ELSE 'needs_update'
        END AS comparisonStatus
      FROM ${STAGING_TABLE} s
      LEFT JOIN leads l
        ON l.id = (
          SELECT l2.id FROM leads l2
          WHERE TRIM(l2.enquiry_number) = TRIM(s.enquiry_number)
            AND TRIM(l2.name) = TRIM(s.name)
          ORDER BY l2.updated_at DESC
          LIMIT 1
        )
      ORDER BY s.id
      LIMIT ?
      `,
            [limit]
          );

    const [nfRows] = await pool.query(
      `
      SELECT COUNT(*) AS c FROM ${STAGING_TABLE} s
      WHERE NOT EXISTS (
        SELECT 1 FROM leads l
        WHERE TRIM(l.enquiry_number) = TRIM(s.enquiry_number)
          AND TRIM(l.name) = TRIM(s.name)
      )
      `
    );

    const [nuRows] = await pool.query(
      `
      SELECT COUNT(*) AS c FROM ${STAGING_TABLE} s
      INNER JOIN leads l ON l.id = (
        SELECT l2.id FROM leads l2
        WHERE TRIM(l2.enquiry_number) = TRIM(s.enquiry_number)
          AND TRIM(l2.name) = TRIM(s.name)
        ORDER BY l2.updated_at DESC
        LIMIT 1
      )
      WHERE TRIM(COALESCE(s.village, '')) <> TRIM(COALESCE(l.village, ''))
         OR TRIM(COALESCE(s.mandal, '')) <> TRIM(COALESCE(l.mandal, ''))
      `
    );

    const [mRows] = await pool.query(
      `
      SELECT COUNT(*) AS c FROM ${STAGING_TABLE} s
      INNER JOIN leads l ON l.id = (
        SELECT l2.id FROM leads l2
        WHERE TRIM(l2.enquiry_number) = TRIM(s.enquiry_number)
          AND TRIM(l2.name) = TRIM(s.name)
        ORDER BY l2.updated_at DESC
        LIMIT 1
      )
      WHERE TRIM(COALESCE(s.village, '')) = TRIM(COALESCE(l.village, ''))
        AND TRIM(COALESCE(s.mandal, '')) = TRIM(COALESCE(l.mandal, ''))
      `
    );

    const summary = {
      totalStaged: Number(cnt) || 0,
      notFound: Number(nfRows[0]?.c) || 0,
      needsUpdate: Number(nuRows[0]?.c) || 0,
      matches: Number(mRows[0]?.c) || 0,
    };

    const mapped = (rows || []).map((r) => ({
      stagingId: r.stagingId,
      excelEnquiryNumber: r.excelEnquiryNumber,
      excelName: r.excelName,
      excelVillage: r.excelVillage,
      excelMandal: r.excelMandal,
      leadId: r.leadId || null,
      leadEnquiryNumber: r.leadEnquiryNumber || null,
      leadName: r.leadName || null,
      leadVillage: r.leadVillage ?? null,
      leadMandal: r.leadMandal ?? null,
      needsManualUpdate:
        r.needsManualUpdate === 1 || r.needsManualUpdate === true
          ? 1
          : r.needsManualUpdate === 0 || r.needsManualUpdate === false
            ? 0
            : r.needsManualUpdate ?? null,
      comparisonStatus: r.comparisonStatus,
    }));

    return successResponse(
      res,
      {
        rows: mapped,
        returned: mapped.length,
        summary,
        truncated,
        maxRows: MAX_COMPARE_ROWS,
        warning: truncated
          ? `Staged rows exceed ${MAX_COMPARE_ROWS}; only the first ${MAX_COMPARE_ROWS} are included. Set LEAD_LOCATION_COMPARE_MAX_ROWS to raise the cap.`
          : null,
      },
      'Comparison ready (read-only)',
      200
    );
  } catch (error) {
    console.error('[Location staging] Compare error:', error);
    return errorResponse(res, error.message || 'Failed to compare staged data with leads', 500);
  }
};

/**
 * @route   GET /api/leads/staged-count
 */
export const getStagedCount = async (req, res) => {
  const pool = getPool();
  try {
    const [rows] = await pool.execute(`SELECT COUNT(*) AS count FROM ${STAGING_TABLE}`);
    const count = Number(rows[0]?.count || 0);
    return successResponse(res, { count }, 'Staged count retrieved', 200);
  } catch (error) {
    console.error('[Location staging] Count error:', error);
    return errorResponse(res, 'Failed to fetch staged count', 500);
  }
};

const MAX_STAGING_LIST_ROWS = Number(
  process.env.LEAD_LOCATION_STAGING_MAX_ROWS || process.env.LEAD_LOCATION_COMPARE_MAX_ROWS || 200000
);

/**
 * Fast list: raw rows from lead_location_staging only (no join to leads).
 * @route   GET /api/leads/staged-rows
 */
export const getStagedRows = async (req, res) => {
  const pool = getPool();
  try {
    const [countRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM ${STAGING_TABLE}`);
    const totalStaged = Number(countRows[0]?.cnt ?? 0);
    const limit = Math.min(totalStaged, MAX_STAGING_LIST_ROWS);
    const truncated = totalStaged > MAX_STAGING_LIST_ROWS;

    const [rows] =
      limit === 0
        ? [[]]
        : await pool.query(
            `
      SELECT id, enquiry_number AS enquiryNumber, name, village, mandal, created_at AS createdAt
      FROM ${STAGING_TABLE}
      ORDER BY id
      LIMIT ?
      `,
            [limit]
          );

    const mapped = (rows || []).map((r) => ({
      id: r.id,
      enquiryNumber: r.enquiryNumber,
      name: r.name,
      village: r.village ?? null,
      mandal: r.mandal ?? null,
      createdAt: r.createdAt,
    }));

    return successResponse(
      res,
      {
        rows: mapped,
        totalStaged,
        returned: mapped.length,
        truncated,
        maxRows: MAX_STAGING_LIST_ROWS,
        warning: truncated
          ? `Staged rows exceed ${MAX_STAGING_LIST_ROWS}; only the first ${MAX_STAGING_LIST_ROWS} are included. Set LEAD_LOCATION_STAGING_MAX_ROWS to raise the cap.`
          : null,
      },
      'Staged rows retrieved',
      200
    );
  } catch (error) {
    console.error('[Location staging] List error:', error);
    return errorResponse(res, error.message || 'Failed to fetch staged rows', 500);
  }
};
