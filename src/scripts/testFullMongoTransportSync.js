import dotenv from 'dotenv';
import path from 'path';
import { syncJoiningBusToTransportRequestMysql } from '../services/joiningTransportRequestSync.service.js';
import { connectTransport } from '../config-mongo/transport.js';

dotenv.config({ path: path.join(process.cwd(), '.env') });

async function runTest() {
  console.log('Testing Transport Mongo Upsert with Full Transport Details...');
  
  const joiningContext = {
    admissionNumber: '20260003',
    studentName: 'BANNU ROYALS',
    batch: '2026',
    intakeBatch: '2026',
    course: 'B.Tech',
    collegeName: 'Pydah College of Engineering',
    transportDetails: {
      accommodationType: 'bus',
      routeId: 'R06',
      routeName: 'Kothapeta Via Mandapeta, Alamuru',
      stageId: '6a3127094f27a60cb3f7cd61',
      stageName: 'KALAVAPUVVU CNTR',
      stageFare: 26800,
      busId: 'AP-39-UW-4611',
      busNumber: 'AP-39-UW-4611',
      academicYear: '2026-2027',
    },
  };

  const result = await syncJoiningBusToTransportRequestMysql({
    joiningId: 'a3b7ae1a-8276-4f09-a9f7-b4a6f76f7e14',
    joiningContext,
    user: { name: 'Admin', empNo: 1 },
  });

  console.log('Sync Result:', JSON.stringify(result, null, 2));

  const conn = await connectTransport();
  const coll = conn.db.collection('transport_requests');
  const doc = await coll.findOne({ admission_number: '20260003' });
  console.log('Fetched Mongo Document:', JSON.stringify(doc, null, 2));

  if (doc && doc.application_number) {
    console.log(`✅ SUCCESS: Stored transport request in Transport MongoDB! App Number: ${doc.application_number}`);
  } else {
    console.error('❌ FAILED to store document in Transport MongoDB');
  }

  await conn.close();
  process.exit(0);
}

runTest();
