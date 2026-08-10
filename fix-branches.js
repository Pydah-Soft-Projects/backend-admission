import { getPool } from './src/config-sql/database.js';
import { getPool as getSecondaryPool } from './src/config-sql/database-secondary.js';

async function fix() {
  const primary = getPool();
  const secondary = getSecondaryPool();

  try {
    const [res1] = await primary.execute("UPDATE admissions SET managed_branch_id = '51', branch = 'DAIM' WHERE managed_branch_id = '214'");
    console.log('Updated admissions:', res1.affectedRows);

    const [res2] = await primary.execute("UPDATE joinings SET managed_branch_id = '51', branch = 'DAIM' WHERE managed_branch_id = '214'");
    console.log('Updated joinings:', res2.affectedRows);
    
    // Also update any leads where the branch is DCSE(AIML)
    const [res3] = await primary.execute("UPDATE leads SET branch = 'DAIM' WHERE branch LIKE '%AIML%' OR branch LIKE '%DAIML%' OR branch = 'DCSE(AIML)'");
    console.log('Updated leads:', res3.affectedRows);

    const [res4] = await secondary.execute("UPDATE students SET branch_id = 51, branch = 'DAIM' WHERE branch_id = 214");
    console.log('Updated secondary students:', res4.affectedRows);

  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

fix();
