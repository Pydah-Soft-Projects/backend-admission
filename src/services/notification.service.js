import { sendSmsThroughBulkSmsApps } from './bulkSms.service.js';
import { sendEmail } from './unifiedEmail.service.js';
import {
  sendPushNotificationToUser,
  sendPushNotificationToUsers,
} from './pushNotification.service.js';
import { getPool } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Send notification to lead when a new lead is created
 * Also notifies all Super Admins
 * @param {Object} lead - Lead object
 * @returns {Promise<Object>} Notification results
 */
export const notifyLeadCreated = async (lead) => {
  const results = {
    sms: { sent: false, error: null },
    superAdmin: { notified: false, error: null },
  };

  try {
    // Send SMS to lead
    if (lead.phone) {
      try {
        const smsMessage = `Dear ${lead.name}, Thank you for your interest! Your enquiry number is ${lead.enquiryNumber || 'pending'}. Our team will contact you soon. - CRM Admissions`;
        
        await sendSmsThroughBulkSmsApps({
          numbers: [lead.phone],
          message: smsMessage,
          isUnicode: false,
        });
        
        results.sms.sent = true;
      } catch (error) {
        console.error('[Notification] Error sending SMS to lead:', error);
        results.sms.error = error.message;
      }
    }

    // Notify all Super Admins about new lead creation
    try {
      const pool = getPool();
      const [superAdmins] = await pool.execute(
        'SELECT id, name, email FROM users WHERE role_name = ? AND is_active = ?',
        ['Super Admin', true]
      );

      if (superAdmins.length > 0) {
        const notificationTitle = 'New Lead Created';
        const notificationBody = `A new lead has been created: ${lead.name} (${lead.enquiryNumber || 'Pending'}) - ${lead.phone || 'No phone'}`;

        // Send push notifications to all Super Admins
        const superAdminIds = superAdmins.map((admin) => admin.id);
        const pushResult = await sendPushNotificationToUsers(superAdminIds, {
          title: notificationTitle,
          body: notificationBody,
          url: '/superadmin/leads',
          data: {
            type: 'lead_created',
            leadId: lead.id || lead._id?.toString(),
            timestamp: Date.now(),
          },
        });

        // Save in-app notifications for all Super Admins
        const notificationPromises = superAdmins.map(async (admin) => {
          try {
            const notificationId = uuidv4();
            const leadId = lead.id || lead._id?.toString() || null;
            const notificationData = {
              leadId: lead.id || lead._id?.toString() || null,
              leadName: lead.name,
              enquiryNumber: lead.enquiryNumber,
              phone: lead.phone,
            };

            await pool.execute(
              `INSERT INTO notifications (
                id, user_id, type, title, message, data,
                channel_push, channel_email, channel_sms,
                lead_id, action_url, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
              [
                notificationId,
                admin.id,
                'lead_created',
                notificationTitle,
                notificationBody,
                JSON.stringify(notificationData),
                pushResult.sent > 0 ? 1 : 0,
                0,
                0,
                leadId,
                '/superadmin/leads',
              ]
            );
            return { success: true };
          } catch (error) {
            console.error(`[Notification] Error saving notification for Super Admin ${admin.id}:`, error);
            return null;
          }
        });

        await Promise.all(notificationPromises);
        results.superAdmin.notified = true;
      }
    } catch (error) {
      console.error('[Notification] Error notifying Super Admins:', error);
      results.superAdmin.error = error.message;
    }
  } catch (error) {
    console.error('[Notification] Error in notifyLeadCreated:', error);
  }

  return results;
};

/**
 * Send notifications when leads are assigned to a user
 * @param {Object} options - Assignment options
 * @param {string} options.userId - User ID who received the assignment
 * @param {number} options.leadCount - Number of leads assigned
 * @param {Object[]} [options.leads] - Array of lead objects (optional, for single assignment details)
 * @param {boolean} [options.isBulk] - Whether this is a bulk assignment
 * @param {string[]} [options.allLeadIds] - All lead IDs for SMS sending (for bulk assignments)
 * @returns {Promise<Object>} Notification results
 */
export const notifyLeadAssignment = async ({ userId, leadCount, leads = [], isBulk = false, allLeadIds = [] }) => {
  const results = {
    push: { sent: false, error: null },
    email: { sent: false, error: null },
  };

  try {
    // Validate inputs
    if (!userId) {
      throw new Error('User ID is required');
    }

    // Get user details
    const pool = getPool();
    const [users] = await pool.execute(
      'SELECT id, name, email, role_name FROM users WHERE id = ?',
      [userId]
    );
    
    if (!users || users.length === 0) {
      throw new Error('User not found');
    }
    
    const user = {
      id: users[0].id,
      name: users[0].name,
      email: users[0].email,
      roleName: users[0].role_name,
    };

    // Prepare notification content
    const notificationTitle = isBulk
      ? `${leadCount} New Leads Assigned`
      : leadCount === 1
      ? 'New Lead Assigned'
      : `${leadCount} New Leads Assigned`;

    const notificationBody = isBulk
      ? `You have been assigned ${leadCount} new leads. Please check your dashboard.`
      : leadCount === 1 && leads.length > 0
      ? `New lead assigned: ${leads[0].name} (${leads[0].enquiryNumber || 'Pending'})`
      : `You have been assigned ${leadCount} new lead${leadCount !== 1 ? 's' : ''}. Please check your dashboard.`;

    // Send push notification
    try {
      const pushResult = await sendPushNotificationToUser(userId, {
        title: notificationTitle,
        body: notificationBody,
        url: '/superadmin/leads',
        data: {
          type: 'lead_assignment',
          leadCount,
          isBulk,
          timestamp: Date.now(),
        },
      });
      results.push.sent = pushResult.sent > 0;
      if (pushResult.failed > 0) {
        results.push.error = `${pushResult.failed} subscription(s) failed`;
      }
    } catch (error) {
      console.error('[Notification] Error sending push notification:', error);
      results.push.error = error.message;
    }

    // Send email notification
    if (user.email) {
      try {
        const emailSubject = isBulk
          ? `${leadCount} New Leads Assigned to You - CRM Admissions`
          : leadCount === 1
          ? 'New Lead Assigned to You - CRM Admissions'
          : `${leadCount} New Leads Assigned to You - CRM Admissions`;

        const emailHtml = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
              .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
              .button { display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 6px; margin-top: 20px; }
              .footer { text-align: center; margin-top: 30px; color: #6b7280; font-size: 12px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>New Lead${leadCount !== 1 ? 's' : ''} Assigned</h1>
              </div>
              <div class="content">
                <p>Hello ${user.name},</p>
                <p>You have been assigned <strong>${leadCount} new lead${leadCount !== 1 ? 's' : ''}</strong>.</p>
                ${!isBulk && leads.length > 0 && leads.length <= 5
                  ? `<ul>${leads
                      .map(
                        (lead) =>
                          `<li><strong>${lead.name}</strong> - ${lead.enquiryNumber || 'Pending'} (${lead.phone})</li>`
                      )
                      .join('')}</ul>`
                  : ''}
                <p>Please log in to your dashboard to view and manage the assigned leads.</p>
                <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/superadmin/leads" class="button">View Leads</a>
                <p style="margin-top: 30px;">Best regards,<br>CRM Admissions Team</p>
              </div>
              <div class="footer">
                <p>This is an automated notification. Please do not reply to this email.</p>
              </div>
            </div>
          </body>
          </html>
        `;

        const emailResult = await sendEmail({
          to: user.email,
          subject: emailSubject,
          htmlContent: emailHtml,
        });

        results.email.sent = emailResult.success;
        results.email.channels = emailResult.channels;
      } catch (error) {
        console.error('[Notification] Error sending email:', error);
        results.email.error = error.message;
      }
    }

    // Send SMS to assigned leads (send to all leads, both bulk and single)
    let leadsToNotify = leads;
    if (isBulk && allLeadIds.length > 0 && leads.length < leadCount) {
      // Fetch lead details for bulk assignment if we don't have all leads
      const placeholders = allLeadIds.map(() => '?').join(',');
      const [fetchedLeads] = await pool.execute(
        `SELECT id, name, phone, enquiry_number FROM leads WHERE id IN (${placeholders})`,
        allLeadIds
      );
      leadsToNotify = fetchedLeads.map((lead) => ({
        id: lead.id,
        _id: lead.id,
        name: lead.name,
        phone: lead.phone,
        enquiryNumber: lead.enquiry_number,
      }));
    }

    // Send SMS to each assigned lead
    if (leadsToNotify.length > 0) {
      for (const lead of leadsToNotify) {
        if (lead.phone) {
          try {
            const smsMessage = `Dear ${lead.name}, Your enquiry ${lead.enquiryNumber || 'is pending'} has been assigned to ${user.roleName === 'Sub Super Admin' ? 'sub-admin' : 'counsellor'} ${user.name}. You will be contacted soon. - CRM Admissions`;
            
            await sendSmsThroughBulkSmsApps({
              numbers: [lead.phone],
              message: smsMessage,
              isUnicode: false,
            });
          } catch (error) {
            console.error(`[Notification] Error sending SMS to lead ${lead.id || lead._id}:`, error);
            // Don't fail the whole operation if SMS fails
          }
        }
      }
    }

    // Save in-app notification for assigned user (save after all channels are processed)
    // Always save notification even if push/email failed, so user can see it in-app
    try {
      const notificationId = uuidv4();
      const notificationData = {
        leadCount: leadCount || 0,
        isBulk: isBulk || false,
        leads: (leads || []).slice(0, 10).map((l) => ({
          id: l?.id || l?._id?.toString() || 'unknown',
          name: l?.name || 'Unknown',
          enquiryNumber: l?.enquiryNumber || l?.enquiry_number || 'N/A',
        })),
      };

      await pool.execute(
        `INSERT INTO notifications (
          id, user_id, type, title, message, data,
          channel_push, channel_email, channel_sms,
          action_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          notificationId,
          userId,
          'lead_assignment',
          notificationTitle,
          notificationBody,
          JSON.stringify(notificationData),
          results.push.sent ? 1 : 0,
          results.email.sent ? 1 : 0,
          0,
          '/superadmin/leads',
        ]
      );
    } catch (error) {
      console.error('[Notification] Error saving in-app notification:', error);
      // Don't fail the whole operation if saving notification fails
      // Log the error but continue
    }

    // Notify all Super Admins about lead assignment
    try {
      const [superAdmins] = await pool.execute(
        'SELECT id, name, email FROM users WHERE role_name = ? AND is_active = ?',
        ['Super Admin', true]
      );

      if (superAdmins.length > 0) {
        const superAdminTitle = isBulk
          ? `${leadCount} Leads Assigned to ${user.name}`
          : leadCount === 1
          ? `Lead Assigned to ${user.name}`
          : `${leadCount} Leads Assigned to ${user.name}`;

        const superAdminBody = isBulk
          ? `${leadCount} leads have been assigned to ${user.name} (${user.roleName}).`
          : leadCount === 1 && leads.length > 0
          ? `Lead "${leads[0].name}" (${leads[0].enquiryNumber || leads[0]?.enquiry_number || 'Pending'}) has been assigned to ${user.name} (${user.roleName}).`
          : `${leadCount} leads have been assigned to ${user.name} (${user.roleName}).`;

        // Send push notifications to all Super Admins
        const superAdminIds = superAdmins.map((admin) => admin.id);
        const pushResult = await sendPushNotificationToUsers(superAdminIds, {
          title: superAdminTitle,
          body: superAdminBody,
          url: '/superadmin/leads',
          data: {
            type: 'lead_assignment',
            assignedToUserId: userId,
            assignedToUserName: user.name,
            leadCount,
            isBulk,
            timestamp: Date.now(),
          },
        });

        // Save in-app notifications for all Super Admins
        const notificationPromises = superAdmins.map(async (admin) => {
          try {
            const notificationId = uuidv4();
            const notificationData = {
              assignedToUserId: userId,
              assignedToUserName: user.name,
              assignedToUserRole: user.roleName,
              leadCount: leadCount || 0,
              isBulk: isBulk || false,
              leads: (leads || []).slice(0, 5).map((l) => ({
                id: l?.id || l?._id?.toString() || 'unknown',
                name: l?.name || 'Unknown',
                enquiryNumber: l?.enquiryNumber || l?.enquiry_number || 'N/A',
              })),
            };

            await pool.execute(
              `INSERT INTO notifications (
                id, user_id, type, title, message, data,
                channel_push, channel_email, channel_sms,
                action_url, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
              [
                notificationId,
                admin.id,
                'lead_assignment',
                superAdminTitle,
                superAdminBody,
                JSON.stringify(notificationData),
                pushResult.sent > 0 ? 1 : 0,
                0,
                0,
                '/superadmin/leads',
              ]
            );
            return { success: true };
          } catch (error) {
            console.error(`[Notification] Error saving notification for Super Admin ${admin.id}:`, error);
            return null;
          }
        });

        await Promise.all(notificationPromises);
      }
    } catch (error) {
      console.error('[Notification] Error notifying Super Admins about assignment:', error);
      // Don't fail the whole operation if Super Admin notification fails
    }
  } catch (error) {
    console.error('[Notification] Error in notifyLeadAssignment:', error);
    throw error;
  }

  return results;
};

/**
 * Send SMS to lead when assigned to a counsellor
 * @param {Object} lead - Lead object
 * @param {Object} user - User object (counsellor)
 * @returns {Promise<Object>} Notification results
 */
export const notifyLeadAssignedToCounsellor = async (lead, user) => {
  const results = {
    sms: { sent: false, error: null },
  };

  try {
    if (lead.phone) {
      const smsMessage = `Dear ${lead.name}, Your enquiry ${lead.enquiryNumber || 'is pending'} has been assigned to counsellor ${user.name}. You will be contacted soon. - CRM Admissions`;
      
      await sendSmsThroughBulkSmsApps({
        numbers: [lead.phone],
        message: smsMessage,
        isUnicode: false,
      });
      
      results.sms.sent = true;
    }
  } catch (error) {
    console.error('[Notification] Error sending SMS to lead:', error);
    results.sms.error = error.message;
  }

  return results;
};

