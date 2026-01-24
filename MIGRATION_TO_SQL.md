# MongoDB to SQL Migration Documentation

## Table of Contents
1. [Overview](#overview)
2. [Current Architecture Analysis](#current-architecture-analysis)
3. [SQL Database Selection](#sql-database-selection)
4. [Schema Design](#schema-design)
5. [Model-by-Model Migration Mapping](#model-by-model-migration-mapping)
6. [Relationship Mappings](#relationship-mappings)
7. [Index Strategy](#index-strategy)
8. [Data Type Conversions](#data-type-conversions)
9. [Encryption Handling](#encryption-handling)
10. [Endpoint Changes Required](#endpoint-changes-required)
11. [Migration Strategy](#migration-strategy)
12. [Testing Checklist](#testing-checklist)
13. [Rollback Plan](#rollback-plan)

---

## Overview

This document provides a comprehensive guide for migrating the Admissions Application backend from MongoDB to a SQL database. The migration involves converting 20+ Mongoose models to SQL tables while maintaining data integrity, relationships, and business logic.

### Key Objectives
- **No data migration from MongoDB** - Fresh start with SQL database
- Maintain API compatibility (endpoints remain the same)
- Phase-wise migration: Models first, then Controllers
- Ensure data encryption for sensitive fields
- Optimize query performance with proper indexing
- Support all existing business logic and workflows
- Keep existing MongoDB code intact (separate folders)

### Migration Scope
- **Models**: 20 models to be migrated to SQL (new folder: `models-sql`)
- **Controllers**: 22 controllers to be migrated to SQL (new folder: `controllers-sql`)
- **Routes**: 13 route files - endpoints unchanged, implementation changes
- **Scripts**: All scripts updated for SQL (new folder: `scripts-sql`)
- **Services**: External integrations remain unchanged
- **Frontend**: No changes (API contract maintained)

---

## Current Architecture Analysis

### Technology Stack
- **Database**: MongoDB (NoSQL)
- **ORM**: Mongoose
- **Node.js**: ES6 Modules
- **Authentication**: JWT with bcrypt

### Current Model Count
1. User
2. Lead
3. Joining
4. Admission
5. Course
6. Branch
7. PaymentTransaction
8. PaymentConfig
9. PaymentGatewayConfig
10. Communication
11. MessageTemplate
12. ActivityLog
13. Notification
14. NotificationConfig
15. PushSubscription
16. ShortUrl
17. ImportJob
18. DeleteJob
19. AdmissionSequence
20. Role (deprecated, using roleName string)

### Key MongoDB Features Used
- Embedded documents (nested objects)
- Arrays of subdocuments
- Mixed types (JSON fields)
- Sparse indexes
- Text indexes
- Compound indexes
- Virtual fields (encryption getters/setters)

---

## SQL Database Selection

### Selected: Amazon RDS MySQL 8.0+
**Rationale:**
- Managed database service (Amazon RDS)
- JSON data type support for dynamic fields
- Excellent performance and scalability
- Wide adoption and strong ecosystem
- Full-text search support
- Strong ACID compliance
- Cost-effective managed solution

**Note**: Some limitations with nested JSON queries compared to PostgreSQL, but sufficient for our use case.

### Database Configuration
```env
# Amazon RDS MySQL
DB_TYPE=mysql
DB_HOST=your-rds-endpoint.region.rds.amazonaws.com
DB_PORT=3306
DB_NAME=admissions_db
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_SSL=true

# Connection Pool Settings
DB_POOL_MIN=2
DB_POOL_MAX=10
DB_POOL_IDLE_TIMEOUT=30000
DB_POOL_ACQUIRE_TIMEOUT=60000
DB_POOL_EVICT=1000

# RDS Specific
DB_TIMEZONE=+00:00
DB_CHARSET=utf8mb4
DB_COLLATION=utf8mb4_unicode_ci
```

---

## Schema Design

### Naming Conventions
- **Tables**: Plural, snake_case (e.g., `leads`, `payment_transactions`)
- **Columns**: snake_case (e.g., `created_at`, `assigned_to`)
- **Foreign Keys**: `{table}_id` (e.g., `user_id`, `lead_id`)
- **Primary Keys**: `id` (CHAR(36) for UUID or BIGINT AUTO_INCREMENT)
- **Timestamps**: `created_at`, `updated_at` (DATETIME or TIMESTAMP)
- **Database/Table Charset**: `utf8mb4` for full Unicode support

### Core Design Principles
1. **Normalization**: 3NF where possible, denormalize for performance when needed
2. **JSON Fields**: Use JSON data type for dynamic/flexible data (MySQL 5.7+)
3. **Encryption**: Store encrypted values as TEXT, decrypt at application level
4. **Soft Deletes**: Consider `deleted_at` for audit trails
5. **Audit Fields**: `created_by`, `updated_by` for tracking
6. **UUID vs Auto-Increment**: Use CHAR(36) for UUID strings (application-generated)

---

## Model-by-Model Migration Mapping

### 1. Users Table

**MongoDB Model**: `User.model.js`

**SQL Schema (MySQL)**:
```sql
CREATE TABLE users (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role_name VARCHAR(50) NOT NULL CHECK (role_name IN ('Super Admin', 'Sub Super Admin', 'User')),
    managed_by CHAR(36) NULL,
    is_manager BOOLEAN DEFAULT FALSE NOT NULL,
    designation VARCHAR(100),
    permissions JSON DEFAULT (JSON_OBJECT()),
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (managed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role_name ON users(role_name);
CREATE INDEX idx_users_is_active ON users(is_active);
CREATE INDEX idx_users_managed_by ON users(managed_by);
CREATE INDEX idx_users_is_manager ON users(is_manager);
```

**Key Changes**:
- `_id` → `id` (UUID)
- `roleName` → `role_name` (snake_case)
- `managedBy` → `managed_by` (UUID foreign key)
- `permissions` → JSONB (maintains structure)
- Timestamps use `TIMESTAMP WITH TIME ZONE`

**Migration Notes**:
- Convert ObjectId to UUID during migration
- Maintain bcrypt password hashing
- Preserve permissions JSON structure

---

### 2. Leads Table

**MongoDB Model**: `Lead.model.js`

**SQL Schema**:
```sql
CREATE TABLE leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enquiry_number VARCHAR(50) UNIQUE,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(255),
    father_name VARCHAR(255) NOT NULL,
    mother_name VARCHAR(255) DEFAULT '',
    father_phone VARCHAR(20) NOT NULL,
    hall_ticket_number VARCHAR(100) DEFAULT '',
    village VARCHAR(255) NOT NULL,
    course_interested VARCHAR(255),
    district VARCHAR(255) NOT NULL,
    mandal VARCHAR(255) NOT NULL,
    state VARCHAR(255) DEFAULT '',
    is_nri BOOLEAN DEFAULT FALSE NOT NULL,
    gender VARCHAR(50) DEFAULT 'Not Specified',
    rank INTEGER CHECK (rank >= 0),
    inter_college VARCHAR(255) DEFAULT '',
    quota VARCHAR(100) DEFAULT 'Not Applicable',
    application_status VARCHAR(100) DEFAULT 'Not Provided',
    dynamic_fields JSONB DEFAULT '{}'::jsonb,
    lead_status VARCHAR(50) DEFAULT 'New',
    admission_number VARCHAR(100) UNIQUE,
    assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMP WITH TIME ZONE,
    assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
    source VARCHAR(255),
    utm_source VARCHAR(255),
    utm_medium VARCHAR(255),
    utm_campaign VARCHAR(255),
    utm_term VARCHAR(255),
    utm_content VARCHAR(255),
    last_follow_up TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    upload_batch_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_leads_enquiry_number ON leads(enquiry_number) WHERE enquiry_number IS NOT NULL;
CREATE INDEX idx_leads_name ON leads(name);
CREATE INDEX idx_leads_phone ON leads(phone);
CREATE INDEX idx_leads_district ON leads(district);
CREATE INDEX idx_leads_mandal ON leads(mandal);
CREATE INDEX idx_leads_state ON leads(state);
CREATE INDEX idx_leads_quota ON leads(quota);
CREATE INDEX idx_leads_lead_status ON leads(lead_status);
CREATE INDEX idx_leads_assigned_to ON leads(assigned_to);
CREATE INDEX idx_leads_assigned_at ON leads(assigned_at);
CREATE INDEX idx_leads_upload_batch_id ON leads(upload_batch_id);
CREATE INDEX idx_leads_created_at ON leads(created_at DESC);
CREATE INDEX idx_leads_hall_ticket_number ON leads(hall_ticket_number);

-- Compound Indexes
CREATE INDEX idx_leads_district_mandal ON leads(district, mandal);
CREATE INDEX idx_leads_mandal_state ON leads(mandal, state);
CREATE INDEX idx_leads_status_assigned ON leads(lead_status, assigned_to);
CREATE INDEX idx_leads_phone_name ON leads(phone, name);

-- GIN Index for Full-Text Search (PostgreSQL)
CREATE INDEX idx_leads_fulltext ON leads USING GIN (
    to_tsvector('english', 
        COALESCE(enquiry_number, '') || ' ' ||
        COALESCE(name, '') || ' ' ||
        COALESCE(phone, '') || ' ' ||
        COALESCE(email, '') || ' ' ||
        COALESCE(father_name, '') || ' ' ||
        COALESCE(district, '') || ' ' ||
        COALESCE(mandal, '') || ' ' ||
        COALESCE(state, '')
    )
);

-- JSONB Index for dynamic_fields
CREATE INDEX idx_leads_dynamic_fields ON leads USING GIN (dynamic_fields);
```

**Key Changes**:
- `_id` → `id` (UUID)
- `enquiryNumber` → `enquiry_number`
- `dynamicFields` → `dynamic_fields` (JSONB)
- `statusLogs` → Separate table (see below)
- Full-text search using PostgreSQL `tsvector`

**Status Logs Table** (Separate):
```sql
CREATE TABLE lead_status_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    status VARCHAR(50),
    comment TEXT,
    changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_lead_status_logs_lead_id ON lead_status_logs(lead_id);
CREATE INDEX idx_lead_status_logs_changed_at ON lead_status_logs(changed_at DESC);
```

---

### 3. Joinings Table

**MongoDB Model**: `Joining.model.js`

**SQL Schema**:
```sql
CREATE TABLE joinings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    lead_data JSONB DEFAULT '{}'::jsonb,
    status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved')),
    course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    course VARCHAR(255) DEFAULT '',
    branch VARCHAR(255) DEFAULT '',
    quota VARCHAR(100) DEFAULT '',
    
    -- Payment Summary
    payment_total_fee DECIMAL(12, 2) DEFAULT 0 CHECK (payment_total_fee >= 0),
    payment_total_paid DECIMAL(12, 2) DEFAULT 0 CHECK (payment_total_paid >= 0),
    payment_balance DECIMAL(12, 2) DEFAULT 0 CHECK (payment_balance >= 0),
    payment_currency VARCHAR(10) DEFAULT 'INR',
    payment_status VARCHAR(50) DEFAULT 'not_started' CHECK (payment_status IN ('not_started', 'partial', 'paid')),
    payment_last_payment_at TIMESTAMP WITH TIME ZONE,
    
    -- Student Info
    student_name VARCHAR(255) DEFAULT '',
    student_aadhaar_number TEXT, -- Encrypted
    student_phone VARCHAR(20) DEFAULT '',
    student_gender VARCHAR(50) DEFAULT '',
    student_date_of_birth VARCHAR(20) DEFAULT '', -- DD-MM-YYYY
    student_notes TEXT DEFAULT 'As per SSC for no issues',
    
    -- Parents Info
    father_name VARCHAR(255) DEFAULT '',
    father_phone VARCHAR(20) DEFAULT '',
    father_aadhaar_number TEXT, -- Encrypted
    mother_name VARCHAR(255) DEFAULT '',
    mother_phone VARCHAR(20) DEFAULT '',
    mother_aadhaar_number TEXT, -- Encrypted
    
    -- Reservation
    reservation_general VARCHAR(20) NOT NULL CHECK (reservation_general IN ('oc', 'ews', 'bc-a', 'bc-b', 'bc-c', 'bc-d', 'bc-e', 'sc', 'st')),
    reservation_other JSONB DEFAULT '[]'::jsonb,
    
    -- Address (Communication)
    address_door_street VARCHAR(255) DEFAULT '',
    address_landmark VARCHAR(255) DEFAULT '',
    address_village_city VARCHAR(255) DEFAULT '',
    address_mandal VARCHAR(255) DEFAULT '',
    address_district VARCHAR(255) DEFAULT '',
    address_pin_code VARCHAR(10) DEFAULT '',
    
    -- Qualifications
    qualification_ssc BOOLEAN DEFAULT FALSE,
    qualification_inter_diploma BOOLEAN DEFAULT FALSE,
    qualification_ug BOOLEAN DEFAULT FALSE,
    qualification_mediums JSONB DEFAULT '[]'::jsonb CHECK (jsonb_typeof(qualification_mediums) = 'array'),
    qualification_other_medium_label VARCHAR(255) DEFAULT '',
    
    -- Documents Status
    document_ssc VARCHAR(20) DEFAULT 'pending' CHECK (document_ssc IN ('pending', 'received')),
    document_inter VARCHAR(20) DEFAULT 'pending' CHECK (document_inter IN ('pending', 'received')),
    document_ug_pg_cmm VARCHAR(20) DEFAULT 'pending' CHECK (document_ug_pg_cmm IN ('pending', 'received')),
    document_transfer_certificate VARCHAR(20) DEFAULT 'pending' CHECK (document_transfer_certificate IN ('pending', 'received')),
    document_study_certificate VARCHAR(20) DEFAULT 'pending' CHECK (document_study_certificate IN ('pending', 'received')),
    document_aadhaar_card VARCHAR(20) DEFAULT 'pending' CHECK (document_aadhaar_card IN ('pending', 'received')),
    document_photos VARCHAR(20) DEFAULT 'pending' CHECK (document_photos IN ('pending', 'received')),
    document_income_certificate VARCHAR(20) DEFAULT 'pending' CHECK (document_income_certificate IN ('pending', 'received')),
    document_caste_certificate VARCHAR(20) DEFAULT 'pending' CHECK (document_caste_certificate IN ('pending', 'received')),
    document_cet_rank_card VARCHAR(20) DEFAULT 'pending' CHECK (document_cet_rank_card IN ('pending', 'received')),
    document_cet_hall_ticket VARCHAR(20) DEFAULT 'pending' CHECK (document_cet_hall_ticket IN ('pending', 'received')),
    document_allotment_letter VARCHAR(20) DEFAULT 'pending' CHECK (document_allotment_letter IN ('pending', 'received')),
    document_joining_report VARCHAR(20) DEFAULT 'pending' CHECK (document_joining_report IN ('pending', 'received')),
    document_bank_passbook VARCHAR(20) DEFAULT 'pending' CHECK (document_bank_passbook IN ('pending', 'received')),
    document_ration_card VARCHAR(20) DEFAULT 'pending' CHECK (document_ration_card IN ('pending', 'received')),
    
    -- Audit Fields
    draft_updated_at TIMESTAMP WITH TIME ZONE,
    submitted_at TIMESTAMP WITH TIME ZONE,
    submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMP WITH TIME ZONE,
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_joinings_lead_id ON joinings(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX idx_joinings_status ON joinings(status);
CREATE INDEX idx_joinings_course_id ON joinings(course_id);
CREATE INDEX idx_joinings_branch_id ON joinings(branch_id);
CREATE INDEX idx_joinings_status_updated_at ON joinings(status, updated_at DESC);
CREATE INDEX idx_joinings_submitted_at ON joinings(submitted_at DESC);
```

**Related Tables**:

**Joining Relatives** (Array → Table):
```sql
CREATE TABLE joining_relatives (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    joining_id UUID NOT NULL REFERENCES joinings(id) ON DELETE CASCADE,
    name VARCHAR(255) DEFAULT '',
    relationship VARCHAR(100) DEFAULT '',
    door_street VARCHAR(255) DEFAULT '',
    landmark VARCHAR(255) DEFAULT '',
    village_city VARCHAR(255) DEFAULT '',
    mandal VARCHAR(255) DEFAULT '',
    district VARCHAR(255) DEFAULT '',
    pin_code VARCHAR(10) DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_joining_relatives_joining_id ON joining_relatives(joining_id);
```

**Joining Education History** (Array → Table):
```sql
CREATE TABLE joining_education_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    joining_id UUID NOT NULL REFERENCES joinings(id) ON DELETE CASCADE,
    level VARCHAR(50) NOT NULL CHECK (level IN ('ssc', 'inter_diploma', 'ug', 'other')),
    other_level_label VARCHAR(255) DEFAULT '',
    course_or_branch VARCHAR(255) DEFAULT '',
    year_of_passing VARCHAR(20) DEFAULT '',
    institution_name VARCHAR(255) DEFAULT '',
    institution_address TEXT DEFAULT '',
    hall_ticket_number VARCHAR(100) DEFAULT '',
    total_marks_or_grade VARCHAR(50) DEFAULT '',
    cet_rank VARCHAR(50) DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_joining_education_history_joining_id ON joining_education_history(joining_id);
```

**Joining Siblings** (Array → Table):
```sql
CREATE TABLE joining_siblings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    joining_id UUID NOT NULL REFERENCES joinings(id) ON DELETE CASCADE,
    name VARCHAR(255) DEFAULT '',
    relation VARCHAR(100) DEFAULT '',
    studying_standard VARCHAR(100) DEFAULT '',
    institution_name VARCHAR(255) DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_joining_siblings_joining_id ON joining_siblings(joining_id);
```

**Key Changes**:
- Nested objects flattened to columns with prefixes
- Arrays converted to separate tables
- Encrypted fields stored as TEXT
- JSONB for flexible fields (`reservation_other`, `qualification_mediums`)

---

### 4. Admissions Table

**MongoDB Model**: `Admission.model.js`

**SQL Schema**:
```sql
CREATE TABLE admissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    enquiry_number VARCHAR(50),
    lead_data JSONB DEFAULT '{}'::jsonb,
    joining_id UUID NOT NULL REFERENCES joinings(id) ON DELETE RESTRICT UNIQUE,
    admission_number VARCHAR(100) NOT NULL UNIQUE,
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
    admission_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Course Info
    course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    course VARCHAR(255) DEFAULT '',
    branch VARCHAR(255) DEFAULT '',
    quota VARCHAR(100) DEFAULT '',
    
    -- Payment Summary
    payment_total_fee DECIMAL(12, 2) DEFAULT 0 CHECK (payment_total_fee >= 0),
    payment_total_paid DECIMAL(12, 2) DEFAULT 0 CHECK (payment_total_paid >= 0),
    payment_balance DECIMAL(12, 2) DEFAULT 0 CHECK (payment_balance >= 0),
    payment_currency VARCHAR(10) DEFAULT 'INR',
    payment_status VARCHAR(50) DEFAULT 'not_started' CHECK (payment_status IN ('not_started', 'partial', 'paid')),
    payment_last_payment_at TIMESTAMP WITH TIME ZONE,
    
    -- Student Info (same structure as joinings)
    student_name VARCHAR(255) NOT NULL,
    student_aadhaar_number TEXT, -- Encrypted
    student_phone VARCHAR(20) DEFAULT '',
    student_gender VARCHAR(50) DEFAULT '',
    student_date_of_birth VARCHAR(20) DEFAULT '',
    student_notes TEXT DEFAULT '',
    
    -- Parents, Reservation, Address, Qualifications, Documents
    -- (Same structure as joinings - see joining schema above)
    
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_admissions_lead_id ON admissions(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX idx_admissions_joining_id ON admissions(joining_id);
CREATE INDEX idx_admissions_admission_number ON admissions(admission_number);
CREATE INDEX idx_admissions_status ON admissions(status);
CREATE INDEX idx_admissions_course_id ON admissions(course_id);
CREATE INDEX idx_admissions_branch_id ON admissions(branch_id);
CREATE INDEX idx_admissions_lead_admission_number ON admissions(lead_id, admission_number);
```

**Related Tables**: Same as joinings (relatives, education_history, siblings)

**Key Changes**:
- `joiningId` → `joining_id` (UNIQUE constraint)
- Similar structure to joinings (denormalized for performance)

---

### 5. Courses Table

**MongoDB Model**: `Course.model.js`

**SQL Schema**:
```sql
CREATE TABLE courses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL UNIQUE,
    code VARCHAR(100) UNIQUE,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_courses_name ON courses(name);
CREATE INDEX idx_courses_code ON courses(code) WHERE code IS NOT NULL;
CREATE INDEX idx_courses_is_active ON courses(is_active);
```

**Key Changes**:
- Simple 1:1 mapping
- `isActive` → `is_active`

---

### 6. Branches Table

**MongoDB Model**: `Branch.model.js`

**SQL Schema**:
```sql
CREATE TABLE branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(100),
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(course_id, name),
    UNIQUE(course_id, code) WHERE code IS NOT NULL
);

CREATE INDEX idx_branches_course_id ON branches(course_id);
CREATE INDEX idx_branches_is_active ON branches(is_active);
CREATE INDEX idx_branches_course_name ON branches(course_id, name);
```

**Key Changes**:
- Unique constraint on `(course_id, name)`
- Partial unique index on `(course_id, code)`

---

### 7. Payment Transactions Table

**MongoDB Model**: `PaymentTransaction.model.js`

**SQL Schema**:
```sql
CREATE TABLE payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admission_id UUID REFERENCES admissions(id) ON DELETE SET NULL,
    joining_id UUID NOT NULL REFERENCES joinings(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    amount DECIMAL(12, 2) NOT NULL CHECK (amount >= 0),
    currency VARCHAR(10) DEFAULT 'INR' NOT NULL,
    mode VARCHAR(20) NOT NULL CHECK (mode IN ('cash', 'online', 'upi_qr')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
    collected_by UUID REFERENCES users(id) ON DELETE SET NULL,
    cashfree_order_id VARCHAR(255),
    cashfree_payment_session_id VARCHAR(255),
    reference_id VARCHAR(255),
    notes TEXT,
    is_additional_fee BOOLEAN DEFAULT FALSE NOT NULL,
    meta JSONB DEFAULT '{}'::jsonb,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    verified_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_payment_transactions_joining_id ON payment_transactions(joining_id);
CREATE INDEX idx_payment_transactions_lead_id ON payment_transactions(lead_id);
CREATE INDEX idx_payment_transactions_admission_id ON payment_transactions(admission_id);
CREATE INDEX idx_payment_transactions_mode ON payment_transactions(mode);
CREATE INDEX idx_payment_transactions_status ON payment_transactions(status);
CREATE INDEX idx_payment_transactions_cashfree_order_id ON payment_transactions(cashfree_order_id);
CREATE INDEX idx_payment_transactions_reference_id ON payment_transactions(reference_id);
CREATE INDEX idx_payment_transactions_is_additional_fee ON payment_transactions(is_additional_fee);
CREATE INDEX idx_payment_transactions_lead_created ON payment_transactions(lead_id, created_at DESC);
CREATE INDEX idx_payment_transactions_admission_created ON payment_transactions(admission_id, created_at DESC);
```

**Key Changes**:
- `Number` → `DECIMAL(12, 2)` for monetary values
- `meta` → JSONB

---

### 8. Payment Config Table

**MongoDB Model**: `PaymentConfig.model.js`

**SQL Schema**:
```sql
CREATE TABLE payment_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
    amount DECIMAL(12, 2) NOT NULL CHECK (amount >= 0),
    currency VARCHAR(10) DEFAULT 'INR' NOT NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    notes TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(course_id, branch_id) WHERE is_active = TRUE
);

CREATE INDEX idx_payment_configs_course_id ON payment_configs(course_id);
CREATE INDEX idx_payment_configs_branch_id ON payment_configs(branch_id);
CREATE INDEX idx_payment_configs_is_active ON payment_configs(is_active);
```

**Key Changes**:
- Partial unique index for active configs only

---

### 9. Payment Gateway Config Table

**MongoDB Model**: `PaymentGatewayConfig.model.js`

**SQL Schema**:
```sql
CREATE TABLE payment_gateway_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(50) NOT NULL UNIQUE CHECK (provider IN ('cashfree')),
    display_name VARCHAR(255) DEFAULT 'Cashfree',
    client_id TEXT NOT NULL, -- Encrypted
    client_secret TEXT NOT NULL, -- Encrypted
    environment VARCHAR(20) DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'production')),
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_payment_gateway_configs_provider ON payment_gateway_configs(provider);
```

**Key Changes**:
- Encrypted fields stored as TEXT
- Decryption handled at application level

---

### 10. Communications Table

**MongoDB Model**: `Communication.model.js`

**SQL Schema**:
```sql
CREATE TABLE communications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    contact_number VARCHAR(20) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('call', 'sms')),
    direction VARCHAR(20) DEFAULT 'outgoing' CHECK (direction IN ('outgoing', 'incoming')),
    status VARCHAR(20) DEFAULT 'success' CHECK (status IN ('pending', 'success', 'failed')),
    remarks TEXT,
    call_outcome VARCHAR(255),
    duration_seconds INTEGER CHECK (duration_seconds >= 0),
    
    -- Template Info
    template_id UUID REFERENCES message_templates(id) ON DELETE SET NULL,
    template_dlt_template_id VARCHAR(255),
    template_name VARCHAR(255),
    template_language VARCHAR(10),
    template_original_content TEXT,
    template_rendered_content TEXT,
    template_variables JSONB DEFAULT '[]'::jsonb,
    
    provider_message_ids JSONB DEFAULT '[]'::jsonb,
    metadata JSONB DEFAULT '{}'::jsonb,
    sent_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_communications_lead_id ON communications(lead_id);
CREATE INDEX idx_communications_contact_number ON communications(contact_number);
CREATE INDEX idx_communications_type ON communications(type);
CREATE INDEX idx_communications_status ON communications(status);
CREATE INDEX idx_communications_sent_by ON communications(sent_by);
CREATE INDEX idx_communications_sent_at ON communications(sent_at DESC);
CREATE INDEX idx_communications_lead_sent_at ON communications(lead_id, sent_at DESC);
CREATE INDEX idx_communications_lead_contact_type ON communications(lead_id, contact_number, type);
```

**Key Changes**:
- Embedded template object flattened
- `providerMessageIds` → JSONB array
- `metadata` → JSONB

---

### 11. Message Templates Table

**MongoDB Model**: `MessageTemplate.model.js`

**SQL Schema**:
```sql
CREATE TABLE message_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    dlt_template_id VARCHAR(255) NOT NULL,
    language VARCHAR(10) NOT NULL DEFAULT 'en',
    content TEXT NOT NULL,
    description TEXT,
    is_unicode BOOLEAN DEFAULT FALSE NOT NULL,
    variables JSONB DEFAULT '[]'::jsonb,
    variable_count INTEGER DEFAULT 0 CHECK (variable_count >= 0),
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_message_templates_dlt_template_id ON message_templates(dlt_template_id);
CREATE INDEX idx_message_templates_language_is_active ON message_templates(language, is_active);
CREATE INDEX idx_message_templates_name_language ON message_templates(name, language);
```

**Key Changes**:
- `variables` → JSONB array
- Simple mapping

---

### 12. Activity Logs Table

**MongoDB Model**: `ActivityLog.model.js`

**SQL Schema**:
```sql
CREATE TABLE activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('status_change', 'comment', 'follow_up', 'quota_change', 'joining_update')),
    old_status VARCHAR(50),
    new_status VARCHAR(50),
    comment TEXT,
    performed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_activity_logs_lead_id ON activity_logs(lead_id);
CREATE INDEX idx_activity_logs_type ON activity_logs(type);
CREATE INDEX idx_activity_logs_performed_by ON activity_logs(performed_by);
CREATE INDEX idx_activity_logs_lead_created_at ON activity_logs(lead_id, created_at DESC);
CREATE INDEX idx_activity_logs_type_created_at ON activity_logs(type, created_at DESC);
```

**Key Changes**:
- `Map` → JSONB for metadata
- Simple mapping

---

### 13. Notifications Table

**MongoDB Model**: `Notification.model.js`

**SQL Schema**:
```sql
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('lead_assignment', 'lead_created', 'call_reminder', 'status_update', 'system')),
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    data JSONB DEFAULT '{}'::jsonb,
    read BOOLEAN DEFAULT FALSE NOT NULL,
    read_at TIMESTAMP WITH TIME ZONE,
    channel_push BOOLEAN DEFAULT FALSE NOT NULL,
    channel_email BOOLEAN DEFAULT FALSE NOT NULL,
    channel_sms BOOLEAN DEFAULT FALSE NOT NULL,
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    action_url VARCHAR(500),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_type ON notifications(type);
CREATE INDEX idx_notifications_read ON notifications(read);
CREATE INDEX idx_notifications_lead_id ON notifications(lead_id);
CREATE INDEX idx_notifications_user_read ON notifications(user_id, read);
CREATE INDEX idx_notifications_user_created_at ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_user_type_read ON notifications(user_id, type, read);
```

**Key Changes**:
- `channels` object flattened to `channel_*` columns
- `data` → JSONB

---

### 14. Notification Config Table

**MongoDB Model**: `NotificationConfig.model.js`

**SQL Schema**:
```sql
CREATE TABLE notification_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(50) NOT NULL UNIQUE CHECK (type IN ('email_channel', 'sms_channel', 'push_enabled')),
    value VARCHAR(255) NOT NULL,
    description TEXT,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notification_configs_type ON notification_configs(type);
```

**Key Changes**:
- Simple key-value store
- ENUM constraint on type

---

### 15. Push Subscriptions Table

**MongoDB Model**: `PushSubscription.model.js`

**SQL Schema**:
```sql
CREATE TABLE push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint VARCHAR(500) NOT NULL UNIQUE,
    key_p256dh TEXT NOT NULL,
    key_auth TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    deactivated_at TIMESTAMP WITH TIME ZONE,
    deactivation_reason VARCHAR(255),
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_push_subscriptions_user_id ON push_subscriptions(user_id);
CREATE INDEX idx_push_subscriptions_endpoint ON push_subscriptions(endpoint);
CREATE INDEX idx_push_subscriptions_user_is_active ON push_subscriptions(user_id, is_active);
```

**Key Changes**:
- `keys` object flattened
- Simple mapping

---

### 16. Short URLs Table

**MongoDB Model**: `ShortUrl.model.js`

**SQL Schema**:
```sql
CREATE TABLE short_urls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_code VARCHAR(50) UNIQUE,
    original_url TEXT NOT NULL,
    utm_source VARCHAR(255),
    utm_medium VARCHAR(255),
    utm_campaign VARCHAR(255),
    utm_term VARCHAR(255),
    utm_content VARCHAR(255),
    click_count INTEGER DEFAULT 0 NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_short_urls_short_code ON short_urls(short_code) WHERE short_code IS NOT NULL;
CREATE INDEX idx_short_urls_is_active ON short_urls(is_active);
CREATE INDEX idx_short_urls_short_code_active ON short_urls(short_code, is_active);
```

**URL Clicks Table** (Array → Table):
```sql
CREATE TABLE short_url_clicks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_url_id UUID NOT NULL REFERENCES short_urls(id) ON DELETE CASCADE,
    clicked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(45), -- IPv6 support
    user_agent TEXT,
    referer VARCHAR(500)
);

CREATE INDEX idx_short_url_clicks_short_url_id ON short_url_clicks(short_url_id);
CREATE INDEX idx_short_url_clicks_clicked_at ON short_url_clicks(clicked_at DESC);
```

**Key Changes**:
- `clicks` array → separate table
- Better analytics capabilities

---

### 17. Import Jobs Table

**MongoDB Model**: `ImportJob.model.js`

**SQL Schema**:
```sql
CREATE TABLE import_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    upload_id VARCHAR(255) NOT NULL UNIQUE,
    original_name VARCHAR(255),
    file_path TEXT NOT NULL,
    file_size BIGINT,
    extension VARCHAR(10),
    selected_sheets JSONB DEFAULT '[]'::jsonb,
    source_label VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    upload_batch_id VARCHAR(255),
    stats_total_processed INTEGER DEFAULT 0,
    stats_total_success INTEGER DEFAULT 0,
    stats_total_errors INTEGER DEFAULT 0,
    stats_sheets_processed JSONB DEFAULT '[]'::jsonb,
    stats_duration_ms BIGINT,
    message TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    upload_token VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_import_jobs_upload_id ON import_jobs(upload_id);
CREATE INDEX idx_import_jobs_status ON import_jobs(status);
CREATE INDEX idx_import_jobs_upload_batch_id ON import_jobs(upload_batch_id);
```

**Import Job Error Details Table** (Array → Table):
```sql
CREATE TABLE import_job_error_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_job_id UUID NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
    sheet VARCHAR(255),
    row_number INTEGER,
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_import_job_error_details_import_job_id ON import_job_error_details(import_job_id);
```

**Key Changes**:
- `stats` object flattened
- `errorDetails` array → separate table

---

### 18. Delete Jobs Table

**MongoDB Model**: `DeleteJob.model.js`

**SQL Schema**:
```sql
CREATE TABLE delete_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id VARCHAR(255) NOT NULL UNIQUE,
    status VARCHAR(50) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    deleted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    stats_requested_count INTEGER DEFAULT 0,
    stats_valid_count INTEGER DEFAULT 0,
    stats_deleted_lead_count INTEGER DEFAULT 0,
    stats_deleted_log_count INTEGER DEFAULT 0,
    stats_duration_ms BIGINT,
    message TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_delete_jobs_job_id ON delete_jobs(job_id);
CREATE INDEX idx_delete_jobs_status ON delete_jobs(status);
```

**Delete Job Lead IDs Table** (Array → Table):
```sql
CREATE TABLE delete_job_lead_ids (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delete_job_id UUID NOT NULL REFERENCES delete_jobs(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_delete_job_lead_ids_delete_job_id ON delete_job_lead_ids(delete_job_id);
CREATE INDEX idx_delete_job_lead_ids_lead_id ON delete_job_lead_ids(lead_id);
```

**Delete Job Error Details Table** (Array → Table):
```sql
CREATE TABLE delete_job_error_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delete_job_id UUID NOT NULL REFERENCES delete_jobs(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_delete_job_error_details_delete_job_id ON delete_job_error_details(delete_job_id);
```

**Key Changes**:
- `leadIds` array → separate table
- `errorDetails` array → separate table
- `stats` object flattened

---

### 19. Admission Sequence Table

**MongoDB Model**: `AdmissionSequence.model.js`

**SQL Schema**:
```sql
CREATE TABLE admission_sequences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    year INTEGER NOT NULL UNIQUE,
    last_sequence INTEGER DEFAULT 0 NOT NULL CHECK (last_sequence >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_admission_sequences_year ON admission_sequences(year);
```

**Key Changes**:
- Simple mapping
- Used for generating sequential admission numbers

---

## Relationship Mappings

### Entity Relationship Diagram Summary

```
users (self-referencing)
  ├── managed_by → users.id
  └── (referenced by many tables)

leads
  ├── assigned_to → users.id
  ├── assigned_by → users.id
  ├── uploaded_by → users.id
  └── (referenced by joinings, admissions, communications, activity_logs, notifications)

joinings
  ├── lead_id → leads.id
  ├── course_id → courses.id
  ├── branch_id → branches.id
  ├── submitted_by → users.id
  ├── approved_by → users.id
  └── (referenced by admissions, payment_transactions)

admissions
  ├── lead_id → leads.id
  ├── joining_id → joinings.id (UNIQUE)
  ├── course_id → courses.id
  ├── branch_id → branches.id
  └── (referenced by payment_transactions)

courses
  └── (referenced by branches, joinings, admissions, payment_configs, payment_transactions)

branches
  ├── course_id → courses.id
  └── (referenced by joinings, admissions, payment_configs, payment_transactions)
```

### Foreign Key Constraints

**Cascade Rules**:
- `ON DELETE CASCADE`: Child records deleted when parent deleted
  - `lead_status_logs` → `leads`
  - `joining_relatives`, `joining_education_history`, `joining_siblings` → `joinings`
  - `communications`, `activity_logs` → `leads`
  - `short_url_clicks` → `short_urls`
  - `payment_transactions` → `joinings` (when joining deleted)

- `ON DELETE SET NULL`: Foreign key set to NULL when parent deleted
  - `leads.assigned_to` → `users`
  - `joinings.lead_id` → `leads` (optional relationship)

- `ON DELETE RESTRICT`: Prevent deletion if child exists
  - `admissions.joining_id` → `joinings` (admission requires joining)
  - `communications.sent_by` → `users`

---

## Index Strategy

### Index Types Used

1. **B-Tree Indexes**: Standard indexes for equality and range queries (default in MySQL)
2. **Full-Text Indexes**: For text search (FULLTEXT index type)
3. **Functional Indexes**: MySQL 8.0+ supports indexes on expressions
4. **Composite Indexes**: Multiple columns for common query patterns
5. **Unique Indexes**: For unique constraints

**MySQL-Specific Notes**:
- InnoDB engine (default) uses B-tree indexes
- Full-text indexes require `FULLTEXT` keyword
- JSON columns can be indexed using generated columns
- Indexes on JSON columns use virtual generated columns

### Critical Indexes

**Performance-Critical Queries**:
- Lead filtering: `(district, mandal)`, `(lead_status, assigned_to)`
- Lead search: Full-text search index
- Pagination: `(created_at DESC)` on all major tables
- User lookups: `email`, `role_name`, `is_active`
- Payment queries: `(lead_id, created_at DESC)`, `(admission_id, created_at DESC)`

### Index Maintenance

- Monitor index usage with `pg_stat_user_indexes`
- Consider `REINDEX` for heavily fragmented indexes
- Use `EXPLAIN ANALYZE` to verify index usage

---

## Data Type Conversions

### MongoDB → MySQL Mapping

| MongoDB Type | MySQL Type | Notes |
|-------------|-----------|-------|
| `ObjectId` | `CHAR(36)` | Store UUID as string (application-generated) |
| `String` | `VARCHAR(n)` or `TEXT` | Use VARCHAR for known max length, TEXT for large |
| `Number` | `INT` or `BIGINT` | Use BIGINT for large numbers |
| `Number` (money) | `DECIMAL(12, 2)` | For currency amounts |
| `Boolean` | `BOOLEAN` or `TINYINT(1)` | MySQL uses TINYINT(1) for boolean |
| `Date` | `DATETIME` or `TIMESTAMP` | DATETIME for application timestamps |
| `Mixed` / `Object` | `JSON` | MySQL 5.7+ supports JSON type |
| `Array` | `JSON` or separate table | Prefer table for queryability, JSON for simple arrays |
| `Map` | `JSON` | Direct conversion to JSON |

### Special Considerations

**Encrypted Fields**:
- Store as `TEXT` (encrypted values are base64 strings)
- Decryption handled at application level
- No database-level encryption (application handles it)

**Enum Fields**:
- Use `CHECK` constraints: `CHECK (status IN ('draft', 'pending_approval', 'approved'))`
- MySQL 8.0+ supports CHECK constraints
- Alternative: Use `ENUM` type for frequently used enums

**Sparse Fields**:
- MySQL 8.0+ supports functional indexes with WHERE clause
- Allow `NULL` values in columns
- Use regular indexes (MySQL will handle NULLs efficiently)

**UUID Generation**:
- Application generates UUID using `uuid` package
- Store as `CHAR(36)` in MySQL
- No auto-increment for UUIDs

**JSON Fields**:
- MySQL 5.7+ supports native JSON type
- Use `JSON_EXTRACT()` or `->` operator for queries
- Index JSON columns using generated columns if needed

---

## Encryption Handling

### Current Encryption Implementation

**Encryption Utility**: `encryption.util.js`
- Algorithm: AES-256-GCM
- Format: `{iv}:{authTag}:{encryptedData}` (base64)
- Key: `JOINING_ENCRYPTION_KEY` environment variable

### Encrypted Fields in SQL

**Fields Requiring Encryption**:
1. `joinings.student_aadhaar_number`
2. `joinings.father_aadhaar_number`
3. `joinings.mother_aadhaar_number`
4. `admissions.student_aadhaar_number`
5. `admissions.father_aadhaar_number`
6. `admissions.mother_aadhaar_number`
7. `payment_gateway_configs.client_id`
8. `payment_gateway_configs.client_secret`

### Migration Strategy for Encryption

1. **During Migration**:
   - Read encrypted values from MongoDB (already encrypted)
   - Store directly in PostgreSQL `TEXT` columns
   - No re-encryption needed (same key)

2. **Application Layer**:
   - Maintain existing encryption utility
   - Use getters/setters or middleware for decryption
   - Consider using ORM hooks (Sequelize/TypeORM) for automatic decryption

3. **Query Considerations**:
   - Encrypted fields cannot be searched/indexed effectively
   - Use application-level search if needed
   - Consider hashing for searchable sensitive data (e.g., phone numbers)

---

## Endpoint Changes Required

### Controller-Level Changes

All controllers using Mongoose models need refactoring:

#### 1. **Database Connection** (`config/database.js`)
```javascript
// OLD: Mongoose
import mongoose from 'mongoose';
await mongoose.connect(MONGODB_URI);

// NEW: SQL (using Sequelize example)
import { Sequelize } from 'sequelize';
const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
  host: DB_HOST,
  dialect: 'postgres',
  logging: false,
});
```

#### 2. **Model Queries**

**Example: Lead Controller**

```javascript
// OLD: Mongoose
const leads = await Lead.find(filter)
  .populate('assignedTo', 'name email')
  .sort({ createdAt: -1 })
  .skip(skip)
  .limit(limit);

// NEW: Sequelize
const leads = await Lead.findAll({
  where: filter,
  include: [{
    model: User,
    as: 'assignedTo',
    attributes: ['name', 'email']
  }],
  order: [['created_at', 'DESC']],
  offset: skip,
  limit: limit
});
```

#### 3. **Key Query Patterns**

**Pagination**:
```javascript
// OLD
const skip = (page - 1) * limit;
const leads = await Lead.find().skip(skip).limit(limit);

// NEW
const leads = await Lead.findAll({
  offset: (page - 1) * limit,
  limit: limit
});
```

**Populate/Joins**:
```javascript
// OLD
.populate('assignedTo', 'name email')

// NEW
include: [{
  model: User,
  as: 'assignedTo',
  attributes: ['name', 'email']
}]
```

**Text Search**:
```javascript
// OLD
Lead.find({ $text: { $search: searchTerm } })

// NEW (PostgreSQL)
Lead.findAll({
  where: sequelize.literal(
    `to_tsvector('english', name || ' ' || phone || ' ' || email) @@ plainto_tsquery('english', :search)`
  ),
  replacements: { search: searchTerm }
})
```

**Aggregations**:
```javascript
// OLD
Lead.aggregate([
  { $match: filter },
  { $group: { _id: '$leadStatus', count: { $sum: 1 } } }
])

// NEW
Lead.findAll({
  attributes: [
    'lead_status',
    [sequelize.fn('COUNT', sequelize.col('id')), 'count']
  ],
  where: filter,
  group: ['lead_status']
})
```

**Array Operations**:
```javascript
// OLD: Embedded arrays
joining.statusLogs.push(newLog);
await joining.save();

// NEW: Separate table
await JoiningStatusLog.create({
  joining_id: joining.id,
  ...newLog
});
```

**Transactions**:
```javascript
// OLD: Mongoose
const session = await mongoose.startSession();
session.startTransaction();
try {
  await lead.save({ session });
  await activityLog.save({ session });
  await session.commitTransaction();
} catch (error) {
  await session.abortTransaction();
}

// NEW: Sequelize
const transaction = await sequelize.transaction();
try {
  await lead.save({ transaction });
  await activityLog.save({ transaction });
  await transaction.commit();
} catch (error) {
  await transaction.rollback();
}
```

### Route Changes

**Minimal Changes Required**:
- Routes remain the same (URLs unchanged)
- Request/response formats unchanged
- Only controller implementations change

### Service Changes

**External Services**: No changes required
- Email services (Brevo, Nodemailer)
- SMS services (BulkSMS)
- Payment gateway (Cashfree)
- Push notifications

**Internal Services**: May need updates
- `notification.service.js`: Update database queries
- `urlShortener.service.js`: Update database queries

---

## Migration Strategy

### Phase 1: Model Migration (Week 1-2)

1. **Database Setup**
   - Configure Amazon RDS MySQL connection
   - Set up connection pooling (mysql2)
   - Test connection

2. **Schema Creation**
   - Create all tables using SQL scripts
   - Set up indexes
   - Configure foreign keys
   - Test schema with sample data

3. **Model Creation**
   - Create SQL models in `src/models-sql/`
   - Implement CRUD operations
   - Handle encryption/decryption
   - Test each model

4. **Scripts Migration**
   - Update scripts for SQL (in `src/scripts-sql/`)
   - Test seed scripts
   - Verify all scripts work

### Phase 2: Controller Migration (Week 3-4)

1. **Create SQL Controllers**
   - Create controllers in `src/controllers-sql/`
   - Implement all CRUD operations
   - Maintain API response format
   - Handle relationships and joins

2. **Priority Order**:
   - Auth controller (login, getMe)
   - User controller
   - Lead controller (most complex)
   - Joining controller
   - Admission controller
   - Payment controller
   - Communication controller
   - Notification controller
   - Other controllers

### Phase 3: Route Integration (Week 5)

1. **Update Routes**
   - Conditionally use SQL controllers
   - Add feature flag for SQL/MongoDB switch
   - Maintain backward compatibility
   - Test all endpoints

2. **Testing**
   - Integration tests for all endpoints
   - API compatibility verification
   - Performance benchmarking

### Phase 4: Testing & Validation (Week 6)

1. **Functional Testing**
   - All endpoints tested
   - All workflows tested
   - Edge cases covered

2. **Performance Testing**
   - Query performance benchmarks
   - Load testing
   - Index optimization

3. **Data Validation**
   - Verify all models work correctly
   - Test relationships
   - Test encryption/decryption
   - Validate business logic

### Phase 5: Deployment (Week 7-8)

1. **Staging Deployment**
   - Deploy to staging environment
   - Run full test suite
   - User acceptance testing

2. **Production Deployment**
   - Backup MongoDB
   - Deploy new code
   - Run data migration
   - Switch traffic
   - Monitor for issues

3. **Rollback Plan**
   - Keep MongoDB running initially
   - Ability to switch back if needed
   - Data sync if required

### Migration Scripts

**Note**: No data migration scripts needed. Starting fresh with SQL database.

**Example: Model Usage**

```javascript
// Using SQL User model
import User from '../models-sql/User.model.js';

// Find user by email
const user = await User.findByEmail('admin@leadtracker.com');

// Create new user
const newUser = await User.create({
  name: 'John Doe',
  email: 'john@example.com',
  password: 'password123',
  roleName: 'User',
  isActive: true
});

// Update user
user.name = 'Jane Doe';
await user.save();

// Delete user
await user.delete();
```

---

## Testing Checklist

### Unit Tests

- [ ] All model CRUD operations
- [ ] Relationship queries (joins/populates)
- [ ] Encryption/decryption
- [ ] Validation rules
- [ ] Index usage verification

### Integration Tests

- [ ] Lead creation workflow
- [ ] Joining submission workflow
- [ ] Admission creation workflow
- [ ] Payment processing workflow
- [ ] Communication logging
- [ ] Notification system
- [ ] Bulk operations (upload, delete)

### API Tests

- [ ] All GET endpoints
- [ ] All POST endpoints
- [ ] All PUT endpoints
- [ ] All DELETE endpoints
- [ ] Authentication/authorization
- [ ] Error handling
- [ ] Pagination
- [ ] Filtering
- [ ] Search functionality

### Performance Tests

- [ ] Query response times
- [ ] Bulk operation performance
- [ ] Concurrent request handling
- [ ] Database connection pooling
- [ ] Index effectiveness

### Data Integrity Tests

- [ ] Foreign key constraints
- [ ] Unique constraints
- [ ] Check constraints
- [ ] Data type validation
- [ ] Encryption/decryption accuracy
- [ ] Relationship integrity

### Security Tests

- [ ] SQL injection prevention
- [ ] Authentication tokens
- [ ] Authorization checks
- [ ] Encrypted field handling
- [ ] Input validation
- [ ] XSS prevention

---

## Rollback Plan

### Immediate Rollback (< 1 hour)

1. **Code Rollback**
   - Revert to previous MongoDB version
   - Restore environment variables
   - Restart services

2. **Database Rollback**
   - MongoDB still contains original data
   - No data loss

### Partial Rollback (1-24 hours)

1. **Dual Write Period**
   - Write to both MongoDB and PostgreSQL
   - Read from MongoDB
   - Allows gradual migration

2. **Data Sync**
   - Sync any new data from PostgreSQL to MongoDB
   - Verify data consistency

### Complete Rollback (> 24 hours)

1. **Data Restoration**
   - Export data from PostgreSQL
   - Import back to MongoDB
   - Verify data integrity

2. **Code Restoration**
   - Full revert to MongoDB codebase
   - Restore backups if needed

### Prevention Measures

1. **Backup Strategy**
   - Full MongoDB backup before migration
   - PostgreSQL backup after migration
   - Regular backups during transition

2. **Monitoring**
   - Real-time error monitoring
   - Performance metrics
   - Data integrity checks
   - User feedback collection

3. **Feature Flags**
   - Ability to switch database via config
   - Gradual rollout (percentage of traffic)
   - A/B testing capability

---

## Additional Considerations

### ORM Selection Guide

**Raw mysql2** (Selected)
- Pros: Direct SQL control, lightweight, no abstraction overhead
- Cons: More manual work, need to write SQL queries
- Best for: Full control, performance-critical applications

**Sequelize** (Alternative)
- Pros: Mature, good MySQL support, ORM features
- Cons: Additional abstraction layer, learning curve
- Best for: Complex relationships, rapid development

**TypeORM** (Alternative)
- Pros: TypeScript-first, decorator-based
- Cons: Steeper learning curve, more opinionated
- Best for: TypeScript projects, modern stack

**Note**: We're using raw mysql2 with connection pooling for direct control and performance.

### Performance Optimization

1. **Connection Pooling**
   - Configure appropriate pool size
   - Monitor connection usage
   - Use read replicas for read-heavy workloads

2. **Query Optimization**
   - Use `EXPLAIN ANALYZE` for slow queries
   - Optimize N+1 queries
   - Use eager loading appropriately
   - Consider materialized views for complex reports

3. **Caching Strategy**
   - Redis for frequently accessed data
   - Cache user sessions
   - Cache filter options
   - Cache course/branch lookups

### Monitoring & Maintenance

1. **Database Monitoring**
   - Query performance
   - Connection pool usage
   - Index usage statistics
   - Table sizes and growth

2. **Application Monitoring**
   - API response times
   - Error rates
   - Database query times
   - Transaction success rates

3. **Maintenance Tasks**
   - Regular `VACUUM` and `ANALYZE` (PostgreSQL)
   - Index maintenance
   - Backup verification
   - Log rotation

---

## Conclusion

This migration from MongoDB to SQL (PostgreSQL) is a significant undertaking that requires careful planning and execution. The key to success is:

1. **Thorough Testing**: Test each component thoroughly before moving to the next
2. **Incremental Migration**: Migrate in phases, not all at once
3. **Data Integrity**: Verify data at every step
4. **Rollback Plan**: Always have a way to revert
5. **Monitoring**: Watch everything closely during and after migration

### Estimated Timeline: 7-8 weeks

### Team Requirements:
- 1-2 Backend developers
- 1 Database administrator (part-time, for RDS setup)
- 1 QA engineer (part-time)

### Success Criteria:
- ✅ All models created and tested
- ✅ All controllers migrated and tested
- ✅ All endpoints functioning correctly
- ✅ Performance equal or better than MongoDB
- ✅ All tests passing
- ✅ Production deployment successful
- ✅ No data migration needed (fresh start)

---

**Document Version**: 1.0  
**Last Updated**: 2026-01-23  
**Author**: Migration Planning Team  
**Status**: Draft - Ready for Review
