# Controller Migration Tracker - MongoDB to SQL

## Overview
This document tracks the migration progress of all controllers from MongoDB to SQL (Amazon RDS MySQL).

**Migration Strategy**: Update existing controllers to use SQL queries instead of creating new files.

---

## Migration Status

### ✅ Completed Controllers

| Controller | Status | Complexity | Models Used | Notes |
|------------|--------|------------|-------------|-------|
| `auth.controller.js` | ✅ **DONE** | Simple | User | Login, getMe, logout |
| `user.controller.js` | ✅ **DONE** | Medium | User | CRUD operations, permissions, manager logic |
| `course.controller.js` | ✅ **DONE** | Simple | Course, Branch | CRUD for courses and branches |
| `notificationConfig.controller.js` | ✅ **DONE** | Simple | NotificationConfig | Get/update notification settings |
| `paymentConfig.controller.js` | ✅ **DONE** | Simple | PaymentConfig, PaymentGatewayConfig | Payment fee management, Cashfree config |
| `template.controller.js` | ✅ **DONE** | Simple | MessageTemplate | CRUD for message templates |
| `utm.controller.js` | ✅ **DONE** | Simple | ShortUrl, ShortUrlClick | URL shortening, UTM tracking, click analytics |
| `activityLog.controller.js` | ✅ **DONE** | Medium | ActivityLog | Add activity, get activity logs |
| `leadStatus.controller.js` | ✅ **DONE** | Medium | Lead, LeadStatusLog | Update status, get status logs |
| `leadAssignment.controller.js` | ✅ **DONE** | Medium | Lead, ActivityLog | Bulk assignment, analytics, overview |
| `communication.controller.js` | ✅ **DONE** | Medium | Communication | Call logging, SMS sending, stats |
| `notification.controller.js` | ✅ **DONE** | Medium | Notification | Get, mark read, delete notifications |
| `pushNotification.controller.js` | ✅ **DONE** | Medium | PushSubscription | Subscribe, unsubscribe, test push |
| `manager.controller.js` | ✅ **DONE** | Medium | User, Lead, Communication, ActivityLog | Team management, analytics, unfollowed leads |
| `report.controller.js` | ✅ **DONE** | Medium | Communication, Lead, Admission, ActivityLog | Daily call reports, conversion reports |
| `lead.controller.js` | ✅ **DONE** | **Complex** | Lead, LeadStatusLog, ActivityLog, DeleteJob | Full CRUD, filtering, search, bulk delete, activity logs |
| `leadUpload.controller.js` | ✅ **DONE** | **Complex** | Lead, ImportJob, ImportJobErrorDetails | Bulk upload, import job processing, stats |
| `joining.controller.js` | ✅ **DONE** | **Complex** | Joining, JoiningRelatives, JoiningEducationHistory, JoiningSiblings, Lead, Course, Branch | CRUD, draft management, approval workflow |

---

### 🔄 In Progress Controllers

| Controller | Status | Complexity | Models Used | Notes |
|------------|--------|------------|-------------|-------|
| - | - | - | - | - |

---

### ⏳ Pending Controllers (Ordered by Complexity)

#### Simple Controllers (No Relationships)
| Controller | Status | Complexity | Models Used | Dependencies |
|------------|--------|------------|-------------|--------------|
| `course.controller.js` | ✅ **DONE** | Simple | Course, Branch | None |
| `role.controller.js` | ✅ **DONE** | Simple | Role | CRUD operations for roles |
| `notificationConfig.controller.js` | ✅ **DONE** | Simple | NotificationConfig | User |
| `paymentConfig.controller.js` | ✅ **DONE** | Simple | PaymentConfig, PaymentGatewayConfig | Course, Branch |
| `paymentGatewayConfig.controller.js` | ✅ **DONE** | Simple | PaymentGatewayConfig | User (handled in paymentConfig.controller.js) |
| `template.controller.js` | ✅ **DONE** | Simple | MessageTemplate | None |
| `utm.controller.js` | ✅ **DONE** | Simple | ShortUrl, ShortUrlClick | User |

#### Medium Complexity Controllers
| Controller | Status | Complexity | Models Used | Dependencies |
|------------|--------|------------|-------------|--------------|
| `activityLog.controller.js` | ✅ **DONE** | Medium | ActivityLog | User, Lead |
| `communication.controller.js` | ✅ **DONE** | Medium | Communication | Lead, MessageTemplate, User |
| `notification.controller.js` | ✅ **DONE** | Medium | Notification | User, Lead |
| `pushNotification.controller.js` | ✅ **DONE** | Medium | PushSubscription | User |
| `report.controller.js` | ✅ **DONE** | Medium | Multiple | Lead, Joining, Admission, Payment |
| `leadStatus.controller.js` | ✅ **DONE** | Medium | Lead, LeadStatusLog | Lead, User |
| `leadAssignment.controller.js` | ✅ **DONE** | Medium | Lead | Lead, User |
| `manager.controller.js` | ✅ **DONE** | Medium | User, Lead | User, Lead |

#### Complex Controllers (Multiple Relationships)
| Controller | Status | Complexity | Models Used | Dependencies |
|------------|--------|------------|-------------|--------------|
| `lead.controller.js` | ✅ **DONE** | **Complex** | Lead, LeadStatusLog, ActivityLog, DeleteJob | Full CRUD, filtering, search, bulk delete |
| `leadUpload.controller.js` | ✅ **DONE** | **Complex** | Lead, ImportJob, ImportJobErrorDetails | Bulk upload, import job processing, stats |
| `joining.controller.js` | ✅ **DONE** | **Complex** | Joining, JoiningRelatives, JoiningEducationHistory, JoiningSiblings, Lead, Course, Branch | CRUD, draft management, approval workflow |
| `admission.controller.js` | ✅ **DONE** | **Complex** | Admission, AdmissionRelatives, AdmissionEducationHistory, AdmissionSiblings, Joining, Lead, Course, Branch | Admission CRUD, related tables management |
| `payment.controller.js` | ✅ **DONE** | **Complex** | PaymentTransaction, Joining, Admission, Lead, Course, Branch, User | Payment transactions, Cashfree integration, reconciliation |

---

## Migration Checklist

### Phase 1: Authentication & User Management ✅
- [x] `auth.controller.js` - Login, getMe, logout
- [x] `auth.middleware.js` - protect middleware
- [x] `user.controller.js` - CRUD operations

### Phase 2: Simple Controllers (No Relationships)
- [x] `course.controller.js`
- [x] `role.controller.js`
- [x] `notificationConfig.controller.js`
- [x] `paymentConfig.controller.js`
- [x] `paymentGatewayConfig.controller.js` (handled in paymentConfig.controller.js)
- [x] `template.controller.js`
- [x] `utm.controller.js`

### Phase 3: Medium Complexity Controllers
- [x] `activityLog.controller.js`
- [x] `communication.controller.js`
- [x] `notification.controller.js`
- [x] `pushNotification.controller.js`
- [x] `report.controller.js`
- [x] `leadStatus.controller.js`
- [x] `leadAssignment.controller.js`
- [x] `manager.controller.js`

### Phase 4: Complex Controllers (Multiple Relationships)
- [x] `lead.controller.js`
- [x] `leadUpload.controller.js`
- [x] `joining.controller.js`
- [x] `admission.controller.js`
- [x] `payment.controller.js`

---

## Migration Notes

### Common Patterns Applied

1. **Database Connection**
   ```javascript
   import { getPool } from '../config-sql/database.js';
   const pool = getPool();
   ```

2. **Query Execution**
   ```javascript
   const [results] = await pool.execute('SELECT ... FROM table WHERE id = ?', [id]);
   ```

3. **Data Formatting**
   - Snake_case (SQL) → camelCase (JavaScript)
   - Boolean conversion: `is_active === 1` → `isActive: true`
   - JSON parsing for JSON columns
   - UUID handling (CHAR(36))

4. **Error Handling**
   - Try-catch blocks
   - Console.error for debugging
   - Proper error responses

5. **Backward Compatibility**
   - Include both `id` and `_id` fields
   - Maintain same API response structure

### SQL Table Mappings

| MongoDB Model | SQL Table(s) | Notes |
|--------------|--------------|-------|
| User | `users` | Single table |
| Course | `courses` | Single table |
| Branch | `branches` | Single table |
| Lead | `leads`, `lead_status_logs` | 2 tables (array normalized) |
| Joining | `joinings`, `joining_relatives`, `joining_education_history`, `joining_siblings` | 4 tables |
| Admission | `admissions`, `admission_relatives`, `admission_education_history`, `admission_siblings` | 4 tables |
| PaymentTransaction | `payment_transactions` | Single table |
| Communication | `communications` | Single table |
| MessageTemplate | `message_templates` | Single table |
| ActivityLog | `activity_logs` | Single table |
| Notification | `notifications` | Single table (note: `read` is reserved keyword) |
| ShortUrl | `short_urls`, `short_url_clicks` | 2 tables |
| ImportJob | `import_jobs`, `import_job_error_details` | 2 tables |
| DeleteJob | `delete_jobs`, `delete_job_lead_ids`, `delete_job_error_details` | 3 tables |

---

## Next Steps

1. ✅ Complete authentication controllers
2. ⏳ Start with simple controllers (course, etc.)
3. ⏳ Move to medium complexity
4. ⏳ Handle complex controllers last

---

## Last Updated
- **Date**: 2026-01-23
- **Completed**: 22 controllers (auth, user, course, notificationConfig, paymentConfig [includes paymentGatewayConfig], template, utm, role, lead, leadUpload, joining, admission, payment, activityLog, leadStatus, leadAssignment, communication, notification, pushNotification, manager, report)
- **Skipped**: 0 controllers
- **Remaining**: 0 controllers
