/**
 * Seed states, districts, mandals from lib data.
 * Run: node src/scripts-sql/seedMasterDataLocations.js (from backend-admission directory)
 * Requires: tables states, districts, mandals (run createStatesDistrictsMandalsSchoolsColleges.js first).
 */
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { getPool, closeDB } from '../config-sql/database.js';
import { STATE_NAMES, STATE_DISTRICTS_MANDALS } from './seed-data/locationsSeedData.js';
import { andhraPradeshDistrictsMandals } from './seed-data/andhraPradeshSeedData.js';

dotenv.config();

const run = async () => {
  let pool;

  try {
    pool = getPool();
    console.log('Seeding states, districts, mandals...\n');

    const stateIdByName = new Map();

    for (let i = 0; i < STATE_NAMES.length; i++) {
      const name = STATE_NAMES[i];
      const [existing] = await pool.execute(
        'SELECT id FROM states WHERE name = ?',
        [name]
      );
      let stateId;
      if (existing.length > 0) {
        stateId = existing[0].id;
        console.log(`State already exists: ${name}`);
      } else {
        stateId = uuidv4();
        await pool.execute(
          'INSERT INTO states (id, name, is_active, display_order) VALUES (?, ?, 1, ?)',
          [stateId, name, i]
        );
        console.log(`Inserted state: ${name}`);
      }
      stateIdByName.set(name, stateId);
    }

    for (const [stateName, districtsData] of Object.entries(
      STATE_DISTRICTS_MANDALS
    )) {
      const stateId = stateIdByName.get(stateName);
      if (!stateId) continue;

      for (let dOrder = 0; dOrder < districtsData.length; dOrder++) {
        const { district: districtName, mandals: mandalList } =
          districtsData[dOrder];
        const [exDist] = await pool.execute(
          'SELECT id FROM districts WHERE state_id = ? AND name = ?',
          [stateId, districtName]
        );
        let districtId;
        if (exDist.length > 0) {
          districtId = exDist[0].id;
        } else {
          districtId = uuidv4();
          await pool.execute(
            'INSERT INTO districts (id, state_id, name, is_active, display_order) VALUES (?, ?, ?, 1, ?)',
            [districtId, stateId, districtName, dOrder]
          );
          console.log(`  District: ${districtName} (${stateName})`);
        }

        for (let mOrder = 0; mOrder < mandalList.length; mOrder++) {
          const mandalName = mandalList[mOrder];
          const [exMan] = await pool.execute(
            'SELECT id FROM mandals WHERE district_id = ? AND name = ?',
            [districtId, mandalName]
          );
          if (exMan.length === 0) {
            const mandalId = uuidv4();
            await pool.execute(
              'INSERT INTO mandals (id, district_id, name, is_active, display_order) VALUES (?, ?, ?, 1, ?)',
              [mandalId, districtId, mandalName, mOrder]
            );
          }
        }
      }
    }

    // Andhra Pradesh: full districts and mandals
    const apStateId = stateIdByName.get('Andhra Pradesh');
    if (apStateId) {
      console.log('\nSeeding Andhra Pradesh districts and mandals...');
      for (let dOrder = 0; dOrder < andhraPradeshDistrictsMandals.length; dOrder++) {
        const { district: districtName, mandals: mandalList } =
          andhraPradeshDistrictsMandals[dOrder];
        const [exDist] = await pool.execute(
          'SELECT id FROM districts WHERE state_id = ? AND name = ?',
          [apStateId, districtName]
        );
        let districtId;
        if (exDist.length > 0) {
          districtId = exDist[0].id;
        } else {
          districtId = uuidv4();
          await pool.execute(
            'INSERT INTO districts (id, state_id, name, is_active, display_order) VALUES (?, ?, ?, 1, ?)',
            [districtId, apStateId, districtName, dOrder]
          );
          console.log(`  District: ${districtName} (Andhra Pradesh)`);
        }

        for (let mOrder = 0; mOrder < mandalList.length; mOrder++) {
          const mandalName = mandalList[mOrder];
          const [exMan] = await pool.execute(
            'SELECT id FROM mandals WHERE district_id = ? AND name = ?',
            [districtId, mandalName]
          );
          if (exMan.length === 0) {
            const mandalId = uuidv4();
            await pool.execute(
              'INSERT INTO mandals (id, district_id, name, is_active, display_order) VALUES (?, ?, ?, 1, ?)',
              [mandalId, districtId, mandalName, mOrder]
            );
          }
        }
      }
      console.log('Andhra Pradesh: done.');
    }

    console.log('\nDone. Schools and colleges tables are empty; add via Master Data page.');
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    await closeDB();
    process.exit(0);
  }
};

run();
