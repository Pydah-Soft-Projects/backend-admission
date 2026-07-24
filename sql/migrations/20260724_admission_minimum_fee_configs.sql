-- Minimum transaction fee configs for Pending Fee & Docs (college + course + quota)
CREATE TABLE IF NOT EXISTS admission_minimum_fee_configs (
  id CHAR(36) PRIMARY KEY,
  college_id VARCHAR(64) NOT NULL,
  college_name VARCHAR(255) NOT NULL DEFAULT '',
  course_id VARCHAR(64) NOT NULL,
  course_name VARCHAR(255) NOT NULL DEFAULT '',
  quota VARCHAR(255) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  created_by CHAR(36) NULL,
  updated_by CHAR(36) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_min_fee_college_course_quota (college_id, course_id, quota),
  INDEX idx_min_fee_college (college_id),
  INDEX idx_min_fee_course (course_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
