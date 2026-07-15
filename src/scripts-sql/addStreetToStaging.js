import dotenv from 'dotenv';
import { getPool, closeDB } from '../config-sql/database.js';

dotenv.config();

const addStreetColumn = async () => {
    let pool;
    try {
        pool = getPool();
        console.log('Adding street column to lead_location_staging table...');
        
        // Check if column already exists
        const [columns] = await pool.execute(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'lead_location_staging' 
              AND COLUMN_NAME = 'street'
              AND TABLE_SCHEMA = ?
        `, [process.env.DB_NAME]);

        if (columns.length > 0) {
            console.log('✅ Column "street" already exists in lead_location_staging.');
        } else {
            await pool.execute('ALTER TABLE lead_location_staging ADD COLUMN street VARCHAR(512) NULL AFTER mandal');
            console.log('✅ Successfully added "street" column to lead_location_staging');
        }
        
        await closeDB();
    } catch (error) {
        console.error('❌ Error updating schema:', error.message);
        if (pool) await closeDB();
    }
};

addStreetColumn();
