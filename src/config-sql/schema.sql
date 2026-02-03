-- MySQL Schema for Admissions Application
-- Amazon RDS MySQL 8.0+
-- Database: admissions_db
-- Charset: utf8mb4
-- Collation: utf8mb4_unicode_ci

-- ============================================
-- 1. USERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role_name VARCHAR(50) NOT NULL CHECK (role_name IN ('Super Admin', 'Sub Super Admin', 'User', 'Student Counselor', 'Data Entry User')),
    managed_by CHAR(36) NULL,
    is_manager BOOLEAN DEFAULT FALSE NOT NULL,
    designation VARCHAR(100),
    permissions JSON DEFAULT (JSON_OBJECT()),
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (managed_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_users_email (email),
    INDEX idx_users_role_name (role_name),
    INDEX idx_users_is_active (is_active),
    INDEX idx_users_managed_by (managed_by),
    INDEX idx_users_is_manager (is_manager)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 2. ROLES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS roles (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    permissions JSON DEFAULT (JSON_ARRAY()),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_roles_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 3. LEADS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS leads (
    id CHAR(36) PRIMARY KEY,
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
    `rank` INT CHECK (`rank` >= 0),
    inter_college VARCHAR(255) DEFAULT '',
    quota VARCHAR(100) DEFAULT 'Not Applicable',
    application_status VARCHAR(100) DEFAULT 'Not Provided',
    dynamic_fields JSON DEFAULT (JSON_OBJECT()),
    lead_status VARCHAR(50) DEFAULT 'New',
    admission_number VARCHAR(100) UNIQUE,
    assigned_to CHAR(36) NULL,
    assigned_at DATETIME,
    assigned_by CHAR(36) NULL,
    source VARCHAR(255),
    utm_source VARCHAR(255),
    utm_medium VARCHAR(255),
    utm_campaign VARCHAR(255),
    utm_term VARCHAR(255),
    utm_content VARCHAR(255),
    last_follow_up DATETIME,
    next_scheduled_call DATETIME,
    notes TEXT,
    uploaded_by CHAR(36) NULL,
    upload_batch_id VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_leads_enquiry_number (enquiry_number),
    INDEX idx_leads_name (name),
    INDEX idx_leads_phone (phone),
    INDEX idx_leads_district (district),
    INDEX idx_leads_mandal (mandal),
    INDEX idx_leads_state (state),
    INDEX idx_leads_quota (quota),
    INDEX idx_leads_lead_status (lead_status),
    INDEX idx_leads_assigned_to (assigned_to),
    INDEX idx_leads_assigned_at (assigned_at),
    INDEX idx_leads_upload_batch_id (upload_batch_id),
    INDEX idx_leads_created_at (created_at DESC),
    INDEX idx_leads_next_scheduled_call (next_scheduled_call),
    INDEX idx_leads_hall_ticket_number (hall_ticket_number),
    INDEX idx_leads_rank (`rank`),
    INDEX idx_leads_district_mandal (district, mandal),
    INDEX idx_leads_mandal_state (mandal, state),
    INDEX idx_leads_status_assigned (lead_status, assigned_to),
    INDEX idx_leads_phone_name (phone, name),
    FULLTEXT INDEX idx_leads_fulltext (enquiry_number, name, phone, email, father_name, mother_name, course_interested, district, mandal, state, application_status, hall_ticket_number, inter_college)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 4. LEAD STATUS LOGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS lead_status_logs (
    id CHAR(36) PRIMARY KEY,
    lead_id CHAR(36) NOT NULL,
    status VARCHAR(50),
    comment TEXT,
    changed_by CHAR(36) NULL,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_lead_status_logs_lead_id (lead_id),
    INDEX idx_lead_status_logs_changed_at (changed_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 4. COURSES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS courses (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    code VARCHAR(100) UNIQUE,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_by CHAR(36) NULL,
    updated_by CHAR(36) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_courses_name (name),
    INDEX idx_courses_code (code),
    INDEX idx_courses_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 5. BRANCHES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS branches (
    id CHAR(36) PRIMARY KEY,
    course_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(100),
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_by CHAR(36) NULL,
    updated_by CHAR(36) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE KEY uk_branches_course_name (course_id, name),
    UNIQUE KEY uk_branches_course_code (course_id, code),
    INDEX idx_branches_course_id (course_id),
    INDEX idx_branches_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 6. JOININGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS joinings (
    id CHAR(36) PRIMARY KEY,
    lead_id CHAR(36) NULL,
    lead_data JSON DEFAULT (JSON_OBJECT()),
    status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved')),
    course_id CHAR(36) NULL,
    branch_id CHAR(36) NULL,
    course VARCHAR(255) DEFAULT '',
    branch VARCHAR(255) DEFAULT '',
    quota VARCHAR(100) DEFAULT '',
    payment_total_fee DECIMAL(12, 2) DEFAULT 0 CHECK (payment_total_fee >= 0),
    payment_total_paid DECIMAL(12, 2) DEFAULT 0 CHECK (payment_total_paid >= 0),
    payment_balance DECIMAL(12, 2) DEFAULT 0 CHECK (payment_balance >= 0),
    payment_currency VARCHAR(10) DEFAULT 'INR',
    payment_status VARCHAR(50) DEFAULT 'not_started' CHECK (payment_status IN ('not_started', 'partial', 'paid')),
    payment_last_payment_at DATETIME,
    student_name VARCHAR(255) DEFAULT '',
    student_aadhaar_number TEXT,
    student_phone VARCHAR(20) DEFAULT '',
    student_gender VARCHAR(50) DEFAULT '',
    student_date_of_birth VARCHAR(20) DEFAULT '',
    student_notes TEXT,
    father_name VARCHAR(255) DEFAULT '',
    father_phone VARCHAR(20) DEFAULT '',
    father_aadhaar_number TEXT,
    mother_name VARCHAR(255) DEFAULT '',
    mother_phone VARCHAR(20) DEFAULT '',
    mother_aadhaar_number TEXT,
    reservation_general VARCHAR(20) NOT NULL CHECK (reservation_general IN ('oc', 'ews', 'bc-a', 'bc-b', 'bc-c', 'bc-d', 'bc-e', 'sc', 'st')),
    reservation_other JSON DEFAULT (JSON_ARRAY()),
    address_door_street VARCHAR(255) DEFAULT '',
    address_landmark VARCHAR(255) DEFAULT '',
    address_village_city VARCHAR(255) DEFAULT '',
    address_mandal VARCHAR(255) DEFAULT '',
    address_district VARCHAR(255) DEFAULT '',
    address_pin_code VARCHAR(10) DEFAULT '',
    qualification_ssc BOOLEAN DEFAULT FALSE,
    qualification_inter_diploma BOOLEAN DEFAULT FALSE,
    qualification_ug BOOLEAN DEFAULT FALSE,
    qualification_mediums JSON DEFAULT (JSON_ARRAY()),
    qualification_other_medium_label VARCHAR(255) DEFAULT '',
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
    draft_updated_at DATETIME,
    submitted_at DATETIME,
    submitted_by CHAR(36) NULL,
    approved_at DATETIME,
    approved_by CHAR(36) NULL,
    created_by CHAR(36) NULL,
    updated_by CHAR(36) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
    FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_joinings_lead_id (lead_id),
    INDEX idx_joinings_status (status),
    INDEX idx_joinings_course_id (course_id),
    INDEX idx_joinings_branch_id (branch_id),
    INDEX idx_joinings_status_updated_at (status, updated_at DESC),
    INDEX idx_joinings_submitted_at (submitted_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 7. JOINING RELATIVES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS joining_relatives (
    id CHAR(36) PRIMARY KEY,
    joining_id CHAR(36) NOT NULL,
    name VARCHAR(255) DEFAULT '',
    relationship VARCHAR(100) DEFAULT '',
    door_street VARCHAR(255) DEFAULT '',
    landmark VARCHAR(255) DEFAULT '',
    village_city VARCHAR(255) DEFAULT '',
    mandal VARCHAR(255) DEFAULT '',
    district VARCHAR(255) DEFAULT '',
    pin_code VARCHAR(10) DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (joining_id) REFERENCES joinings(id) ON DELETE CASCADE,
    INDEX idx_joining_relatives_joining_id (joining_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 8. JOINING EDUCATION HISTORY TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS joining_education_history (
    id CHAR(36) PRIMARY KEY,
    joining_id CHAR(36) NOT NULL,
    level VARCHAR(50) NOT NULL CHECK (level IN ('ssc', 'inter_diploma', 'ug', 'other')),
    other_level_label VARCHAR(255) DEFAULT '',
    course_or_branch VARCHAR(255) DEFAULT '',
    year_of_passing VARCHAR(20) DEFAULT '',
    institution_name VARCHAR(255) DEFAULT '',
    institution_address TEXT,
    hall_ticket_number VARCHAR(100) DEFAULT '',
    total_marks_or_grade VARCHAR(50) DEFAULT '',
    cet_rank VARCHAR(50) DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (joining_id) REFERENCES joinings(id) ON DELETE CASCADE,
    INDEX idx_joining_education_history_joining_id (joining_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 9. JOINING SIBLINGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS joining_siblings (
    id CHAR(36) PRIMARY KEY,
    joining_id CHAR(36) NOT NULL,
    name VARCHAR(255) DEFAULT '',
    relation VARCHAR(100) DEFAULT '',
    studying_standard VARCHAR(100) DEFAULT '',
    institution_name VARCHAR(255) DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (joining_id) REFERENCES joinings(id) ON DELETE CASCADE,
    INDEX idx_joining_siblings_joining_id (joining_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 10. ADMISSIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS admissions (
    id CHAR(36) PRIMARY KEY,
    lead_id CHAR(36) NULL,
    enquiry_number VARCHAR(50),
    lead_data JSON DEFAULT (JSON_OBJECT()),
    joining_id CHAR(36) NOT NULL UNIQUE,
    admission_number VARCHAR(100) NOT NULL UNIQUE,
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
    admission_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    course_id CHAR(36) NULL,
    branch_id CHAR(36) NULL,
    course VARCHAR(255) DEFAULT '',
    branch VARCHAR(255) DEFAULT '',
    quota VARCHAR(100) DEFAULT '',
    payment_total_fee DECIMAL(12, 2) DEFAULT 0 CHECK (payment_total_fee >= 0),
    payment_total_paid DECIMAL(12, 2) DEFAULT 0 CHECK (payment_total_paid >= 0),
    payment_balance DECIMAL(12, 2) DEFAULT 0 CHECK (payment_balance >= 0),
    payment_currency VARCHAR(10) DEFAULT 'INR',
    payment_status VARCHAR(50) DEFAULT 'not_started' CHECK (payment_status IN ('not_started', 'partial', 'paid')),
    payment_last_payment_at DATETIME,
    student_name VARCHAR(255) NOT NULL,
    student_aadhaar_number TEXT,
    student_phone VARCHAR(20) DEFAULT '',
    student_gender VARCHAR(50) DEFAULT '',
    student_date_of_birth VARCHAR(20) DEFAULT '',
    student_notes TEXT,
    father_name VARCHAR(255) DEFAULT '',
    father_phone VARCHAR(20) DEFAULT '',
    father_aadhaar_number TEXT,
    mother_name VARCHAR(255) DEFAULT '',
    mother_phone VARCHAR(20) DEFAULT '',
    mother_aadhaar_number TEXT,
    reservation_general VARCHAR(20) NOT NULL CHECK (reservation_general IN ('oc', 'ews', 'bc-a', 'bc-b', 'bc-c', 'bc-d', 'bc-e', 'sc', 'st')),
    reservation_other JSON DEFAULT (JSON_ARRAY()),
    address_door_street VARCHAR(255) DEFAULT '',
    address_landmark VARCHAR(255) DEFAULT '',
    address_village_city VARCHAR(255) DEFAULT '',
    address_mandal VARCHAR(255) DEFAULT '',
    address_district VARCHAR(255) DEFAULT '',
    address_pin_code VARCHAR(10) DEFAULT '',
    qualification_ssc BOOLEAN DEFAULT FALSE,
    qualification_inter_diploma BOOLEAN DEFAULT FALSE,
    qualification_ug BOOLEAN DEFAULT FALSE,
    qualification_mediums JSON DEFAULT (JSON_ARRAY()),
    qualification_other_medium_label VARCHAR(255) DEFAULT '',
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
    created_by CHAR(36) NULL,
    updated_by CHAR(36) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
    FOREIGN KEY (joining_id) REFERENCES joinings(id) ON DELETE RESTRICT,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_admissions_lead_id (lead_id),
    INDEX idx_admissions_joining_id (joining_id),
    INDEX idx_admissions_admission_number (admission_number),
    INDEX idx_admissions_status (status),
    INDEX idx_admissions_course_id (course_id),
    INDEX idx_admissions_branch_id (branch_id),
    INDEX idx_admissions_lead_admission_number (lead_id, admission_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 11. ADMISSION RELATIVES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS admission_relatives (
    id CHAR(36) PRIMARY KEY,
    admission_id CHAR(36) NOT NULL,
    name VARCHAR(255) DEFAULT '',
    relationship VARCHAR(100) DEFAULT '',
    door_street VARCHAR(255) DEFAULT '',
    landmark VARCHAR(255) DEFAULT '',
    village_city VARCHAR(255) DEFAULT '',
    mandal VARCHAR(255) DEFAULT '',
    district VARCHAR(255) DEFAULT '',
    pin_code VARCHAR(10) DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE CASCADE,
    INDEX idx_admission_relatives_admission_id (admission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 12. ADMISSION EDUCATION HISTORY TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS admission_education_history (
    id CHAR(36) PRIMARY KEY,
    admission_id CHAR(36) NOT NULL,
    level VARCHAR(50) NOT NULL CHECK (level IN ('ssc', 'inter_diploma', 'ug', 'other')),
    other_level_label VARCHAR(255) DEFAULT '',
    course_or_branch VARCHAR(255) DEFAULT '',
    year_of_passing VARCHAR(20) DEFAULT '',
    institution_name VARCHAR(255) DEFAULT '',
    institution_address TEXT,
    hall_ticket_number VARCHAR(100) DEFAULT '',
    total_marks_or_grade VARCHAR(50) DEFAULT '',
    cet_rank VARCHAR(50) DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE CASCADE,
    INDEX idx_admission_education_history_admission_id (admission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 13. ADMISSION SIBLINGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS admission_siblings (
    id CHAR(36) PRIMARY KEY,
    admission_id CHAR(36) NOT NULL,
    name VARCHAR(255) DEFAULT '',
    relation VARCHAR(100) DEFAULT '',
    studying_standard VARCHAR(100) DEFAULT '',
    institution_name VARCHAR(255) DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE CASCADE,
    INDEX idx_admission_siblings_admission_id (admission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 14. PAYMENT TRANSACTIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS payment_transactions (
    id CHAR(36) PRIMARY KEY,
    admission_id CHAR(36) NULL,
    joining_id CHAR(36) NOT NULL,
    lead_id CHAR(36) NULL,
    course_id CHAR(36) NULL,
    branch_id CHAR(36) NULL,
    amount DECIMAL(12, 2) NOT NULL CHECK (amount >= 0),
    currency VARCHAR(10) DEFAULT 'INR' NOT NULL,
    mode VARCHAR(20) NOT NULL CHECK (mode IN ('cash', 'online', 'upi_qr')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
    collected_by CHAR(36) NULL,
    cashfree_order_id VARCHAR(255),
    cashfree_payment_session_id VARCHAR(255),
    reference_id VARCHAR(255),
    notes TEXT,
    is_additional_fee BOOLEAN DEFAULT FALSE NOT NULL,
    meta JSON DEFAULT (JSON_OBJECT()),
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    verified_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE SET NULL,
    FOREIGN KEY (joining_id) REFERENCES joinings(id) ON DELETE CASCADE,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
    FOREIGN KEY (collected_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_payment_transactions_joining_id (joining_id),
    INDEX idx_payment_transactions_lead_id (lead_id),
    INDEX idx_payment_transactions_admission_id (admission_id),
    INDEX idx_payment_transactions_mode (mode),
    INDEX idx_payment_transactions_status (status),
    INDEX idx_payment_transactions_cashfree_order_id (cashfree_order_id),
    INDEX idx_payment_transactions_reference_id (reference_id),
    INDEX idx_payment_transactions_is_additional_fee (is_additional_fee),
    INDEX idx_payment_transactions_lead_created (lead_id, created_at DESC),
    INDEX idx_payment_transactions_admission_created (admission_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 15. PAYMENT CONFIGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS payment_configs (
    id CHAR(36) PRIMARY KEY,
    course_id CHAR(36) NOT NULL,
    branch_id CHAR(36) NULL,
    amount DECIMAL(12, 2) NOT NULL CHECK (amount >= 0),
    currency VARCHAR(10) DEFAULT 'INR' NOT NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    notes TEXT,
    created_by CHAR(36) NULL,
    updated_by CHAR(36) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    -- Note: Foreign keys for course_id and branch_id are removed because courses/branches
    -- are now stored in the secondary database. course_id and branch_id store string
    -- representations of int IDs from the secondary database.
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_payment_configs_course_id (course_id),
    INDEX idx_payment_configs_branch_id (branch_id),
    INDEX idx_payment_configs_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 16. PAYMENT GATEWAY CONFIGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS payment_gateway_configs (
    id CHAR(36) PRIMARY KEY,
    provider VARCHAR(50) NOT NULL UNIQUE CHECK (provider IN ('cashfree')),
    display_name VARCHAR(255) DEFAULT 'Cashfree',
    client_id TEXT NOT NULL,
    client_secret TEXT NOT NULL,
    environment VARCHAR(20) DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'production')),
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    updated_by CHAR(36) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_payment_gateway_configs_provider (provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 17. COMMUNICATIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS communications (
    id CHAR(36) PRIMARY KEY,
    lead_id CHAR(36) NOT NULL,
    contact_number VARCHAR(20) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('call', 'sms')),
    direction VARCHAR(20) DEFAULT 'outgoing' CHECK (direction IN ('outgoing', 'incoming')),
    status VARCHAR(20) DEFAULT 'success' CHECK (status IN ('pending', 'success', 'failed')),
    remarks TEXT,
    call_outcome VARCHAR(255),
    duration_seconds INT CHECK (duration_seconds >= 0),
    template_id CHAR(36) NULL,
    template_dlt_template_id VARCHAR(255),
    template_name VARCHAR(255),
    template_language VARCHAR(10),
    template_original_content TEXT,
    template_rendered_content TEXT,
    template_variables JSON DEFAULT (JSON_ARRAY()),
    provider_message_ids JSON DEFAULT (JSON_ARRAY()),
    metadata JSON DEFAULT (JSON_OBJECT()),
    sent_by CHAR(36) NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY (template_id) REFERENCES message_templates(id) ON DELETE SET NULL,
    FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_communications_lead_id (lead_id),
    INDEX idx_communications_contact_number (contact_number),
    INDEX idx_communications_type (type),
    INDEX idx_communications_status (status),
    INDEX idx_communications_sent_by (sent_by),
    INDEX idx_communications_sent_at (sent_at DESC),
    INDEX idx_communications_lead_sent_at (lead_id, sent_at DESC),
    INDEX idx_communications_lead_contact_type (lead_id, contact_number, type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 18. MESSAGE TEMPLATES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS message_templates (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    dlt_template_id VARCHAR(255) NOT NULL,
    language VARCHAR(10) NOT NULL DEFAULT 'en',
    content TEXT NOT NULL,
    description TEXT,
    is_unicode BOOLEAN DEFAULT FALSE NOT NULL,
    variables JSON DEFAULT (JSON_ARRAY()),
    variable_count INT DEFAULT 0 CHECK (variable_count >= 0),
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_by CHAR(36) NULL,
    updated_by CHAR(36) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_message_templates_dlt_template_id (dlt_template_id),
    INDEX idx_message_templates_language_is_active (language, is_active),
    INDEX idx_message_templates_name_language (name, language)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 19. ACTIVITY LOGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS activity_logs (
    id CHAR(36) PRIMARY KEY,
    lead_id CHAR(36) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('status_change', 'comment', 'follow_up', 'quota_change', 'joining_update')),
    old_status VARCHAR(50),
    new_status VARCHAR(50),
    comment TEXT,
    performed_by CHAR(36) NOT NULL,
    metadata JSON DEFAULT (JSON_OBJECT()),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_activity_logs_lead_id (lead_id),
    INDEX idx_activity_logs_type (type),
    INDEX idx_activity_logs_performed_by (performed_by),
    INDEX idx_activity_logs_lead_created_at (lead_id, created_at DESC),
    INDEX idx_activity_logs_type_created_at (type, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 20. NOTIFICATIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS notifications (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('lead_assignment', 'lead_created', 'call_reminder', 'status_update', 'system')),
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    data JSON DEFAULT (JSON_OBJECT()),
    `read` BOOLEAN DEFAULT FALSE NOT NULL,
    read_at DATETIME,
    channel_push BOOLEAN DEFAULT FALSE NOT NULL,
    channel_email BOOLEAN DEFAULT FALSE NOT NULL,
    channel_sms BOOLEAN DEFAULT FALSE NOT NULL,
    lead_id CHAR(36) NULL,
    action_url VARCHAR(500),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
    INDEX idx_notifications_user_id (user_id),
    INDEX idx_notifications_type (type),
    INDEX idx_notifications_read (`read`),
    INDEX idx_notifications_lead_id (lead_id),
    INDEX idx_notifications_user_read (user_id, `read`),
    INDEX idx_notifications_user_created_at (user_id, created_at DESC),
    INDEX idx_notifications_user_type_read (user_id, type, `read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 21. NOTIFICATION CONFIGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS notification_configs (
    id CHAR(36) PRIMARY KEY,
    type VARCHAR(50) NOT NULL UNIQUE CHECK (type IN ('email_channel', 'sms_channel', 'push_enabled')),
    value VARCHAR(255) NOT NULL,
    description TEXT,
    updated_by CHAR(36) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_notification_configs_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 22. PUSH SUBSCRIPTIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    endpoint VARCHAR(500) NOT NULL UNIQUE,
    key_p256dh TEXT NOT NULL,
    key_auth TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    deactivated_at DATETIME,
    deactivation_reason VARCHAR(255),
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_push_subscriptions_user_id (user_id),
    INDEX idx_push_subscriptions_endpoint (endpoint),
    INDEX idx_push_subscriptions_user_is_active (user_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 23. SHORT URLS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS short_urls (
    id CHAR(36) PRIMARY KEY,
    short_code VARCHAR(50) UNIQUE,
    original_url TEXT NOT NULL,
    utm_source VARCHAR(255),
    utm_medium VARCHAR(255),
    utm_campaign VARCHAR(255),
    utm_term VARCHAR(255),
    utm_content VARCHAR(255),
    form_id CHAR(36) NULL,
    click_count INT DEFAULT 0 NOT NULL,
    created_by CHAR(36) NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (form_id) REFERENCES form_builder_forms(id) ON DELETE SET NULL,
    INDEX idx_short_urls_short_code (short_code),
    INDEX idx_short_urls_is_active (is_active),
    INDEX idx_short_urls_form_id (form_id),
    INDEX idx_short_urls_short_code_active (short_code, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 24. SHORT URL CLICKS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS short_url_clicks (
    id CHAR(36) PRIMARY KEY,
    short_url_id CHAR(36) NOT NULL,
    clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(45),
    user_agent TEXT,
    referer VARCHAR(500),
    FOREIGN KEY (short_url_id) REFERENCES short_urls(id) ON DELETE CASCADE,
    INDEX idx_short_url_clicks_short_url_id (short_url_id),
    INDEX idx_short_url_clicks_clicked_at (clicked_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 25. IMPORT JOBS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS import_jobs (
    id CHAR(36) PRIMARY KEY,
    upload_id VARCHAR(255) NOT NULL UNIQUE,
    original_name VARCHAR(255),
    file_path TEXT NOT NULL,
    file_size BIGINT,
    extension VARCHAR(10),
    selected_sheets JSON DEFAULT (JSON_ARRAY()),
    source_label VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    created_by CHAR(36) NULL,
    upload_batch_id VARCHAR(255),
    stats_total_processed INT DEFAULT 0,
    stats_total_success INT DEFAULT 0,
    stats_total_errors INT DEFAULT 0,
    stats_sheets_processed JSON DEFAULT (JSON_ARRAY()),
    stats_duration_ms BIGINT,
    message TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    upload_token VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_import_jobs_upload_id (upload_id),
    INDEX idx_import_jobs_status (status),
    INDEX idx_import_jobs_upload_batch_id (upload_batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 26. IMPORT JOB ERROR DETAILS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS import_job_error_details (
    id CHAR(36) PRIMARY KEY,
    import_job_id CHAR(36) NOT NULL,
    sheet VARCHAR(255),
    `row_number` INT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (import_job_id) REFERENCES import_jobs(id) ON DELETE CASCADE,
    INDEX idx_import_job_error_details_import_job_id (import_job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 27. DELETE JOBS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS delete_jobs (
    id CHAR(36) PRIMARY KEY,
    job_id VARCHAR(255) NOT NULL UNIQUE,
    status VARCHAR(50) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    deleted_by CHAR(36) NOT NULL,
    stats_requested_count INT DEFAULT 0,
    stats_valid_count INT DEFAULT 0,
    stats_deleted_lead_count INT DEFAULT 0,
    stats_deleted_log_count INT DEFAULT 0,
    stats_duration_ms BIGINT,
    message TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_delete_jobs_job_id (job_id),
    INDEX idx_delete_jobs_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 28. DELETE JOB LEAD IDS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS delete_job_lead_ids (
    id CHAR(36) PRIMARY KEY,
    delete_job_id CHAR(36) NOT NULL,
    lead_id CHAR(36) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (delete_job_id) REFERENCES delete_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    INDEX idx_delete_job_lead_ids_delete_job_id (delete_job_id),
    INDEX idx_delete_job_lead_ids_lead_id (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 29. DELETE JOB ERROR DETAILS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS delete_job_error_details (
    id CHAR(36) PRIMARY KEY,
    delete_job_id CHAR(36) NOT NULL,
    lead_id CHAR(36) NULL,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (delete_job_id) REFERENCES delete_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
    INDEX idx_delete_job_error_details_delete_job_id (delete_job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 30. ADMISSION SEQUENCES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS admission_sequences (
    id CHAR(36) PRIMARY KEY,
    year INT NOT NULL UNIQUE,
    last_sequence INT DEFAULT 0 NOT NULL CHECK (last_sequence >= 0),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_admission_sequences_year (year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 31. FORM BUILDER FORMS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS form_builder_forms (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_default BOOLEAN DEFAULT FALSE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_by CHAR(36) NULL,
    updated_by CHAR(36) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_form_builder_forms_name (name),
    INDEX idx_form_builder_forms_is_active (is_active),
    INDEX idx_form_builder_forms_is_default (is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 32. FORM BUILDER FIELDS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS form_builder_fields (
    id CHAR(36) PRIMARY KEY,
    form_id CHAR(36) NOT NULL,
    field_name VARCHAR(255) NOT NULL,
    field_type VARCHAR(50) NOT NULL CHECK (field_type IN ('text', 'number', 'email', 'tel', 'date', 'dropdown', 'checkbox', 'radio', 'textarea', 'file')),
    field_label VARCHAR(255) NOT NULL,
    placeholder VARCHAR(255),
    is_required BOOLEAN DEFAULT FALSE NOT NULL,
    validation_rules JSON DEFAULT (JSON_OBJECT()),
    display_order INT DEFAULT 0 NOT NULL,
    options JSON DEFAULT (JSON_ARRAY()),
    default_value TEXT,
    help_text TEXT,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_by CHAR(36) NULL,
    updated_by CHAR(36) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (form_id) REFERENCES form_builder_forms(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_form_builder_fields_form_id (form_id),
    INDEX idx_form_builder_fields_field_name (field_name),
    INDEX idx_form_builder_fields_field_type (field_type),
    INDEX idx_form_builder_fields_display_order (display_order),
    INDEX idx_form_builder_fields_is_active (is_active),
    INDEX idx_form_builder_fields_form_order (form_id, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
