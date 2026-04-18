import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const updateSchema = async () => {
    let pool;
    try {
        pool = getPool();
        console.log('Updating lead_location_staging table schema...');
        
        await pool.execute('ALTER TABLE lead_location_staging MODIFY enquiry_number VARCHAR(64) NULL');
        
        console.log('✅ Successfully made enquiry_number optional in lead_location_staging');
        await closeDB();
    } catch (error) {
        console.error('❌ Error updating schema:', error.message);
        if (pool) await closeDB();
    }
};

updateSchema();
