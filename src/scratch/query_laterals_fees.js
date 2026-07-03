import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const uri = process.env.FEE_MANAGEMENT_MONGO_URI;
  console.log("Connecting to Fee-Management Mongo...");
  await mongoose.connect(uri);
  console.log("Connected!");

  const db = mongoose.connection.db;

  // Query feestructures for B.Tech for batch 2025
  const btech2025 = await db.collection('feestructures')
    .find({ course: /b\.?tech/i, batch: "2025" })
    .toArray();

  console.log(`\n=== Batch 2025 B.Tech Fee Structures (Count: ${btech2025.length}) ===`);
  if (btech2025.length > 0) {
    btech2025.forEach(d => {
      console.log(`Branch: ${d.branch}, Category: ${d.category}, Year: ${d.studentYear}, Amount: ${d.amount}`);
    });
  } else {
    console.log("No fee structures found for B.Tech in batch 2025.");
  }

  // Query feestructures for B.Tech for batch 2026
  const btech2026 = await db.collection('feestructures')
    .find({ course: /b\.?tech/i, batch: "2026" })
    .toArray();

  console.log(`\n=== Batch 2026 B.Tech Fee Structures (Count: ${btech2026.length}) ===`);
  if (btech2026.length > 0) {
    btech2026.forEach(d => {
      console.log(`Branch: ${d.branch}, Category: ${d.category}, Year: ${d.studentYear}, Amount: ${d.amount}`);
    });
  } else {
    console.log("No fee structures found for B.Tech in batch 2026.");
  }

  process.exit(0);
}

main().catch(console.error);
