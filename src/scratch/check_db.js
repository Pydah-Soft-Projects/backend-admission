import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const { Types: { ObjectId } } = mongoose;

const toObjectId = (value) => {
  if (value instanceof ObjectId) return value;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  if (!/^[a-fA-F0-9]{24}$/.test(raw)) return null;
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
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
  if (headIdStrings.length === 0) {
    return structures.map((doc) => ({ ...doc, feeHeadDetails: null }));
  }

  const objectIds = headIdStrings
    .map((id) => toObjectId(id))
    .filter((id) => id !== null);
  const heads = await db
    .collection('feeheads')
    .find({ _id: { $in: [...objectIds, ...headIdStrings] } })
    .toArray();
  const byId = new Map(heads.map((head) => [String(head._id), head]));

  return structures.map((doc) => {
    const head = doc.feeHead ? byId.get(String(doc.feeHead)) : null;
    return {
      ...doc,
      feeHeadDetails: head
        ? {
            _id: String(head._id),
            name: head.name || '',
            code: head.code || '',
            description: head.description || '',
          }
        : null,
    };
  });
};

const formatStructure = (doc) => ({
  _id: String(doc._id),
  id: String(doc._id),
  category: doc.category || '',
  course: doc.course || '',
  branch: doc.branch || '',
  college: doc.college || '',
  studentYear: doc.studentYear ?? null,
  semester: doc.semester ?? null,
  batch: doc.batch || '',
  amount: typeof doc.amount === 'number' ? doc.amount : Number(doc.amount) || 0,
  isScholarshipApplicable: Boolean(doc.isScholarshipApplicable),
  feeHead: doc.feeHead ? String(doc.feeHead) : null,
  feeHeadName: doc.feeHeadDetails?.name || '',
  feeHeadCode: doc.feeHeadDetails?.code || '',
  feeHeadDescription: doc.feeHeadDetails?.description || '',
});

async function check() {
  console.log("Connecting to Mongo...");
  const uri = process.env.FEE_MANAGEMENT_MONGO_URI;
  try {
    await mongoose.connect(uri);
    console.log("Connected!");
    
    const db = mongoose.connection.db;
    const docs = await db
      .collection('feestructures')
      .find({})
      .sort({ studentYear: 1, batch: 1, category: 1 })
      .toArray();
      
    const enriched = await enrichWithFeeHead(db, docs);
    const payload = enriched.map(formatStructure);
    console.log("Enriched fee structures length:", payload.length);
    if (payload.length > 0) {
      console.log("Sample enriched payload:", payload[0]);
    }
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}

check();
