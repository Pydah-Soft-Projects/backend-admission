import dotenv from 'dotenv';
import { getPool, closeDB } from '../src/config-sql/database.js';

dotenv.config();

const main = async () => {
    let pool;
    try {
        pool = getPool();
        const [rows] = await pool.execute(`
            SELECT m.name AS mandal_name, d.name AS district_name 
            FROM mandals m 
            JOIN districts d ON m.district_id = d.id 
            WHERE m.name LIKE '%rajah%' OR m.name LIKE '%rajama%' OR m.name LIKE '%urban%'
        `);
        console.log('Query results:');
        console.log(rows);
        await closeDB();
    } catch (e) {
        console.error(e);
        if (pool) await closeDB();
    }
};

main();
