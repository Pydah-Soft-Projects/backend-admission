# Notification System Setup Guide

This guide explains how to set up the notification system for the CRM Admissions application.

## Overview

The notification system supports three types of notifications:
1. **SMS Notifications** - Using existing Bulk SMS service
2. **Email Notifications** - Using Brevo (formerly Sendinblue)
3. **Push Notifications** - Using Web Push API with VAPID

## Environment Variables

Add the following environment variables to your `.env` file:

### Brevo Email Service
```env
BREVO_API_KEY=your_brevo_api_key_here
BREVO_SENDER_EMAIL=team@pydasoft.in
BREVO_SENDER_NAME=CRM Admissions
```

### VAPID Keys for Push Notifications
```env
VAPID_PUBLIC_KEY=your_vapid_public_key
VAPID_PRIVATE_KEY=your_vapid_private_key
VAPID_SUBJECT=mailto:team@pydasoft.in
```

### Frontend URL (for email links)
```env
FRONTEND_URL=http://localhost:3000
# Or your production URL: https://your-domain.com
```

## Generating VAPID Keys

Run the following command to generate VAPID keys:

```bash
node src/scripts/generateVapidKeys.js
```

This will output the public and private keys. Add them to your `.env` file.

## Notification Triggers

### 1. Lead Creation
- **SMS**: Automatically sent to the lead when a new lead is created
- **Message**: "Dear [Name], Thank you for your interest! Your enquiry number is [ENQ...]. Our team will contact you soon. - CRM Admissions"

### 2. Lead Assignment
When leads are assigned to a user/counsellor:

**To the User/Counsellor:**
- **Push Notification**: Real-time browser notification
- **Email**: Detailed email with lead information
- **Bulk Assignment**: Single email with count summary

**To the Lead:**
- **SMS**: Individual SMS to each assigned lead
- **Message**: "Dear [Name], Your enquiry [ENQ...] has been assigned to counsellor [Name]. You will be contacted soon. - CRM Admissions"

## API Endpoints

### Push Notifications
- `GET /api/notifications/push/vapid-key` - Get VAPID public key
- `POST /api/notifications/push/subscribe` - Subscribe to push notifications
- `POST /api/notifications/push/unsubscribe` - Unsubscribe from push notifications
- `POST /api/notifications/push/test` - Send test push notification

## Frontend Integration

The push notification system is automatically initialized when users log in. The service worker is registered at `/sw.js`.

### Manual Subscription

Users can manually subscribe to push notifications by calling:
```typescript
import { subscribeToPushNotifications } from '@/lib/pushNotifications';

await subscribeToPushNotifications();
```

## Testing

1. **Test SMS**: Create a new lead and verify SMS is sent
2. **Test Email**: Assign a lead to a user and check their email
3. **Test Push**: 
   - Log in as a user
   - The system will automatically request permission
   - Assign a lead to that user
   - Verify push notification appears

## Troubleshooting

### SMS Not Sending
- Check `BULK_SMS_API_KEY` is set in environment
- Verify phone numbers are in correct format

### Email Not Sending
- Verify `BREVO_API_KEY` is correct
- Check Brevo dashboard for API usage limits
- Verify sender email is verified in Brevo

### Push Notifications Not Working
- Ensure VAPID keys are generated and set
- Check browser console for service worker errors
- Verify HTTPS is enabled (required for push notifications in production)
- Check that service worker is registered at `/sw.js`

## Notes

- All notifications are sent asynchronously and won't block the main request
- Failed notifications are logged but don't fail the operation
- Push notifications require HTTPS in production (localhost is allowed for development)
- SMS and email failures are logged but don't prevent lead creation/assignment

