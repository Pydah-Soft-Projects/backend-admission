import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const { ObjectId } = mongoose.Types;
const TARGET_YEAR = process.argv[2]?.trim() || '2026-2027';

const uri = process.env.HOSTEL_MONGO_URI?.trim();
if (!uri) {
  console.error('HOSTEL_MONGO_URI is not set');
  process.exit(1);
}

const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 20000 }).asPromise();
const db = conn.db;

console.log(`Database: ${db.databaseName}`);
console.log(`Target academic year: ${TARGET_YEAR}\n`);

const collections = await db.listCollections().toArray();
const names = collections.map((c) => c.name).sort();
console.log('=== Collections ===');
console.log(names.join(', '));

async function distinctYears(collectionName, field = 'academicYear') {
  try {
    const years = await db.collection(collectionName).distinct(field);
    return years.filter(Boolean).map(String).sort();
  } catch {
    return [];
  }
}

const feeYears = await distinctYears('hostelfeestructures');
const calendarYears = await distinctYears('academiccalendars');

console.log('\n=== Academic years in hostelfeestructures ===');
console.log(feeYears.length ? feeYears.join(', ') : '(none)');

console.log('\n=== Academic years in academiccalendars ===');
console.log(calendarYears.length ? calendarYears.join(', ') : '(none)');

const exactCount = await db.collection('hostelfeestructures').countDocuments({ academicYear: TARGET_YEAR });
console.log(`\n=== hostelfeestructures for ${TARGET_YEAR} ===`);
console.log(`Count: ${exactCount}`);

if (exactCount > 0) {
  const docs = await db.collection('hostelfeestructures').find({ academicYear: TARGET_YEAR }).limit(50).toArray();
  for (const doc of docs) {
    console.log(
      JSON.stringify({
        amount: doc.amount,
        course: doc.course,
        studentYear: doc.studentYear ?? null,
        hostel: String(doc.hostel),
        category: String(doc.category),
        description: doc.description || '',
      })
    );
  }
}

// Resolve hostel/category names for context
const hostelIds = new Set();
const categoryIds = new Set();
const allFeeDocs = await db.collection('hostelfeestructures').find({}).toArray();
for (const doc of allFeeDocs) {
  if (doc.hostel) hostelIds.add(String(doc.hostel));
  if (doc.category) categoryIds.add(String(doc.category));
}

const hostelNameById = new Map();
const categoryNameById = new Map();

for (const id of hostelIds) {
  const oid = /^[a-fA-F0-9]{24}$/.test(id) ? new ObjectId(id) : id;
  const hostel = await db.collection('hostels').findOne({ _id: { $in: [oid, id] } });
  if (hostel) hostelNameById.set(id, hostel.name || id);
}
for (const id of categoryIds) {
  const oid = /^[a-fA-F0-9]{24}$/.test(id) ? new ObjectId(id) : id;
  const category = await db.collection('hostelcategories').findOne({ _id: { $in: [oid, id] } });
  if (category) categoryNameById.set(id, category.name || id);
}

console.log('\n=== All hostelfeestructures grouped by academic year ===');
const grouped = new Map();
for (const doc of allFeeDocs) {
  const year = String(doc.academicYear || '(missing)');
  if (!grouped.has(year)) grouped.set(year, []);
  grouped.get(year).push(doc);
}

for (const [year, docs] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`\n--- ${year} (${docs.length} rows) ---`);
  for (const doc of docs.slice(0, 20)) {
    const hostelId = String(doc.hostel);
    const categoryId = String(doc.category);
    console.log(
      JSON.stringify({
        amount: doc.amount,
        course: doc.course || '',
        studentYear: doc.studentYear ?? null,
        hostel: hostelNameById.get(hostelId) || hostelId,
        category: categoryNameById.get(categoryId) || categoryId,
      })
    );
  }
  if (docs.length > 20) console.log(`... and ${docs.length - 20} more`);
}

// Check if 2026-2027 exists in calendars
const calendarForTarget = await db.collection('academiccalendars').find({ academicYear: TARGET_YEAR }).toArray();
console.log(`\n=== academiccalendars for ${TARGET_YEAR} ===`);
console.log(`Count: ${calendarForTarget.length}`);
if (calendarForTarget.length > 0) {
  console.log(JSON.stringify(calendarForTarget[0], null, 2).slice(0, 800));
}

// Regex variants (2026 only)
const regex2026 = await db.collection('hostelfeestructures')
  .find({ academicYear: { $regex: '2026', $options: 'i' } })
  .toArray();
console.log(`\n=== hostelfeestructures matching regex "2026" ===`);
console.log(`Count: ${regex2026.length}`);

console.log('\n=== Summary ===');
if (exactCount === 0) {
  console.log(`NO fee structures registered for ${TARGET_YEAR} in hostelfeestructures.`);
} else {
  console.log(`Found ${exactCount} hostelfeestructures row(s) for ${TARGET_YEAR}.`);
}

const feePortalYears = await distinctYears('feestructures');
const feePortalCount = await db.collection('feestructures').countDocuments({ academicYear: TARGET_YEAR });
console.log(`\n=== feestructures (HMS fee config section) ===`);
console.log(`Academic years: ${feePortalYears.join(', ') || 'none'}`);
console.log(`Count for ${TARGET_YEAR}: ${feePortalCount}`);

if (feePortalCount > 0) {
  const portalDocs = await db.collection('feestructures').find({ academicYear: TARGET_YEAR }).toArray();
  for (const doc of portalDocs) {
    const total =
      (Number(doc.term1Fee) || 0) + (Number(doc.term2Fee) || 0) + (Number(doc.term3Fee) || 0);
    console.log(
      JSON.stringify({
        course: typeof doc.course === 'object' ? String(doc.course) : doc.course,
        studentYear: doc.year,
        category: doc.category,
        term1Fee: doc.term1Fee,
        term2Fee: doc.term2Fee,
        term3Fee: doc.term3Fee,
        totalAnnual: total,
        isActive: doc.isActive,
      })
    );
  }
}

if (exactCount === 0 && feePortalCount > 0) {
  console.log(
    '\nNOTE: Admissions CRM reads hostelfeestructures only. Fee config exists in feestructures but is not wired yet.'
  );
}

await conn.close();
