import { getPool } from '../config-sql/database.js';
import { resolveLeadStatus } from '../utils/leadChannelStatus.util.js';

/**
 * Generate a new visitor code for a lead.
 * POST /api/visitors/generate
 */
export const generateVisitorCode = async (req, res) => {
  const { leadId } = req.body;
  const createdBy = req.user.id;

  if (!leadId) {
    return res.status(400).json({ success: false, message: 'Lead ID is required' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours expiry

  try {
    const pool = getPool();
    
    // Invalidate existing active codes for this lead
    await pool.execute(
      'UPDATE visitor_codes SET status = "expired" WHERE lead_id = ? AND status = "active"',
      [leadId]
    );

    // Save new code
    await pool.execute(
      'INSERT INTO visitor_codes (lead_id, created_by, code, expires_at) VALUES (?, ?, ?, ?)',
      [leadId, createdBy, code, expiresAt]
    );

    console.log(`[VISITOR CODE] Generated code ${code} for lead ${leadId} by user ${createdBy}`);

    res.status(201).json({
      success: true,
      data: { code, expiresAt },
      message: 'Visitor code generated successfully',
    });
  } catch (error) {
    console.error('Error generating visitor code:', error);
    res.status(500).json({ success: false, message: 'Failed to generate visitor code' });
  }
};

/**
 * Verify a visitor code.
 * GET /api/visitors/verify/:code
 */
export const verifyVisitorCode = async (req, res) => {
  const { code } = req.params;

  if (!code) {
    return res.status(400).json({ success: false, message: 'Code is required' });
  }

  try {
    const pool = getPool();
    
    // Query to get code details, lead info, and sender info
    // Assuming 'leads' table and 'users' table exist for joins
    const [rows] = await pool.execute(`
      SELECT 
        vc.*,
        l.name as lead_name,
        l.phone as lead_phone,
        l.enquiry_number as lead_enquiry_number,
        l.lead_status as current_lead_status,
        l.village as lead_village,
        l.district as lead_district,
        l.mandal as lead_mandal,
        l.father_name as lead_father_name,
        u.name as sender_name
      FROM visitor_codes vc
      JOIN leads l ON vc.lead_id = l.id
      JOIN users u ON vc.created_by = u.id
      WHERE vc.code = ? AND vc.status = 'active' AND vc.expires_at > NOW()
    `, [code]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invalid or expired visitor code' });
    }

    res.status(200).json({
      success: true,
      data: rows[0],
      message: 'Visitor code verified',
    });
  } catch (error) {
    console.error('Error verifying visitor code:', error);
    res.status(500).json({ success: false, message: 'Failed to verify visitor code' });
  }
};

/**
 * Mark a code as used and update lead status to Visited.
 * POST /api/visitors/consume
 */
export const consumeVisitorCode = async (req, res) => {
  const { code, leadId } = req.body;

  if (!code || !leadId) {
    return res.status(400).json({ success: false, message: 'Code and Lead ID are required' });
  }

  try {
    const pool = getPool();
    const connection = await pool.getConnection();
    
    try {
      // Start transaction
      await connection.beginTransaction();

      // 1. Mark code as used
      const [result] = await connection.execute(
        'UPDATE visitor_codes SET status = "used" WHERE code = ? AND lead_id = ? AND status = "active"',
        [code, leadId]
      );

      if (result.affectedRows === 0) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: 'Could not consume code. It may be already used or expired.' });
      }

      const [lr] = await connection.execute(
        'SELECT lead_status, call_status, visit_status FROM leads WHERE id = ? FOR UPDATE',
        [leadId]
      );
      const row = lr[0] || {};
      const nextLead = resolveLeadStatus('Visited', row.call_status ?? null, 'Visited');
      await connection.execute(
        'UPDATE leads SET visit_status = ?, lead_status = ? WHERE id = ?',
        ['Visited', nextLead, leadId]
      );

      await connection.commit();

      res.status(200).json({
        success: true,
        message: 'Visitor confirmed and lead status updated to Visited',
      });
    } catch (innerError) {
      await connection.rollback();
      throw innerError;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error consuming visitor code:', error);
    res.status(500).json({ success: false, message: 'Failed to consume visitor code' });
  }
};

/**
 * Get recent visitor log.
 * GET /api/visitors/recent
 */
export const getRecentVisitors = async (req, res) => {
  try {
    const pool = getPool();
    
    const [rows] = await pool.execute(`
      SELECT 
        vc.id,
        vc.code,
        vc.status,
        vc.expires_at,
        vc.created_at,
        l.name as lead_name,
        l.enquiry_number as lead_enquiry_number,
        u.name as sender_name
      FROM visitor_codes vc
      JOIN leads l ON vc.lead_id = l.id
      JOIN users u ON vc.created_by = u.id
      ORDER BY vc.created_at DESC
      LIMIT 10
    `);

    res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error('Error fetching recent visitors:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch recent visitors' });
  }
};
