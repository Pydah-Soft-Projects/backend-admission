import { getPool } from './src/config-sql/database.js';
getPool().query("SELECT * FROM leads WHERE name LIKE '%KALYAN DANUSH%' LIMIT 1")
.then(res => {
  console.log('Lead data:', res[0]);
  process.exit(0);
}).catch(console.error);
