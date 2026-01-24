# MongoDB Models to SQL Tables Mapping

## Overview

**MongoDB Models**: 20 models  
**SQL Tables**: 30 tables

**Why the difference?** MongoDB stores arrays and nested objects within documents, but SQL requires normalization into separate tables for proper relational structure and queryability.

---

## Complete Mapping

### 1. User Model → 1 Table
- ✅ `users` (1 table)

**MongoDB**: Single document  
**SQL**: Single table

---

### 2. Lead Model → 2 Tables
- ✅ `leads` (main table)
- ✅ `lead_status_logs` (array → separate table)

**MongoDB**: 
```javascript
{
  _id: ObjectId,
  name: String,
  statusLogs: [  // ← Array stored in same document
    { status, comment, changedBy, changedAt }
  ]
}
```

**SQL**: 
- `leads` table (main data)
- `lead_status_logs` table (one row per status log entry)

**Reason**: Arrays in MongoDB become separate tables in SQL for:
- Better queryability
- Proper indexing
- Easier joins and filtering

---

### 3. Joining Model → 4 Tables
- ✅ `joinings` (main table)
- ✅ `joining_relatives` (array → separate table)
- ✅ `joining_education_history` (array → separate table)
- ✅ `joining_siblings` (array → separate table)

**MongoDB**:
```javascript
{
  _id: ObjectId,
  leadId: ObjectId,
  relatives: [  // ← Array
    { name, relationship, address... }
  ],
  educationHistory: [  // ← Array
    { level, institution, year... }
  ],
  siblings: [  // ← Array
    { name, relation, institution... }
  ]
}
```

**SQL**: 
- `joinings` table (main data)
- `joining_relatives` table (one row per relative)
- `joining_education_history` table (one row per education entry)
- `joining_siblings` table (one row per sibling)

---

### 4. Admission Model → 4 Tables
- ✅ `admissions` (main table)
- ✅ `admission_relatives` (array → separate table)
- ✅ `admission_education_history` (array → separate table)
- ✅ `admission_siblings` (array → separate table)

**Same structure as Joining** - arrays converted to separate tables.

---

### 5. Course Model → 1 Table
- ✅ `courses` (1 table)

**MongoDB**: Single document  
**SQL**: Single table

---

### 6. Branch Model → 1 Table
- ✅ `branches` (1 table)

**MongoDB**: Single document  
**SQL**: Single table

---

### 7. PaymentTransaction Model → 1 Table
- ✅ `payment_transactions` (1 table)

**MongoDB**: Single document  
**SQL**: Single table

---

### 8. PaymentConfig Model → 1 Table
- ✅ `payment_configs` (1 table)

**MongoDB**: Single document  
**SQL**: Single table

---

### 9. PaymentGatewayConfig Model → 1 Table
- ✅ `payment_gateway_configs` (1 table)

**MongoDB**: Single document  
**SQL**: Single table

---

### 10. Communication Model → 1 Table
- ✅ `communications` (1 table)

**MongoDB**: Single document  
**SQL**: Single table

---

### 11. MessageTemplate Model → 1 Table
- ✅ `message_templates` (1 table)

**MongoDB**: Single document  
**SQL**: Single table

---

### 12. ActivityLog Model → 1 Table
- ✅ `activity_logs` (1 table)

**MongoDB**: Single document  
**SQL**: Single table

---

### 13. Notification Model → 1 Table
- ✅ `notifications` (1 table)

**MongoDB**: Single document  
**SQL**: Single table

---

### 14. NotificationConfig Model → 1 Table
- ✅ `notification_configs` (1 table)

**MongoDB**: Single document  
**SQL**: Single table

---

### 15. PushSubscription Model → 1 Table
- ✅ `push_subscriptions` (1 table)

**MongoDB**: Single document  
**SQL**: Single table

---

### 16. ShortUrl Model → 2 Tables
- ✅ `short_urls` (main table)
- ✅ `short_url_clicks` (array → separate table)

**MongoDB**:
```javascript
{
  _id: ObjectId,
  shortCode: String,
  clicks: [  // ← Array
    { clickedAt, ipAddress, userAgent, referer }
  ]
}
```

**SQL**:
- `short_urls` table (main data)
- `short_url_clicks` table (one row per click)

**Reason**: Better analytics - can query clicks separately, filter by date, count, etc.

---

### 17. ImportJob Model → 2 Tables
- ✅ `import_jobs` (main table)
- ✅ `import_job_error_details` (array → separate table)

**MongoDB**:
```javascript
{
  _id: ObjectId,
  uploadId: String,
  errorDetails: [  // ← Array
    { sheet, row, error }
  ]
}
```

**SQL**:
- `import_jobs` table (main data)
- `import_job_error_details` table (one row per error)

**Reason**: Better error tracking and reporting.

---

### 18. DeleteJob Model → 3 Tables
- ✅ `delete_jobs` (main table)
- ✅ `delete_job_lead_ids` (array → separate table)
- ✅ `delete_job_error_details` (array → separate table)

**MongoDB**:
```javascript
{
  _id: ObjectId,
  jobId: String,
  leadIds: [ObjectId],  // ← Array
  errorDetails: [  // ← Array
    { leadId, error }
  ]
}
```

**SQL**:
- `delete_jobs` table (main data)
- `delete_job_lead_ids` table (one row per lead ID)
- `delete_job_error_details` table (one row per error)

**Reason**: Better tracking of which leads were deleted and any errors.

---

### 19. AdmissionSequence Model → 1 Table
- ✅ `admission_sequences` (1 table)

**MongoDB**: Single document  
**SQL**: Single table

---

### 20. Role Model → 0 Tables
- ❌ Not included (deprecated - using `roleName` string in User model)

---

## Summary Table

| MongoDB Model | SQL Tables | Count | Reason |
|--------------|------------|-------|--------|
| User | users | 1 | Simple model |
| Lead | leads, lead_status_logs | 2 | `statusLogs` array |
| Joining | joinings, joining_relatives, joining_education_history, joining_siblings | 4 | 3 arrays |
| Admission | admissions, admission_relatives, admission_education_history, admission_siblings | 4 | 3 arrays |
| Course | courses | 1 | Simple model |
| Branch | branches | 1 | Simple model |
| PaymentTransaction | payment_transactions | 1 | Simple model |
| PaymentConfig | payment_configs | 1 | Simple model |
| PaymentGatewayConfig | payment_gateway_configs | 1 | Simple model |
| Communication | communications | 1 | Simple model |
| MessageTemplate | message_templates | 1 | Simple model |
| ActivityLog | activity_logs | 1 | Simple model |
| Notification | notifications | 1 | Simple model |
| NotificationConfig | notification_configs | 1 | Simple model |
| PushSubscription | push_subscriptions | 1 | Simple model |
| ShortUrl | short_urls, short_url_clicks | 2 | `clicks` array |
| ImportJob | import_jobs, import_job_error_details | 2 | `errorDetails` array |
| DeleteJob | delete_jobs, delete_job_lead_ids, delete_job_error_details | 3 | 2 arrays |
| AdmissionSequence | admission_sequences | 1 | Simple model |
| Role | (deprecated) | 0 | Not used |
| **TOTAL** | | **30** | |

---

## Why Arrays Become Separate Tables?

### Benefits of Normalization:

1. **Queryability**
   - MongoDB: `lead.statusLogs[0].status` (hard to query)
   - SQL: `SELECT * FROM lead_status_logs WHERE lead_id = ?` (easy query)

2. **Indexing**
   - Can index individual array elements
   - Better performance for filtering

3. **Relationships**
   - Proper foreign keys
   - Referential integrity
   - Cascade deletes

4. **Scalability**
   - No document size limits
   - Better for large arrays

5. **Analytics**
   - Count clicks, errors, etc.
   - Filter by date ranges
   - Aggregate data easily

### Example: Lead Status Logs

**MongoDB** (embedded):
```javascript
{
  _id: ObjectId("..."),
  name: "John Doe",
  statusLogs: [
    { status: "New", changedAt: Date, changedBy: ObjectId },
    { status: "Contacted", changedAt: Date, changedBy: ObjectId }
  ]
}
```

**SQL** (normalized):
```sql
-- leads table
id: "uuid-123"
name: "John Doe"

-- lead_status_logs table
id: "uuid-456", lead_id: "uuid-123", status: "New", changed_at: "2024-01-01"
id: "uuid-789", lead_id: "uuid-123", status: "Contacted", changed_at: "2024-01-02"
```

**Query Benefits**:
```sql
-- Find all status changes in last week
SELECT * FROM lead_status_logs 
WHERE changed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY);

-- Count status changes per lead
SELECT lead_id, COUNT(*) as change_count 
FROM lead_status_logs 
GROUP BY lead_id;
```

---

## Conclusion

**20 MongoDB Models** → **30 SQL Tables**

The extra 10 tables come from:
- **Lead**: +1 (statusLogs)
- **Joining**: +3 (relatives, educationHistory, siblings)
- **Admission**: +3 (relatives, educationHistory, siblings)
- **ShortUrl**: +1 (clicks)
- **ImportJob**: +1 (errorDetails)
- **DeleteJob**: +2 (leadIds, errorDetails)

This normalization is standard practice in SQL databases and provides better query performance, data integrity, and scalability.
