import { getPool } from '../config-sql/database.js';

/**
 * Generate enquiry number in format: ENQ{YY}{6-digit}
 * Example: ENQ24000001, ENQ24000002
 * Resets to 000001 each year
 * 
 * This function uses the same logic as bulk upload to ensure sequential numbering
 * across both individual lead creation and bulk uploads.
 */
export const generateEnquiryNumber = async () => {
  try {
    // Get current year's last 2 digits (same as bulk upload)
    const currentYear = new Date().getFullYear();
    const yearSuffix = String(currentYear).slice(-2); // e.g., "24" for 2024

    // Create prefix (same as bulk upload)
    const prefix = `ENQ${yearSuffix}`;
    
    const pool = getPool();
    
    // Find the highest enquiry number for this year (same query as bulk upload)
    const [leads] = await pool.execute(
      `SELECT enquiry_number FROM leads 
       WHERE enquiry_number LIKE ? 
       ORDER BY enquiry_number DESC 
       LIMIT 1`,
      [`${prefix}%`]
    );

    let sequenceNumber = 1;

    if (leads.length > 0 && leads[0].enquiry_number) {
      // Extract the sequence number from the last enquiry number (same logic as bulk upload)
      // Format: ENQ24000001 -> extract 000001 -> convert to 1
      const lastSequence = leads[0].enquiry_number.replace(prefix, '');
      const lastNumber = parseInt(lastSequence, 10);
      
      if (!isNaN(lastNumber)) {
        sequenceNumber = lastNumber + 1;
      }
    }

    // Format sequence number as 6-digit string (000001 to 999999) - same as bulk upload
    const formattedSequence = String(sequenceNumber).padStart(6, '0');

    // Generate enquiry number (same format as bulk upload)
    const enquiryNumber = `${prefix}${formattedSequence}`;

    // Double-check uniqueness (in case of race condition)
    const [existing] = await pool.execute(
      'SELECT id FROM leads WHERE enquiry_number = ?',
      [enquiryNumber]
    );
    
    if (existing.length > 0) {
      // If exists, try next number (recursive call to get next available number)
      return generateEnquiryNumber();
    }

    return enquiryNumber;
  } catch (error) {
    console.error('Error generating enquiry number:', error);
    throw error;
  }
};

