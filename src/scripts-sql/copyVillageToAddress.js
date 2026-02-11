/**
 * Migration: Copy "village" column values to "address" column in leads table.
 * Purpose: Populate the newly created address column with existing data.
 * Run: node src/scripts-sql/copyVillageToAddress.js (from backend-admission directory)
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const run = async () => {
  let connection;

  try {
    const dbConfig = {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    };

    console.log('Connecting to database...');
    connection = await mysql.createConnection(dbConfig);
    console.log('Connected.');

    console.log('Copying village values to address column...');
    
    // Using IFNULL to handle cases where village might be null (though schema says NOT NULL)
    // and ensuring we don't overwrite if address is already set (optional, but safer to overwrite if requested "copy all")
    // The user said "copy all the lead village into the address", which implies overwriting or filling where empty.
    // Given address was just created, it is empty.
    // I will overwrite to be consistent with "copy all".
    
    const [result] = await connection.execute(
      `UPDATE leads SET address = village WHERE village IS NOT NULL AND village != ''`
    );

    console.log(`Successfully updated ${result.changedRows} leads.`);
    console.log('Migration completed.');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
    process.exit(0);
  }
};

run();
