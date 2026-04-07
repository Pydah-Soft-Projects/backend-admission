/**
 * Sync mandal on `leads` from `lead_location_staging`.
 *
 * 1) Match lead: TRIM(enquiry_number) + TRIM(name), latest updated_at (MySQL 8 CTE).
 * 2) Scope: optional district filter on leads (default Konaseema) — override with SYNC_MANDAL_DISTRICT.
 * 3) Resolve staging mandal → master `mandals.name`: (a) primary fuzzy in lead
 *    district + cross-district exact/superNorm; (b) looser fuzzy in lead district;
 *    (c) optional state-wide fuzzy (SYNC_MANDAL_STATE_WIDE_FUZZY=1). Unmatched rows
 *    are listed and can be exported to CSV.
 * 4) Only `needs_manual_update = 2` leads get `mandal` set to the resolved master
 *    name and flag cleared to 0. Skips when lead.mandal already matches resolved name.
 *
 * Updates run in small batches (transactions) to reduce lock wait timeouts.
 *
 * Env:
 *   SYNC_MANDAL_DISTRICT, SYNC_MANDAL_ALL_DISTRICTS, SYNC_MANDAL_QUIET, DRY_RUN / --dry-run
 *   SYNC_MANDAL_FUZZY=0.80        primary fuzzy (lead’s district)
 *   SYNC_MANDAL_FUZZY_LOOSE=0.65  second pass on same district if primary misses
 *   SYNC_MANDAL_STATE_WIDE_FUZZY=1  third pass: fuzzy against all mandals in state (risky)
 *   SYNC_MANDAL_STATE_FUZZY_MIN=0.58  min score for state-wide pass
 *   SYNC_MANDAL_UNMATCHED_MAX=150   max rows listed in “Unmatched” section (0 = skip list)
 *   SYNC_MANDAL_UNMATCHED_FILE=path  optional CSV of unmatched (enq, name, staging mandal, …)
 *   SYNC_MANDAL_BATCH_SIZE=100  rows per transaction
 *   SYNC_MANDAL_LOG_UNRESOLVED=1  log each unresolved row during processing (verbose)
 *
 * Requires MySQL 8.0+ (ROW_NUMBER / CTE for match query).
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';
import { findBestMatch } from '../utils/fuzzyMatch.util.js';

dotenv.config();

const STAGING = 'lead_location_staging';
const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
const ALL_DISTRICTS = process.env.SYNC_MANDAL_ALL_DISTRICTS === '1';
const DISTRICT_FILTER = (process.env.SYNC_MANDAL_DISTRICT ?? 'Konaseema').trim();
const QUIET = process.env.SYNC_MANDAL_QUIET === '1';
const FUZZY_THRESHOLD = Math.min(
  1,
  Math.max(0.5, Number.parseFloat(process.env.SYNC_MANDAL_FUZZY || '0.8'))
);
const FUZZY_LOOSE = Math.min(
  1,
  Math.max(0.45, Number.parseFloat(process.env.SYNC_MANDAL_FUZZY_LOOSE || '0.65'))
);
const STATE_WIDE_FUZZY = process.env.SYNC_MANDAL_STATE_WIDE_FUZZY === '1';
const STATE_FUZZY_MIN = Math.min(
  1,
  Math.max(0.45, Number.parseFloat(process.env.SYNC_MANDAL_STATE_FUZZY_MIN || '0.58'))
);
const BATCH_SIZE = Math.min(
  500,
  Math.max(20, Number.parseInt(process.env.SYNC_MANDAL_BATCH_SIZE || '100', 10) || 100)
);
const LOG_UNRESOLVED = process.env.SYNC_MANDAL_LOG_UNRESOLVED === '1';
const UNMATCHED_MAX = Math.max(
  0,
  Number.parseInt(process.env.SYNC_MANDAL_UNMATCHED_MAX ?? '150', 10) || 150
);
const UNMATCHED_FILE = (process.env.SYNC_MANDAL_UNMATCHED_FILE || '').trim();

const norm = (s) => (s == null || s === '' ? '' : String(s).trim().replace(/\s+/g, ' ').toLowerCase());
const superNorm = (s) => norm(s).replace(/[^a-z0-9]/g, '');
const stripDistrictSuffix = (s) =>
  s == null || s === ''
    ? ''
    : String(s).trim().replace(/\s+(dist(rict)?|dt\.?)\s*$/i, '').trim();
const stripMandalSuffix = (s) =>
  s == null || s === ''
    ? ''
    : String(s).trim().replace(/\s+(mandal|mandalam|mndl\.?)\s*$/i, '').trim();

const needsManualIs2 = (v) => Number(v) === 2;

async function loadLocationMaster(pool) {
  const [statesRows] = await pool.execute('SELECT id, name FROM states WHERE is_active = 1');
  const stateIdByName = new Map();
  statesRows.forEach((r) => stateIdByName.set(norm(r.name), String(r.id)));

  const [districtsRows] = await pool.execute('SELECT id, state_id, name FROM districts WHERE is_active = 1');
  const districtsByStateId = new Map();
  districtsRows.forEach((r) => {
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
  mandalsRows.forEach((r) => {
    const dId = String(r.district_id);
    if (!mandalsByDistrictId.has(dId)) mandalsByDistrictId.set(dId, new Map());
    const mMap = mandalsByDistrictId.get(dId);
    const nName = norm(r.name);
    const sName = stripMandalSuffix(nName) || nName;
    const entry = { id: String(r.id), district_id: dId, name: r.name };
    mMap.set(nName, entry);
    if (sName !== nName) mMap.set(sName, entry);
  });

  return { stateIdByName, districtsByStateId, mandalsByDistrictId };
}

function resolveStateId(leadState, stateIdByName) {
  const finalState = leadState || 'Andhra Pradesh';
  return (
    stateIdByName.get(norm(finalState)) ||
    (norm(finalState) === 'ap' ? stateIdByName.get('andhra pradesh') : null)
  );
}

function matchLeadDistrict(leadDistrict, districtMap) {
  if (!districtMap) return null;
  const nDist = norm(leadDistrict || '');
  const sDist = stripDistrictSuffix(nDist) || nDist;
  let dMatch = districtMap.get(nDist) || districtMap.get(sDist);
  if (!dMatch) {
    const suDist = superNorm(sDist);
    for (const [key, value] of districtMap.entries()) {
      if (superNorm(key) === suDist) {
        dMatch = value;
        break;
      }
    }
  }
  return dMatch;
}

/** Exact / superNorm / optional fuzzy on one district’s mandal map. */
function tryMandalMap(mandalMap, stagingMandalText, fuzzyThr, allowFuzzy) {
  if (!mandalMap) return null;
  const nMandal = norm(stagingMandalText);
  const sMandal = stripMandalSuffix(nMandal) || nMandal;
  const suMandal = superNorm(sMandal);
  let m = mandalMap.get(nMandal) || mandalMap.get(sMandal);
  if (!m) {
    for (const [key, value] of mandalMap.entries()) {
      if (superNorm(key) === suMandal) {
        m = value;
        break;
      }
    }
  }
  if (!m && allowFuzzy) {
    const candidates = [...new Set(Array.from(mandalMap.keys()))];
    const best = findBestMatch(sMandal, candidates, fuzzyThr);
    if (best) m = mandalMap.get(best);
  }
  return m;
}

/**
 * Tier 1: primary fuzzy in lead district + cross-district exact / superNorm only.
 */
function resolveStagingMandalStrict(stagingMandalText, leadDistrict, leadState, master, fuzzyThr) {
  const { stateIdByName, districtsByStateId, mandalsByDistrictId } = master;
  const sId = resolveStateId(leadState, stateIdByName);
  if (!sId) return null;

  const districtMap = districtsByStateId.get(sId);
  if (!districtMap) return null;

  const dMatch = matchLeadDistrict(leadDistrict, districtMap);

  let mMatch = null;
  if (dMatch) {
    mMatch = tryMandalMap(mandalsByDistrictId.get(dMatch.id), stagingMandalText, fuzzyThr, true);
  }

  if (!mMatch) {
    const seenDist = new Set();
    for (const dval of districtMap.values()) {
      const id = String(dval.id);
      if (seenDist.has(id)) continue;
      seenDist.add(id);
      const hit = tryMandalMap(mandalsByDistrictId.get(id), stagingMandalText, fuzzyThr, false);
      if (hit) {
        mMatch = hit;
        break;
      }
    }
  }

  return mMatch ? mMatch.name : null;
}

/** All unique canonical mandal names in state (norm key → display name). */
function buildStateMandalNormMap(sId, master) {
  const normToCanon = new Map();
  const districtMap = master.districtsByStateId.get(sId);
  if (!districtMap) return normToCanon;

  const distIds = new Set();
  for (const v of districtMap.values()) {
    distIds.add(String(v.id));
  }
  for (const id of distIds) {
    const mm = master.mandalsByDistrictId.get(id);
    if (!mm) continue;
    const seen = new Set();
    for (const ent of mm.values()) {
      if (seen.has(ent.name)) continue;
      seen.add(ent.name);
      normToCanon.set(norm(ent.name), ent.name);
    }
  }
  return normToCanon;
}

/**
 * Tier 1 strict → tier 2 looser fuzzy (lead district only) → tier 3 optional state-wide fuzzy.
 */
function resolveStagingMandalWithFallbacks(stagingMandalText, leadDistrict, leadState, master) {
  const strictName = resolveStagingMandalStrict(
    stagingMandalText,
    leadDistrict,
    leadState,
    master,
    FUZZY_THRESHOLD
  );
  if (strictName) return { name: strictName, tier: 'strict' };

  const { stateIdByName, districtsByStateId, mandalsByDistrictId } = master;
  const sId = resolveStateId(leadState, stateIdByName);
  if (!sId) return { name: null, tier: null };

  const districtMap = districtsByStateId.get(sId);
  const dMatch = matchLeadDistrict(leadDistrict, districtMap);

  if (dMatch) {
    const looseHit = tryMandalMap(
      mandalsByDistrictId.get(dMatch.id),
      stagingMandalText,
      FUZZY_LOOSE,
      true
    );
    if (looseHit) return { name: looseHit.name, tier: 'loose-district' };
  }

  if (STATE_WIDE_FUZZY) {
    const normToCanon = buildStateMandalNormMap(sId, master);
    if (normToCanon.size === 0) return { name: null, tier: null };
    const nMandal = norm(stagingMandalText);
    const sMandal = stripMandalSuffix(nMandal) || nMandal;
    const candidates = [...normToCanon.keys()];
    const bestNormKey = findBestMatch(sMandal, candidates, STATE_FUZZY_MIN);
    if (bestNormKey && normToCanon.has(bestNormKey)) {
      return { name: normToCanon.get(bestNormKey), tier: 'state-fuzzy' };
    }
  }

  return { name: null, tier: null };
}

function buildWithClause() {
  const districtSql = ALL_DISTRICTS ? '' : 'AND l.district = ?';
  return {
    sql: `
WITH stg AS (
  SELECT id AS staging_id, enquiry_number, name, TRIM(mandal) AS new_mandal
  FROM ${STAGING}
  WHERE TRIM(COALESCE(mandal, '')) <> ''
),
ranked AS (
  SELECT
    l.id AS lead_id,
    TRIM(l.enquiry_number) AS enq,
    TRIM(l.name) AS nm,
    l.mandal AS old_mandal,
    l.needs_manual_update,
    l.district AS lead_district,
    l.state AS lead_state,
    ROW_NUMBER() OVER (
      PARTITION BY TRIM(l.enquiry_number), TRIM(l.name)
      ORDER BY l.updated_at DESC
    ) AS rn
  FROM leads l
  WHERE 1 = 1
  ${districtSql}
)`,
    params: ALL_DISTRICTS ? [] : [DISTRICT_FILTER],
  };
}

async function main() {
  const pool = getPool();
  let conn;

  try {
    conn = await pool.getConnection();
    console.log(DRY_RUN ? 'Running in DRY RUN mode (no UPDATE).\n' : 'Running LIVE (will UPDATE leads).\n');
    console.log(
      `Master mandal: primary fuzzy ≥ ${FUZZY_THRESHOLD}, district loose ≥ ${FUZZY_LOOSE}` +
        (STATE_WIDE_FUZZY ? `, state-wide fuzzy ≥ ${STATE_FUZZY_MIN}` : ' (state-wide fuzzy OFF)') +
        `; batch ${BATCH_SIZE}\n`
    );

    if (ALL_DISTRICTS) {
      console.warn('SYNC_MANDAL_ALL_DISTRICTS=1 — matching all leads in ranked CTE (heavy).\n');
    } else {
      console.log(`Lead rank restricted to district: "${DISTRICT_FILTER}"\n`);
      const [dCount] = await conn.query(`SELECT COUNT(*) AS c FROM leads WHERE district = ?`, [DISTRICT_FILTER]);
      console.log(`Leads in this district: ${Number(dCount[0]?.c ?? 0).toLocaleString()}\n`);
    }

    console.log('Loading master states / districts / mandals…');
    const master = await loadLocationMaster(pool);
    console.log('Master data loaded.\n');

    const [countStaging] = await conn.query(`SELECT COUNT(*) AS c FROM ${STAGING}`);
    const totalStagingRows = Number(countStaging[0]?.c ?? 0);
    console.log(`Rows in ${STAGING}: ${totalStagingRows}`);

    const [wouldSkipEmpty] = await conn.query(`
      SELECT COUNT(*) AS c FROM ${STAGING} WHERE TRIM(COALESCE(mandal, '')) = ''
    `);
    const emptyMandalRows = Number(wouldSkipEmpty[0]?.c ?? 0);
    const stagedWithMandal = totalStagingRows - emptyMandalRows;
    console.log(`Staging rows skipped (empty mandal — not in SQL below): ${emptyMandalRows}`);
    console.log(`Staging rows with mandal text (processed in match query): ${stagedWithMandal}\n`);

    const { sql: withSql, params: withParams } = buildWithClause();

    const selectSql = `${withSql}
SELECT
  stg.staging_id,
  stg.enquiry_number,
  stg.name,
  stg.new_mandal,
  r.lead_id,
  r.old_mandal,
  r.needs_manual_update,
  r.lead_district,
  r.lead_state
FROM stg
LEFT JOIN ranked r
  ON r.enq = TRIM(stg.enquiry_number)
  AND r.nm = TRIM(stg.name)
  AND r.rn = 1
ORDER BY stg.staging_id
`;

    console.log('Running staging → lead match (CTE)…');
    const t0 = Date.now();
    const [rows] = await conn.query(selectSql, withParams);
    console.log(`Match query done in ${((Date.now() - t0) / 1000).toFixed(2)}s\n`);

    let notFound = 0;
    let skipWrongFlag = 0;
    let skipSameMandal = 0;
    let noMasterMandal = 0;
    const tierCounts = { strict: 0, 'loose-district': 0, 'state-fuzzy': 0 };
    const toApply = [];
    const unmatched = [];

    const oldShown = (v) => (v == null || v === '' ? '(empty)' : String(v));
    const label = DRY_RUN ? '[DRY]' : '[LIVE]';

    if (!QUIET && rows.length) {
      console.log('— Resolved rows (needs_manual_update=2; staging → master mandal) —\n');
    }

    for (const row of rows) {
      if (!row.lead_id) {
        notFound++;
        continue;
      }
      if (!needsManualIs2(row.needs_manual_update)) {
        skipWrongFlag++;
        continue;
      }

      const { name: resolved, tier } = resolveStagingMandalWithFallbacks(
        row.new_mandal,
        row.lead_district,
        row.lead_state,
        master
      );

      if (resolved == null || resolved === '') {
        noMasterMandal++;
        unmatched.push({
          staging_id: row.staging_id,
          enquiry_number: row.enquiry_number,
          name: row.name,
          staging_mandal: String(row.new_mandal ?? ''),
          lead_id: row.lead_id,
          lead_district: row.lead_district ?? '',
          lead_state: row.lead_state ?? '',
          lead_mandal_current: row.old_mandal ?? '',
        });
        if (!QUIET && LOG_UNRESOLVED) {
          console.log(
            `${label} lead ${row.lead_id} | ENQ ${row.enquiry_number} | NO master mandal for staging "${String(
              row.new_mandal
            )}" (lead district: ${row.lead_district ?? '—'})`
          );
        }
        continue;
      }

      const oldTrim = String(row.old_mandal ?? '').trim();
      if (oldTrim === String(resolved).trim()) {
        skipSameMandal++;
        continue;
      }

      if (tier && tierCounts[tier] != null) tierCounts[tier]++;
      toApply.push({ id: row.lead_id, mandal: resolved, row, tier });
    }

    for (const { id, mandal, row, tier } of toApply) {
      if (!QUIET) {
        console.log(
          `${label} [${tier}] lead ${id} | ENQ ${row.enquiry_number} | ${row.name} | mandal: "${oldShown(
            row.old_mandal
          )}" → master "${mandal}" (staging "${String(row.new_mandal)}")`
        );
      }
    }

    const accounted =
      notFound + skipWrongFlag + skipSameMandal + noMasterMandal + toApply.length;

    console.log('\n— Summary —');
    console.log(
      `All ${totalStagingRows.toLocaleString()} staging row(s): ${emptyMandalRows.toLocaleString()} had empty mandal (ignored); ` +
        `${stagedWithMandal.toLocaleString()} had mandal text and appear in the breakdown below.`
    );
    if (rows.length !== stagedWithMandal) {
      console.warn(
        `Note: match query returned ${rows.length} row(s), expected ${stagedWithMandal} — check for DB drift.`
      );
    }
    console.log(`\nWithin those ${rows.length.toLocaleString()} staging row(s) with mandal:`);
    console.log(`  No matching lead: ${notFound}`);
    console.log(`  Matched lead, needs_manual_update ≠ 2 (skipped): ${skipWrongFlag}`);
    console.log(`  Matched, master = current lead mandal already (skipped): ${skipSameMandal}`);
    console.log(`  Matched, could not map staging mandal to master: ${noMasterMandal}`);
    console.log(`  Will UPDATE (master mandal + clear flag): ${toApply.length}`);
    if (toApply.length > 0) {
      console.log(
        `     … by tier: strict=${tierCounts.strict}, loose-district=${tierCounts['loose-district']}` +
          `${STATE_WIDE_FUZZY ? `, state-fuzzy=${tierCounts['state-fuzzy']}` : ''}`
      );
    }
    console.log(
      `  → Subtotal: ${accounted.toLocaleString()} (should equal ${rows.length.toLocaleString()} staging rows with mandal)`
    );

    if (unmatched.length > 0) {
      console.log(`\n— Unmatched to master (${unmatched.length}) —`);
      console.log(
        'Tune SYNC_MANDAL_FUZZY_LOOSE / SYNC_MANDAL_STATE_FUZZY_MIN, or set SYNC_MANDAL_STATE_WIDE_FUZZY=1 (review results).'
      );
      if (UNMATCHED_MAX > 0) {
        const show = unmatched.slice(0, UNMATCHED_MAX);
        for (const u of show) {
          console.log(
            `  ENQ ${u.enquiry_number} | ${u.name} | staging "${u.staging_mandal}" | lead ${u.lead_id} | dist "${u.lead_district}" | current mandal "${u.lead_mandal_current}"`
          );
        }
        if (unmatched.length > UNMATCHED_MAX) {
          console.log(
            `  … and ${unmatched.length - UNMATCHED_MAX} more (set SYNC_MANDAL_UNMATCHED_MAX or SYNC_MANDAL_UNMATCHED_FILE).`
          );
        }
      }
      if (UNMATCHED_FILE) {
        const outPath = path.isAbsolute(UNMATCHED_FILE)
          ? UNMATCHED_FILE
          : path.join(process.cwd(), UNMATCHED_FILE);
        const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
        const header =
          'staging_id,enquiry_number,name,staging_mandal,lead_id,lead_district,lead_state,lead_mandal_current\n';
        const lines = unmatched.map(
          (u) =>
            [
              u.staging_id,
              esc(u.enquiry_number),
              esc(u.name),
              esc(u.staging_mandal),
              u.lead_id,
              esc(u.lead_district),
              esc(u.lead_state),
              esc(u.lead_mandal_current),
            ].join(',')
        );
        fs.writeFileSync(outPath, header + lines.join('\n') + '\n', 'utf8');
        console.log(`\nWrote ${unmatched.length} unmatched row(s) to ${outPath}`);
      }
    }

    if (DRY_RUN) {
      console.log('\nDry run — no UPDATE executed.');
      return;
    }

    if (toApply.length === 0) {
      console.log('\nNothing to update.');
      return;
    }

    let updated = 0;
    const MAX_RETRIES = 3;
    
    for (let i = 0; i < toApply.length; i += BATCH_SIZE) {
      let chunk = toApply.slice(i, i + BATCH_SIZE);
    
      // ✅ Sort IDs to avoid deadlocks
      chunk = chunk.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    
      let attempt = 0;
    
      while (attempt < MAX_RETRIES) {
        await conn.beginTransaction();
        try {
          const ids = [];
          const mandalCases = [];
    
          for (const { id, mandal } of chunk) {
            ids.push(id);
            mandalCases.push(
              `WHEN id = ${conn.escape(id)} THEN ${conn.escape(mandal)}`
            );
          }
    
          const updateSql = `
            UPDATE leads
            SET 
              mandal = CASE
                ${mandalCases.join('\n')}
              END,
              needs_manual_update = 0
            WHERE id IN (${ids.map((id) => conn.escape(id)).join(',')})
            AND needs_manual_update = 2
          `;
    
          const [res] = await conn.query(updateSql);
          updated += Number(res.affectedRows || 0);
    
          await conn.commit();
          break; // ✅ success → exit retry loop
        } catch (e) {
          await conn.rollback();
    
          if (e.code === 'ER_LOCK_WAIT_TIMEOUT' && attempt < MAX_RETRIES - 1) {
            attempt++;
    
            console.warn(
              `Lock timeout on batch ${Math.floor(i / BATCH_SIZE) + 1}, retry ${attempt}...`
            );
    
            // ✅ small delay before retry
            await new Promise((r) => setTimeout(r, 500 * attempt));
    
            continue;
          }
    
          throw e;
        }
      }
    
      if (!QUIET) {
        console.log(
          `Committed batch ${Math.floor(i / BATCH_SIZE) + 1}: ${chunk.length} row(s) (running total updated: ${updated})`
        );
      }
    }

    console.log(`\nUPDATE finished. Rows matched for write: ${toApply.length}, affectedRows: ${updated}`);
  } catch (e) {
    if (e?.code === 'ER_PARSE_ERROR' || String(e?.message || '').includes('ROW_NUMBER')) {
      console.error('\nThis script needs MySQL 8.0+ (ROW_NUMBER / CTE).\n');
    }
    console.error('[syncMandalFromStaging]', e);
    process.exitCode = 1;
  } finally {
    if (conn) conn.release();
    await closeDB();
  }
}

main();
