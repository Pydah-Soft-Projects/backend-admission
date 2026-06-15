import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();
const { ObjectId } = mongoose.Types;

const conn = await mongoose.createConnection(process.env.HOSTEL_MONGO_URI).asPromise();
const db = conn.db;

const TARGET = '2026-2027';
const CAL_2026 = '2026';

console.log(`=== HMS records for academic year ${TARGET} ===\n`);

// Users with 2026-2027
const users2026 = await db.collection('users').find({ academicYear: TARGET }).toArray();
console.log(`users with academicYear=${TARGET}: ${users2026.length}`);
for (const u of users2026) {
  console.log('\n--- user ---');
  console.log(JSON.stringify(u, null, 2));
}

// Users with 2026 in academicYear (any format)
const users2026Loose = await db.collection('users').find({
  academicYear: { $regex: '2026', $options: 'i' },
}).toArray();
console.log(`\nusers matching academicYear regex 2026: ${users2026Loose.length}`);

// Room occupancy histories
const hist = await db.collection('roomoccupancyhistories').find({ academicYear: TARGET }).toArray();
console.log(`\nroomoccupancyhistories for ${TARGET}: ${hist.length}`);
for (const h of hist) {
  console.log('\n--- history ---');
  console.log(JSON.stringify(h, null, 2));
}

// CRM synced users
const crm = await db.collection('users').find({ source: 'admissions_crm' }).toArray();
console.log(`\nadmissions_crm users: ${crm.length}`);
for (const u of crm) {
  const keys = Object.keys(u).sort();
  console.log('\n--- admissions_crm user keys ---');
  console.log(keys.join(', '));
  console.log(JSON.stringify(u, null, 2));
}

// Native CMS user sample for same year (non-CRM)
const native = users2026.find((u) => u.source !== 'admissions_crm');
if (native) {
  console.log('\n=== Native CMS user field keys (2026-2027) ===');
  console.log(Object.keys(native).sort().join(', '));
}

// Compare key sets
if (users2026.length >= 2) {
  const crmUser = users2026.find((u) => u.source === 'admissions_crm');
  const nativeUser = users2026.find((u) => u.source !== 'admissions_crm') || users2026[0];
  if (crmUser && nativeUser && crmUser._id.toString() !== nativeUser._id.toString()) {
    const nativeKeys = new Set(Object.keys(nativeUser));
    const crmKeys = new Set(Object.keys(crmUser));
    const missingInCrm = [...nativeKeys].filter((k) => !crmKeys.has(k));
    const extraInCrm = [...crmKeys].filter((k) => !nativeKeys.has(k));
    console.log('\n=== Field diff: CRM vs native CMS (2026-2027) ===');
    console.log('Missing in CRM sync:', missingInCrm.join(', ') || '(none)');
    console.log('Extra in CRM sync:', extraInCrm.join(', ') || '(none)');
    console.log('\nValue format compare (shared keys):');
    for (const key of [...nativeKeys].filter((k) => crmKeys.has(k)).sort()) {
      const n = nativeUser[key];
      const c = crmUser[key];
      const nType = n === null ? 'null' : Array.isArray(n) ? 'array' : typeof n;
      const cType = c === null ? 'null' : Array.isArray(c) ? 'array' : typeof c;
      if (nType !== cType || String(n) !== String(c)) {
        console.log(`  ${key}: native(${nType})=${JSON.stringify(n)?.slice(0, 80)} | crm(${cType})=${JSON.stringify(c)?.slice(0, 80)}`);
      }
    }
  }
}

// Fee structures 2026-2027
const fees = await db.collection('feestructures').find({ academicYear: TARGET }).limit(2).toArray();
console.log(`\nfeestructures ${TARGET} sample keys:`, fees[0] ? Object.keys(fees[0]) : 'none');

// Academic calendars
const cal = await db.collection('academiccalendars').find({ academicYear: { $regex: '2026' } }).toArray();
console.log(`\nacademiccalendars with 2026: ${cal.length}`);

await conn.close();
