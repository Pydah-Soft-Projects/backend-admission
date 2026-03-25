import { getPool } from '../config-sql/database.js';
import { findBestMatch, similarity } from '../utils/fuzzyMatch.util.js';

// Internal Helpers for Location/Duplicate Reports
const norm = (s) => (s == null || s === '' ? '' : String(s).trim().replace(/\s+/g, ' ').toLowerCase());
const superNorm = (s) => norm(s).replace(/[^a-z0-9]/g, '');
const stripDistrictSuffix = (s) => (s == null || s === '' ? '' : String(s).trim().replace(/\s+(dist(rict)?|dt\.?)\s*$/i, '').trim());
const stripMandalSuffix = (s) => (s == null || s === '' ? '' : String(s).trim().replace(/\s+(mandal|mandalam|mndl\.?)\s*$/i, '').trim());

/**
 * @desc    Get HTML report of mismatched leads (Location validation)
 * @route   GET /api/leads/mismatch-report
 * @access  Public
 */
export const getMismatchedLeadsReport = async (req, res) => {
  try {
    const pool = getPool();
    const groupParam = req.query.group || '10th';
    const year = parseInt(req.query.year) || 2026;
    const showAll = req.query.all === 'true';
    const page = parseInt(req.query.page) || 1;
    const pageSize = 100;

    // Group mapping
    let groups = [groupParam];
    if (groupParam.toLowerCase() === 'inter') {
        groups = ['Inter', 'inter-bipc', 'inter-mpc', 'INTER-BIPC', 'INTER-MPC', 'INTER-MEC'];
    }

    // 1. Loading master data
    const [statesRows] = await pool.execute('SELECT id, name FROM states WHERE is_active = 1');
    const stateIdByName = new Map();
    statesRows.forEach(r => stateIdByName.set(norm(r.name), String(r.id)));

    const [districtsRows] = await pool.execute('SELECT id, state_id, name FROM districts WHERE is_active = 1');
    const districtsByStateId = new Map();
    districtsRows.forEach(r => {
      const sId = String(r.state_id);
      if (!districtsByStateId.has(sId)) districtsByStateId.set(sId, new Map());
      const dMap = districtsByStateId.get(sId);
      const nName = norm(r.name);
      const sName = stripDistrictSuffix(nName) || nName;
      dMap.set(nName, { id: String(r.id), name: r.name });
      if (sName !== nName) dMap.set(sName, { id: String(r.id), name: r.name });
    });

    const [mandalsRows] = await pool.execute('SELECT id, district_id, name FROM mandals WHERE is_active = 1');
    const mandalsByDistrictId = new Map();
    mandalsRows.forEach(r => {
      const dId = String(r.district_id);
      if (!mandalsByDistrictId.has(dId)) mandalsByDistrictId.set(dId, new Map());
      const mMap = mandalsByDistrictId.get(dId);
      const nName = norm(r.name);
      const sName = stripMandalSuffix(nName) || nName;
      mMap.set(nName, { id: String(r.id), name: r.name });
      if (sName !== nName) mMap.set(sName, { id: String(r.id), name: r.name });
    });

    // 2. Query Leads with parameters
    let query = `
      SELECT id, name, phone, state, district, mandal, needs_manual_update, enquiry_number, inter_college
      FROM leads 
      WHERE student_group IN (${groups.map(() => '?').join(',')})
        AND academic_year = ?
    `;
    const params = [...groups, year];
    
    if (!showAll) {
      query += ` AND needs_manual_update = 1`;
    }
    query += ` ORDER BY created_at DESC`;

    const [leads] = await pool.execute(query, params);

    const mismatches = [];
    for (const lead of leads) {
      let reason = null;
      let field = null;
      const lState = lead.state || 'Andhra Pradesh';
      const sId = stateIdByName.get(norm(lState)) || (norm(lState) === 'ap' ? stateIdByName.get('andhra pradesh') : null);

      if (!sId) {
        reason = `State "${lState}" not in master data`;
        field = 'state';
      } else {
        const districtMap = districtsByStateId.get(sId);
        const lDist = lead.district || '';
        const nDist = norm(lDist);
        const sDist = stripDistrictSuffix(nDist) || nDist;
        const dMatch = districtMap?.get(nDist) || districtMap?.get(sDist);

        if (!dMatch) {
          field = 'district';
          const candidates = Array.from(districtMap?.keys() || []);
          const best = findBestMatch(sDist, candidates, 0.70);
          reason = best ? `Incorrect District. Suggestion: "${districtMap.get(best).name}" (${Math.round(similarity(sDist, best) * 100)}% match)` : 'Not Found';
        } else {
          const mandalMap = mandalsByDistrictId.get(dMatch.id);
          const lMandal = lead.mandal || '';
          const nMandal = norm(lMandal);
          const sMandal = stripMandalSuffix(nMandal) || nMandal;
          const suMandal = superNorm(sMandal);

          let mMatch = mandalMap?.get(nMandal) || mandalMap?.get(sMandal);
          
          // Try superNorm fallback within the district
          if (!mMatch && mandalMap) {
            for (const [key, value] of mandalMap.entries()) {
              if (superNorm(key) === suMandal) {
                mMatch = value;
                reason = `Spacing/Punctuation issue. Master value: "${value.name}"`;
                break;
              }
            }
          }

          if (!mMatch) {
            field = 'mandal';
            const candidates = Array.from(mandalMap?.keys() || []);
            const best = findBestMatch(sMandal, candidates, 0.75);
            if (best) {
              const bestResult = mandalMap.get(best);
              reason = `Incorrect Mandal. Suggestion: "${bestResult.name}" (${Math.round(similarity(sMandal, best) * 100)}% match)`;
            } else {
              // Cross-district search
              let foundElsewhere = null;
              for (const [distId, mP] of mandalsByDistrictId.entries()) {
                if (mP.has(nMandal) || mP.has(sMandal)) {
                  foundElsewhere = mP.get(nMandal) || mP.get(sMandal);
                  break;
                }
                for (const [key, value] of mP.entries()) {
                  if (superNorm(key) === suMandal) {
                    foundElsewhere = value;
                    break;
                  }
                }
                if (foundElsewhere) break;
              }
              if (foundElsewhere) {
                reason = `Mandal found in different district. Correcting to its district? (Actually in master data it is in another district)`;
              } else {
                reason = 'Not Found';
              }
            }
          }
        }
      }
      if (reason) {
        mismatches.push({ ...lead, reason, field });
      }
    }

    // 3. PAGINATION
    const totalMismatches = mismatches.length;
    const totalPages = Math.ceil(totalMismatches / pageSize);
    const startIdx = (page - 1) * pageSize;
    const paginatedMismatches = mismatches.slice(startIdx, startIdx + pageSize);

    // 4. Construct HTML
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Location Mismatch Report</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f0f4f8; padding: 40px; color: #333; }
          .container { max-width: 1400px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
          h1 { color: #2d3748; margin-top: 0; font-size: 24px; border-bottom: 2px solid #e2e8f0; padding-bottom: 15px; }
          
          .filters { background: #fff; border: 1px solid #e2e8f0; padding: 20px; border-radius: 8px; margin-bottom: 25px; display: flex; gap: 20px; align-items: flex-end; box-shadow: inset 0 2px 4px rgba(0,0,0,0.02); }
          .filter-item { display: flex; flex-direction: column; gap: 5px; }
          .filter-item label { font-size: 11px; font-weight: bold; color: #718096; text-transform: uppercase; }
          .filter-item select, .filter-item input { padding: 8px 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px; min-width: 150px; }
          .btn-refresh { background: #2b6cb0; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: bold; cursor: pointer; transition: background 0.2s; }
          .btn-refresh:hover { background: #2c5282; }

          .summary { display: flex; gap: 40px; margin-bottom: 25px; background: #edf2f7; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0; }
          .stat { font-size: 14px; color: #4a5568; }
          .stat strong { font-size: 18px; color: #2d3748; display: block; }

          .pagination { display: flex; gap: 10px; align-items: center; margin-bottom: 20px; justify-content: center; background: #fff; padding: 15px; border-radius: 8px; }
          .page-btn { padding: 8px 16px; background: white; border: 1px solid #cbd5e0; border-radius: 6px; text-decoration: none; color: #4a5568; font-weight: 500; }
          .page-btn:hover { background: #edf2f7; }
          .page-btn.disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }

          table { width: 100%; border-collapse: collapse; font-size: 13px; }
          th { background: #f7fafc; color: #718096; text-align: left; padding: 12px 15px; text-transform: uppercase; font-size: 11px; border-bottom: 2px solid #e2e8f0; }
          td { padding: 12px 15px; border-bottom: 1px solid #edf2f7; }
          .reason { color: #c53030; font-weight: 500; }
          .field-tag { background: #fed7d7; color: #9b2c2c; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; margin-right: 5px; }
          .id-cell { font-family: monospace; color: #a0aec0; font-size: 11px; }
          .empty { text-align: center; padding: 60px; color: #a0aec0; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Location Mismatch Report</h1>
          
          <form class="filters" id="filterForm" method="GET">
            <input type="hidden" name="page" value="1" />
            <div class="filter-item">
              <label>Student Group</label>
              <select name="group" onchange="document.getElementById('filterForm').submit()">
                <option value="10th" ${groupParam === '10th' ? 'selected' : ''}>10th</option>
                <option value="Inter" ${groupParam === 'Inter' ? 'selected' : ''}>Inter</option>
              </select>
            </div>
            <div class="filter-item">
              <label>Academic Year</label>
              <input type="number" name="year" value="${year}" onchange="document.getElementById('filterForm').submit()" />
            </div>
            <div class="filter-item">
              <label style="display:flex; align-items:center; gap: 8px; text-transform: none; font-size: 14px; font-weight: normal; color: #333; cursor:pointer;">
                <input type="checkbox" name="all" value="true" ${showAll ? 'checked' : ''} onchange="document.getElementById('filterForm').submit()" style="min-width:auto;" /> Show All Records
              </label>
            </div>
            <button type="submit" class="btn-refresh">Refresh Report</button>
          </form>

          <div class="summary">
            <div class="stat"><strong>${groupParam}</strong>Group</div>
            <div class="stat"><strong>${year}</strong>Year</div>
            <div class="stat"><strong>${totalMismatches}</strong>Mismatched Records</div>
            <div class="stat"><strong>${showAll ? 'YES' : 'NO'}</strong>Viewing All Records</div>
          </div>

          <div class="pagination">
            <a href="?group=${groupParam}&year=${year}&all=${showAll}&page=${page - 1}" class="page-btn ${page === 1 ? 'disabled' : ''}">← Previous 100</a>
            <span style="font-weight: bold; color: #718096;">Page ${page} of ${totalPages || 1}</span>
            <a href="?group=${groupParam}&year=${year}&all=${showAll}&page=${page + 1}" class="page-btn ${page >= totalPages ? 'disabled' : ''}">Next 100 →</a>
          </div>

          ${paginatedMismatches.length > 0 ? `
            <table>
              <thead>
                <tr>
                  <th>Enquiry #</th>
                  <th>Student Name</th>
                  <th>${(groupParam.toLowerCase() === '10th') ? 'School' : 'College'}</th>
                  <th>Location</th>
                  <th>Issue / Suggestion</th>
                </tr>
              </thead>
              <tbody>
                ${paginatedMismatches.map(m => `
                  <tr>
                    <td class="id-cell">${m.enquiry_number || m.id.slice(0,8)}</td>
                    <td>
                      <strong>${m.name}</strong><br/>
                      <small style="color:#718096;">${m.phone || 'No Phone'}</small>
                    </td>
                    <td>${m.inter_college || 'N/A'}</td>
                    <td>${m.district || 'N/A'} / ${m.mandal || 'N/A'}</td>
                    <td>
                      <span class="field-tag">${m.field}</span>
                      <span class="reason">${m.reason}</span>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>

            <div class="pagination" style="margin-top: 30px;">
              <a href="?group=${groupParam}&year=${year}&all=${showAll}&page=${page - 1}" class="page-btn ${page === 1 ? 'disabled' : ''}">← Previous 100</a>
              <span style="font-weight: bold; color: #718096;">Page ${page} of ${totalPages || 1}</span>
              <a href="?group=${groupParam}&year=${year}&all=${showAll}&page=${page + 1}" class="page-btn ${page >= totalPages ? 'disabled' : ''}">Next 100 →</a>
            </div>
          ` : '<div class="empty">No mismatches found for the current filters.</div>'}
        </div>
      </body>
      </html>
    `;

    res.header('Content-Type', 'text/html');
    return res.send(html);
  } catch (error) {
    console.error('Mismatch Report Error:', error);
    return res.status(500).send(`<h1>Error generating report</h1><p>${error.message}</p>`);
  }
};

/**
 * @desc    Get HTML report of duplicate leads
 * @route   GET /api/leads/duplicate-report
 * @access  Public
 */
export const getDuplicateLeadsReport = async (req, res) => {
  try {
    const pool = getPool();
    const groupParam = req.query.group || '10th';
    const year = parseInt(req.query.year) || 2026;
    const page = parseInt(req.query.page) || 1;
    const pageSize = 100;

    // Group mapping: 'Inter' includes sub-groups
    let groups = [groupParam];
    if (groupParam.toLowerCase() === 'inter') {
      groups = ['Inter', 'inter-bipc', 'inter-mpc', 'INTER-BIPC', 'INTER-MPC', 'INTER-MEC'];
    }

    // 1. Fetch all leads for the target parameters
    const [leads] = await pool.execute(`
      SELECT id, name, phone, father_phone, alternate_mobile, enquiry_number, father_name, district, mandal, created_at, updated_at, source, lead_status, inter_college
      FROM leads
      WHERE student_group IN (${groups.map(() => '?').join(',')})
        AND academic_year = ?
    `, [...groups, year]);

    // 2. Build a map of Phone Number -> List of Leads
    const phoneToLeads = new Map();
    const leadsWithNoPhone = [];

    const addLeadToNumber = (num, lead) => {
      if (!num || num.trim() === '' || num.length < 5) return false;
      const cleanNum = num.trim();
      if (!phoneToLeads.has(cleanNum)) phoneToLeads.set(cleanNum, new Map());
      phoneToLeads.get(cleanNum).set(lead.id, lead);
      return true;
    };

    leads.forEach(lead => {
      const hasS = addLeadToNumber(lead.phone, lead);
      const hasF = addLeadToNumber(lead.father_phone, lead);
      const hasA = addLeadToNumber(lead.alternate_mobile, lead);
      
      if (!hasS && !hasF && !hasA) {
        leadsWithNoPhone.push(lead);
      }
    });

    // 3. Filter for numbers that have more than 1 lead associated
    const duplicateGroups = [];
    let totalRecordsInvolved = new Set();
    let exactNameMatchGroupsCount = 0;

    for (const [phone, leadMap] of phoneToLeads.entries()) {
      if (leadMap.size > 1) {
        const groupLeads = Array.from(leadMap.values());
        
        // Identify exact name matches within this group
        const nameCounts = {};
        groupLeads.forEach(r => {
          const sn = superNorm(r.name);
          nameCounts[sn] = (nameCounts[sn] || 0) + 1;
        });

        Object.keys(nameCounts).forEach(sn => {
          if (nameCounts[sn] > 1) exactNameMatchGroupsCount++;
        });

        const processedRecords = groupLeads.map(r => ({
          ...r,
          isExactNameMatch: nameCounts[superNorm(r.name)] > 1
        }));

        // Sort: 
        // 1. Name
        // 2. Has Phone (Records with student phone come first)
        // 3. Updated At DESC
        processedRecords.sort((a, b) => {
          const nameComparison = norm(a.name).localeCompare(norm(b.name));
          if (nameComparison !== 0) return nameComparison;
          
          const aHasPhone = a.phone && a.phone.trim().length >= 5 ? 1 : 0;
          const bHasPhone = b.phone && b.phone.trim().length >= 5 ? 1 : 0;
          if (aHasPhone !== bHasPhone) return bHasPhone - aHasPhone;

          return new Date(b.updated_at) - new Date(a.updated_at);
        });

        duplicateGroups.push({
          phone,
          count: groupLeads.length,
          records: processedRecords
        });

        groupLeads.forEach(l => totalRecordsInvolved.add(l.id));
      }
    }

    // Identify Name-Only duplicates for leads with NO phone
    const nameToNoPhoneLeads = new Map();
    leadsWithNoPhone.forEach(l => {
      const sn = superNorm(l.name);
      if (!nameToNoPhoneLeads.has(sn)) nameToNoPhoneLeads.set(sn, []);
      nameToNoPhoneLeads.get(sn).push(l);
    });

    const nameOnlyGroups = [];
    for (const [sn, groupLeads] of nameToNoPhoneLeads.entries()) {
      if (groupLeads.length > 1) {
        groupLeads.sort((a,b) => new Date(b.updated_at) - new Date(a.updated_at));
        nameOnlyGroups.push({
          name: groupLeads[0].name,
          count: groupLeads.length,
          records: groupLeads,
          isNameOnly: true
        });
        groupLeads.forEach(l => totalRecordsInvolved.add(l.id));
      }
    }

    // Sort groups by duplicate count DESC
    duplicateGroups.sort((a, b) => b.count - a.count);

    // PAGINATION LOGIC
    const totalGroups = duplicateGroups.length;
    const totalPages = Math.ceil(totalGroups / pageSize);
    const startIdx = (page - 1) * pageSize;
    const paginatedGroups = duplicateGroups.slice(startIdx, startIdx + pageSize);

    // 4. Construct HTML
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Duplicate Leads Report</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #fdf2f2; padding: 40px; color: #333; }
          .container { max-width: 1400px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
          h1 { color: #c53030; margin-top: 0; font-size: 24px; border-bottom: 2px solid #feb2b2; padding-bottom: 15px; }
          
          .filters { background: #fff; border: 1px solid #e2e8f0; padding: 20px; border-radius: 8px; margin-bottom: 25px; display: flex; gap: 20px; align-items: flex-end; box-shadow: inset 0 2px 4px rgba(0,0,0,0.02); }
          .filter-item { display: flex; flex-direction: column; gap: 5px; }
          .filter-item label { font-size: 11px; font-weight: bold; color: #718096; text-transform: uppercase; }
          .filter-item select, .filter-item input { padding: 8px 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px; min-width: 150px; }
          .btn-refresh { background: #c53030; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: bold; cursor: pointer; transition: background 0.2s; }
          .btn-refresh:hover { background: #9b2c2c; }

          .summary { background: #fff5f5; padding: 15px; border-radius: 8px; margin-bottom: 25px; display: flex; gap: 40px; border: 1px solid #fed7d7; }
          .stat { font-size: 14px; color: #742a2a; }
          .stat strong { font-size: 18px; color: #c53030; display: block; }
          .pagination { display: flex; gap: 10px; align-items: center; margin-bottom: 20px; justify-content: center; background: #fff; padding: 15px; border-radius: 8px; }
          .page-btn { padding: 8px 16px; background: white; border: 1px solid #cbd5e0; border-radius: 6px; text-decoration: none; color: #4a5568; font-weight: 500; }
          .page-btn:hover { background: #edf2f7; }
          .page-btn.disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }
          .duplicate-group { margin-bottom: 30px; border: 1px solid #eee; border-radius: 8px; overflow: hidden; }
          .name-only-group { border-color: #cbd5e0; background: #f7fafc; }
          .group-header { background: #f8f9fa; padding: 10px 15px; font-weight: bold; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; }
          .phone-tag { color: #2b6cb0; }
          .name-tag { color: #4a5568; }
          .count-tag { background: #fed7d7; color: #c53030; padding: 2px 8px; border-radius: 99px; font-size: 12px; }
          table { width: 100%; border-collapse: collapse; font-size: 13px; }
          th { background: #fff; color: #718096; text-align: left; padding: 10px 15px; text-transform: uppercase; font-size: 11px; border-bottom: 1px solid #eee; }
          td { padding: 10px 15px; border-bottom: 1px solid #f7fafc; }
          .id-cell { font-family: monospace; color: #718096; font-size: 11px; }
          .exact-match { background: #fff5f5; }
          .match-tag { background: #c53030; color: white; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: bold; margin-left: 8px; }
          .phone-val { font-size: 11px; color: #4a5568; display: block; }
          .match-source { font-style: italic; color: #9b2c2c; font-size: 11px; }
          .updated-cell { font-weight: bold; color: #2d3748; }
          .no-phone-record { opacity: 0.7; font-style: italic; }
          .empty { text-align: center; padding: 60px; color: #a0aec0; }
          h2 { font-size: 18px; color: #4a5568; margin-top: 50px; border-bottom: 1px solid #e2e8f0; padding-bottom: 10px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Duplicate Leads Report</h1>
          
          <form class="filters" id="filterForm" method="GET">
            <input type="hidden" name="page" value="1" />
            <div class="filter-item">
              <label>Student Group</label>
              <select name="group" onchange="document.getElementById('filterForm').submit()">
                <option value="10th" ${groupParam === '10th' ? 'selected' : ''}>10th</option>
                <option value="Inter" ${groupParam === 'Inter' ? 'selected' : ''}>Inter</option>
              </select>
            </div>
            <div class="filter-item">
              <label>Academic Year</label>
              <input type="number" name="year" value="${year}" onchange="document.getElementById('filterForm').submit()" />
            </div>
            <button type="submit" class="btn-refresh">Refresh Report</button>
          </form>

          <div class="summary">
            <div class="stat"><strong>${groupParam}</strong>Student Group</div>
            <div class="stat"><strong>${year}</strong>Academic Year</div>
            <div class="stat"><strong>${totalGroups}</strong>Verified Number Groups</div>
            <div class="stat"><strong>${totalRecordsInvolved.size}</strong>Total Records Flagged</div>
          </div>

          <div class="pagination">
            <a href="?group=${groupParam}&year=${year}&page=${page - 1}" class="page-btn ${page === 1 ? 'disabled' : ''}">← Previous 100</a>
            <span style="font-weight: bold; color: #718096;">Page ${page} of ${totalPages || 1}</span>
            <a href="?group=${groupParam}&year=${year}&page=${page + 1}" class="page-btn ${page >= totalPages ? 'disabled' : ''}">Next 100 →</a>
          </div>
          
          ${paginatedGroups.length > 0 ? paginatedGroups.map(group => `
            <div class="duplicate-group">
              <div class="group-header">
                <span class="phone-tag">Match Found on Number: ${group.phone}</span>
                <span class="count-tag">${group.count} records share this number</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Enquiry #</th>
                    <th>Student Name</th>
                    <th>${(groupParam.toLowerCase() === '10th') ? 'School' : 'College'}</th>
                    <th>Phones Found</th>
                    <th>Status</th>
                    <th>Last Activity</th>
                    <th>Created</th>
                    <th>Location</th>
                  </tr>
                </thead>
                <tbody>
                  ${group.records.map(r => `
                    <tr class="${r.isExactNameMatch ? 'exact-match' : ''} ${!(r.phone && r.phone.trim().length >= 5) ? 'no-phone-record' : ''}">
                      <td class="id-cell">${r.enquiry_number || r.id.slice(0,8)}</td>
                      <td>
                        <strong>${r.name}</strong>
                        ${r.isExactNameMatch ? '<span class="match-tag">EXACT NAME MATCH</span>' : ''}
                      </td>
                      <td>${r.inter_college || 'N/A'}</td>
                      <td>
                        <span class="phone-val">S: ${r.phone || 'N/A'} ${r.phone === group.phone ? '<span class="match-source">★</span>' : ''}</span>
                        <span class="phone-val">F: ${r.father_phone || 'N/A'} ${r.father_phone === group.phone ? '<span class="match-source">★</span>' : ''}</span>
                        <span class="phone-val">A: ${r.alternate_mobile || 'N/A'} ${r.alternate_mobile === group.phone ? '<span class="match-source">★</span>' : ''}</span>
                      </td>
                      <td><span style="background: #ebf8ff; color: #2b6cb0; padding: 2px 6px; border-radius: 4px; font-size: 11px;">${r.lead_status}</span></td>
                      <td class="updated-cell">${new Date(r.updated_at).toLocaleString()}</td>
                      <td>${new Date(r.created_at).toLocaleDateString()}</td>
                      <td>${r.district} / ${r.mandal}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `).join('') : ''}

          ${page === 1 && nameOnlyGroups.length > 0 ? `
            <h2>Duplicates with NO phone numbers (Sample)</h2>
            <p style="font-size: 13px; color: #718096; margin-bottom: 15px;">These records have the same name but no valid phone numbers were found to verify.</p>
            ${nameOnlyGroups.slice(0, 50).map(group => `
              <div class="duplicate-group name-only-group">
                <div class="group-header">
                  <span class="name-tag">Potential Duplicate Name: ${group.name}</span>
                  <span class="count-tag" style="background:#e2e8f0; color:#4a5568;">${group.count} records</span>
                </div>
                <table>
                  <tbody>
                    ${group.records.map(r => `
                      <tr>
                        <td class="id-cell" style="width: 120px;">${r.enquiry_number || r.id.slice(0,8)}</td>
                        <td><strong>${r.name}</strong></td>
                        <td style="width: 150px;"><span style="background: #edf2f7; color: #4a5568; padding: 2px 6px; border-radius: 4px; font-size: 11px;">${r.lead_status}</span></td>
                        <td style="width: 200px;">${new Date(r.updated_at).toLocaleString()}</td>
                        <td>${r.district} / ${r.mandal}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            `).join('')}
          ` : ''}

          <div class="pagination" style="margin-top: 30px;">
            <a href="?group=${groupParam}&year=${year}&page=${page - 1}" class="page-btn ${page === 1 ? 'disabled' : ''}">← Previous 100</a>
            <span style="font-weight: bold; color: #718096;">Page ${page} of ${totalPages || 1}</span>
            <a href="?group=${groupParam}&year=${year}&page=${page + 1}" class="page-btn ${page >= totalPages ? 'disabled' : ''}">Next 100 →</a>
          </div>

          ${totalGroups === 0 && nameOnlyGroups.length === 0 ? '<div class="empty">No duplicate leads found.</div>' : ''}
        </div>
      </body>
      </html>
    `;

    res.header('Content-Type', 'text/html');
    return res.send(html);
  } catch (error) {
    console.error('Duplicate Report Error:', error);
    return res.status(500).send(`<h1>Error generating report</h1><p>${error.message}</p>`);
  }
};
