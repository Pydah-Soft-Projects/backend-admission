import { getPool as getSecondaryPool } from './src/config-sql/database-secondary.js';

async function fix() {
  const secondary = getSecondaryPool();

  try {
    const [res4] = await secondary.execute("UPDATE students SET branch_id = 51, branch = 'DAIM' WHERE branch_id = 214");
    console.log('Updated secondary students:', res4.affectedRows);
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

fix();
