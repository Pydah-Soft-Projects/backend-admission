/**
 * Count leads affected by the same "missed scheduled call → +1 day" logic as GET /api/leads?scheduledOn=YYYY-MM-DD
 *
 * Source of truth in code: backend-admission/src/controllers/lead.controller.js — getLeads(),
 * block that runs when `scheduledOn` is set (autoRescheduledFromYesterday + UPDATE ... DATE_ADD).
 *
 * Important:
 * - The API does NOT write an audit row when it bumps next_scheduled_call. There is no historical table
 *   of "how many rolled yesterday" unless you add logging later.
 * - `eligible`: rows that still match the pre-bump rule (same SELECT as the API). Use this BEFORE
 *   anyone loads today's scheduled list, or to see "how many are still waiting to roll" right now.
 * - `likely`: heuristic for leads that probably were bumped today (next_scheduled_call is on @day,
 *   updated_at is on that calendar day, no call on the calendar day before next_scheduled_call).
 *   Can include false positives if the lead was edited for other reasons the same day.
 *
 * Usage (from backend-admission, after dotenv / DB env is configured):
 *   node src/scripts-sql/count-missed-call-auto-reschedule.js
 *   node src/scripts-sql/count-missed-call-auto-reschedule.js --scheduled-on=2026-04-17
 *   node src/scripts-sql/count-missed-call-auto-reschedule.js --scheduled-on=2026-04-17 --mode=likely
 *
 * Do not run in production without understanding read load; all queries are SELECT-only.
 */

import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs() {
  const args = process.argv.slice(2);
  let scheduledOn = process.env.SCHEDULED_ON || '';
  let mode = process.env.MODE || 'eligible';

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--scheduled-on=')) {
      scheduledOn = a.split('=').slice(1).join('=').trim();
    } else if (a === '--scheduled-on' && args[i + 1]) {
      scheduledOn = args[i + 1].trim();
      i += 1;
    } else if (a.startsWith('--mode=')) {
      mode = a.split('=')[1].trim();
    } else if (a === '--mode' && args[i + 1]) {
      mode = args[i + 1].trim();
      i += 1;
    }
  }

  if (!scheduledOn) {
    scheduledOn = new Date().toISOString().slice(0, 10);
  }

  return { scheduledOn, mode };
}

/** Exact mirror of getLeads missedRows SELECT (read-only). */
const SQL_ELIGIBLE = `
SELECT
  l.id,
  l.enquiry_number AS enquiryNumber,
  l.name,
  l.next_scheduled_call AS nextScheduledCallBeforeBump,
  DATE(l.next_scheduled_call) AS scheduledCallDate
FROM leads l
WHERE l.next_scheduled_call IS NOT NULL
  AND DATE(l.next_scheduled_call) = DATE_SUB(?, INTERVAL 1 DAY)
  AND NOT EXISTS (
    SELECT 1
    FROM communications c
    WHERE c.lead_id = l.id
      AND c.type = 'call'
      AND DATE(c.sent_at) = DATE(l.next_scheduled_call)
  )
ORDER BY l.id
`;

/** Heuristic: next call sits on @day and row was touched that calendar day; no call on prior calendar day. */
const SQL_LIKELY = `
SELECT
  l.id,
  l.enquiry_number AS enquiryNumber,
  l.name,
  l.next_scheduled_call AS nextScheduledCall,
  l.updated_at AS updatedAt
FROM leads l
WHERE l.next_scheduled_call IS NOT NULL
  AND DATE(l.next_scheduled_call) = ?
  AND DATE(l.updated_at) = ?
  AND NOT EXISTS (
    SELECT 1
    FROM communications c
    WHERE c.lead_id = l.id
      AND c.type = 'call'
      AND DATE(c.sent_at) = DATE_SUB(DATE(l.next_scheduled_call), INTERVAL 1 DAY)
  )
ORDER BY l.id
`;

async function main() {
  const { scheduledOn, mode } = parseArgs();

  if (!YMD.test(scheduledOn)) {
    throw new Error(
      `Invalid --scheduled-on="${scheduledOn}". Use YYYY-MM-DD (same format the app sends for scheduledOn).`
    );
  }

  const pool = getPool();

  console.log('\n=== Missed-call auto-reschedule report ===\n');
  console.log(`scheduledOn (viewer "today" in app): ${scheduledOn}`);
  console.log(`mode: ${mode} (eligible | likely)\n`);

  if (mode === 'eligible') {
    const [rows] = await pool.execute(SQL_ELIGIBLE, [scheduledOn]);
    const yesterdayRel = 'DATE(next_scheduled_call) = DATE_SUB(scheduledOn, INTERVAL 1 DAY)';
    console.log(
      'Meaning: leads whose next_scheduled_call calendar day is the day BEFORE scheduledOn, with no outgoing call on that scheduled calendar day.'
    );
    console.log(`These are the rows the API would bump (+1 day) on the next GET /leads?scheduledOn=${scheduledOn}.\n`);
    console.log(`Count (eligible / pending bump): ${rows.length}`);
    if (rows.length > 0 && rows.length <= 50) {
      console.table(rows);
    } else if (rows.length > 50) {
      console.table(rows.slice(0, 25));
      console.log(`... and ${rows.length - 25} more (showing first 25). Re-query with LIMIT in SQL if needed.`);
    }
  } else if (mode === 'likely') {
    const [rows] = await pool.execute(SQL_LIKELY, [scheduledOn, scheduledOn]);
    console.log(
      'Heuristic only: next_scheduled_call is ON scheduledOn, updated_at same calendar day, no call on previous calendar day.'
    );
    console.log('May include leads updated for other reasons the same day.\n');
    console.log(`Count (likely rolled on ${scheduledOn}): ${rows.length}`);
    if (rows.length > 0 && rows.length <= 50) {
      console.table(rows);
    } else if (rows.length > 50) {
      console.table(rows.slice(0, 25));
      console.log(`... and ${rows.length - 25} more.`);
    }
  } else {
    throw new Error(`Unknown --mode="${mode}". Use eligible or likely.`);
  }

  await closeDB();
}

main().catch(async (err) => {
  console.error(err);
  await closeDB();
  process.exit(1);
});
