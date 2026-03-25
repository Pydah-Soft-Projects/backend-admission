import { getPool } from '../config-sql/database.js';
import Excel from 'exceljs';
import { successResponse, errorResponse } from '../utils/response.util.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * @desc    Optimized Bulk update student groups for existing leads (targets 'Inter' group)
 * @route   POST /api/leads/bulk-group-update
 * @access  Private (Super Admin only)
 */
export const bulkUpdateLeadGroups = async (req, res) => {
  if (!req.file) {
    return errorResponse(res, 'Please upload an Excel file', 400);
  }

  const pool = getPool();
  const filePath = req.file.path;
  
  try {
    console.log(`[Group Sync] Starting upload for: ${filePath}`);
    // Clear temp table first
    await pool.execute('TRUNCATE TABLE lead_group_updates');

    // Optimization: Use Stream Reader for large files (4 lakh records)
    const workbookReader = new Excel.stream.xlsx.WorkbookReader(filePath, {
      entries: 'emit',
      sharedStrings: 'cache',
      worksheets: 'emit',
    });

    let count = 0;
    let batch = [];
    const BATCH_SIZE = 5000;
    let nameIdx = 0, phoneIdx = 0, groupIdx = 0;

    for await (const worksheetReader of workbookReader) {
      for await (const row of worksheetReader) {
        // Search first few rows for headers if not found yet
        if (!nameIdx || !phoneIdx || !groupIdx) {
          row.eachCell((cell, colNumber) => {
            const cellValue = cell.value;
            const header = (typeof cellValue === 'string' ? cellValue : (cellValue?.result || String(cellValue || ''))).trim().toLowerCase().replace(/[-_\s]/g, '');
            
            console.log(`[Group Sync] Checking Row ${row.number} Col ${colNumber}: "${header}"`);

            if (header.includes('stuname') || header === 'name') nameIdx = colNumber;
            if (header.includes('stumobileno') || header.includes('phone') || header.includes('mobile')) phoneIdx = colNumber;
            if (header.includes('coursename') || header.includes('studentgroup') || header.includes('group')) groupIdx = colNumber;
          });

          if (nameIdx || phoneIdx || groupIdx) {
            console.log(`[Group Sync] Headers identified - Name: Col ${nameIdx}, Phone: Col ${phoneIdx}, Group: Col ${groupIdx}`);
            if (row.number === 1 || (nameIdx && phoneIdx && groupIdx)) continue; // Skip header row if fully found
          }
          
          if (row.number > 5 && (!phoneIdx || !groupIdx)) {
             // If we reached row 5 and still no phone/group, we might have missed it or file is invalid
             console.warn('[Group Sync] Warning: Essential headers (phone/group) not clearly identified by row 5.');
          }
          
          if (row.number <= 5) continue; // Keep looking for headers in early rows
        }

        const nameValue = row.getCell(nameIdx || 1).value;
        const phoneValue = row.getCell(phoneIdx || 2).value;
        const groupValue = row.getCell(groupIdx || 3).value;

        // Extract string values safely
        const getName = (val) => (typeof val === 'string' ? val : (val?.result || String(val || ''))).trim();
        const name = getName(nameValue);
        const phone = getName(phoneValue);
        const group = getName(groupValue);

        // Skip the header itself if it was not found on Row 1 or if it recurs
        const isHeaderRow = 
          phone.toUpperCase().includes('MOBILE') || 
          group.toUpperCase().includes('NAME') || 
          group.toUpperCase().includes('COURSE') ||
          group.toUpperCase().includes('GROUP');

        if (phone && group && !isHeaderRow) {
          // Normalize BPC to BIPC as per user request
          const normalizedGroup = group.trim().toUpperCase() === 'BPC' ? 'BIPC' : group;
          
          batch.push([
            phone,
            name || 'Unknown',
            normalizedGroup
          ]);
          count++;

          if (batch.length >= BATCH_SIZE) {
            const valuesPlaceholder = batch.map(() => '(?, ?, ?)').join(',');
            await pool.execute(
              `INSERT INTO lead_group_updates (mobile_number, name, student_group) VALUES ${valuesPlaceholder}`,
              batch.flat()
            );
            console.log(`[Group Sync] Staged ${count.toLocaleString()} records...`);
            batch = [];
          }
        }
      }
    }

    // Insert remaining records
    if (batch.length > 0) {
      const valuesPlaceholder = batch.map(() => '(?, ?, ?)').join(',');
      await pool.execute(
        `INSERT INTO lead_group_updates (mobile_number, name, student_group) VALUES ${valuesPlaceholder}`,
        batch.flat()
      );
    }
    
    console.log(`[Group Sync] Staging complete. Total: ${count.toLocaleString()} records.`);

    // Final update logic removed from here as per user request for manual control
    return successResponse(res, {
      totalInExcel: count,
      stagedInTempTable: count,
      message: `Successfully processed ${count.toLocaleString()} records and staged in sync area.`
    }, 'Excel data staged successfully', 200);

  } catch (error) {
    console.error('[Group Sync] Staging Error:', error);
    return errorResponse(res, error.message || 'Failed to process bulk group update', 500);
  }
};

/**
 * @desc    Execute a chunk of the group sync update
 * @route   POST /api/leads/execute-group-sync
 * @access  Private (Super Admin only)
 */
export const executeLeadGroupSync = async (req, res) => {
  const pool = getPool();
  // Get processing parameters (defaults to 5000 if not provided)
  const limit = parseInt(req.body.limit) || 5000;
  const offset = parseInt(req.body.offset) || 0;
  
  try {
    // Perform the update operation in a chunk
    // Use pool.query (instead of execute) as LIMIT/OFFSET in subqueries 
    // can sometimes fail with prepared statements (mysqld_stmt_execute)
    const [updateResult] = await pool.query(`
      UPDATE leads l
      INNER JOIN (
        SELECT mobile_number, name, student_group 
        FROM lead_group_updates 
        LIMIT ? OFFSET ?
      ) u ON 
        l.phone = u.mobile_number COLLATE utf8mb4_unicode_ci 
        AND l.name = u.name COLLATE utf8mb4_unicode_ci
      SET l.student_group = CASE 
          WHEN u.student_group = 'MPC' THEN 'Inter-MPC'
          WHEN u.student_group = 'BIPC' OR u.student_group = 'BPC' THEN 'Inter-BIPC'
          WHEN u.student_group NOT LIKE 'Inter-%' THEN CONCAT('Inter-', u.student_group)
          ELSE u.student_group 
        END
      WHERE l.student_group = 'Inter'
    `, [limit, offset]);

    return successResponse(res, {
      updatedInChunk: updateResult.affectedRows,
      chunkSize: limit,
      offset: offset
    }, 'Chunk synchronized successfully', 200);

  } catch (error) {
    console.error('[Group Sync] Chunk Execution Error:', error);
    return errorResponse(res, error.message || 'Failed to execute group sync chunk', 500);
  }
};

/**
 * @desc    Get count of currently staged records
 * @route   GET /api/leads/staged-count
 * @access  Private (Super Admin only)
 */
export const getStagedCount = async (req, res) => {
  const pool = getPool();
  try {
    const [rows] = await pool.execute('SELECT COUNT(*) as count FROM lead_group_updates');
    const count = Number(rows[0]?.count || 0);
    return successResponse(res, { count }, 'Staged count retrieved', 200);
  } catch (error) {
    console.error('[Group Sync] Count Error:', error);
    return errorResponse(res, 'Failed to fetch staged count', 500);
  }
};

/**
 * @desc    Revert the needs_manual_update flag for all synced leads
 * @route   POST /api/leads/revert-group-sync-flag
 * @access  Private (Super Admin only)
 */
export const revertManualUpdateFlag = async (req, res) => {
  const pool = getPool();
  try {
    const [result] = await pool.execute(`
      UPDATE leads l
      INNER JOIN lead_group_updates u ON 
        l.phone = u.mobile_number COLLATE utf8mb4_unicode_ci 
        AND l.name = u.name COLLATE utf8mb4_unicode_ci
      SET l.needs_manual_update = 0
      WHERE l.needs_manual_update = 2
    `);
    
    return successResponse(res, { affectedRows: result.affectedRows }, 'Manual update flags reverted successfully', 200);
  } catch (error) {
    console.error('[Group Sync] Revert Flag Error:', error);
    return errorResponse(res, 'Failed to revert manual update flags', 500);
  }
};
