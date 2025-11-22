import { sendSmsThroughBulkSmsApps } from './bulkSms.service.js';
import { sendEmail } from './unifiedEmail.service.js';
import {
  sendPushNotificationToUser,
  sendPushNotificationToUsers,
} from './pushNotification.service.js';
import User from '../models/User.model.js';
import Notification from '../models/Notification.model.js';

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
      const superAdmins = await User.find({ roleName: 'Super Admin', isActive: true })
        .select('_id name email')
        .lean();

      if (superAdmins.length > 0) {
        const notificationTitle = 'New Lead Created';
        const notificationBody = `A new lead has been created: ${lead.name} (${lead.enquiryNumber || 'Pending'}) - ${lead.phone || 'No phone'}`;

        // Send push notifications to all Super Admins
        const superAdminIds = superAdmins.map((admin) => admin._id.toString());
        const pushResult = await sendPushNotificationToUsers(superAdminIds, {
          title: notificationTitle,
          body: notificationBody,
          url: '/superadmin/leads',
          data: {
            type: 'lead_created',
            leadId: lead._id?.toString() || lead.id,
            timestamp: Date.now(),
          },
        });

        // Save in-app notifications for all Super Admins
        const notificationPromises = superAdmins.map((admin) =>
          Notification.create({
            userId: admin._id,
            type: 'lead_created',
            title: notificationTitle,
            message: notificationBody,
            data: {
              leadId: lead._id?.toString() || lead.id,
              leadName: lead.name,
              enquiryNumber: lead.enquiryNumber,
              phone: lead.phone,
            },
            channels: {
              push: pushResult.sent > 0,
              email: false,
              sms: false,
            },
            leadId: lead._id,
            actionUrl: '/superadmin/leads',
          }).catch((error) => {
            console.error(`[Notification] Error saving notification for Super Admin ${admin._id}:`, error);
            return null;
          })
        );

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
    const user = await User.findById(userId).select('name email roleName').lean();
    if (!user) {
      throw new Error('User not found');
    }

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
      const Lead = (await import('../models/Lead.model.js')).default;
      const mongoose = (await import('mongoose')).default;
      const leadObjectIds = allLeadIds.map((id) => new mongoose.Types.ObjectId(id));
      const fetchedLeads = await Lead.find({ _id: { $in: leadObjectIds } })
        .select('_id name phone enquiryNumber')
        .lean();
      leadsToNotify = fetchedLeads;
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
            console.error(`[Notification] Error sending SMS to lead ${lead._id}:`, error);
            // Don't fail the whole operation if SMS fails
          }
        }
      }
    }

    // Save in-app notification for assigned user (save after all channels are processed)
    // Always save notification even if push/email failed, so user can see it in-app
    try {
      const notificationData = {
        userId,
        type: 'lead_assignment',
        title: notificationTitle,
        message: notificationBody,
        data: {
          leadCount: leadCount || 0,
          isBulk: isBulk || false,
          leads: (leads || []).slice(0, 10).map((l) => ({
            id: l?._id?.toString() || l?.id || 'unknown',
            name: l?.name || 'Unknown',
            enquiryNumber: l?.enquiryNumber || 'N/A',
          })),
        },
        channels: {
          push: results.push.sent || false,
          email: results.email.sent || false,
          sms: false,
        },
        actionUrl: '/superadmin/leads',
      };

      await Notification.create(notificationData);
    } catch (error) {
      console.error('[Notification] Error saving in-app notification:', error);
      // Don't fail the whole operation if saving notification fails
      // Log the error but continue
    }

    // Notify all Super Admins about lead assignment
    try {
      const superAdmins = await User.find({ roleName: 'Super Admin', isActive: true })
        .select('_id name email')
        .lean();

      if (superAdmins.length > 0) {
        const superAdminTitle = isBulk
          ? `${leadCount} Leads Assigned to ${user.name}`
          : leadCount === 1
          ? `Lead Assigned to ${user.name}`
          : `${leadCount} Leads Assigned to ${user.name}`;

        const superAdminBody = isBulk
          ? `${leadCount} leads have been assigned to ${user.name} (${user.roleName}).`
          : leadCount === 1 && leads.length > 0
          ? `Lead "${leads[0].name}" (${leads[0].enquiryNumber || 'Pending'}) has been assigned to ${user.name} (${user.roleName}).`
          : `${leadCount} leads have been assigned to ${user.name} (${user.roleName}).`;

        // Send push notifications to all Super Admins
        const superAdminIds = superAdmins.map((admin) => admin._id.toString());
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
        const notificationPromises = superAdmins.map((admin) =>
          Notification.create({
            userId: admin._id,
            type: 'lead_assignment',
            title: superAdminTitle,
            message: superAdminBody,
            data: {
              assignedToUserId: userId,
              assignedToUserName: user.name,
              assignedToUserRole: user.roleName,
              leadCount: leadCount || 0,
              isBulk: isBulk || false,
              leads: (leads || []).slice(0, 5).map((l) => ({
                id: l?._id?.toString() || l?.id || 'unknown',
                name: l?.name || 'Unknown',
                enquiryNumber: l?.enquiryNumber || 'N/A',
              })),
            },
            channels: {
              push: pushResult.sent > 0,
              email: false,
              sms: false,
            },
            actionUrl: '/superadmin/leads',
          }).catch((error) => {
            console.error(`[Notification] Error saving notification for Super Admin ${admin._id}:`, error);
            return null;
          })
        );

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

