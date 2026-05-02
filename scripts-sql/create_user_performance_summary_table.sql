-- SQL Script: Create User Performance Summary Table
-- Purpose: To store pre-calculated daily analytics for Counselor and PRO performance
-- This table enables instant loading of dashboards by avoiding real-time scans of millions of logs.

CREATE TABLE IF NOT EXISTS user_performance_summaries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  academic_year INT NOT NULL,
  student_group VARCHAR(50) NOT NULL,
  summary_date DATE NOT NULL,
  role_name VARCHAR(50) NOT NULL,
  
  -- Core Metrics
  total_assigned_count INT DEFAULT 0 COMMENT 'Leads assigned to the user on this day',
  total_handled_leads INT DEFAULT 0 COMMENT 'Unique leads touched (comm/status change) today',
  active_leads_count INT DEFAULT 0 COMMENT 'Snapshot of current non-terminal leads at end of day',
  converted_count INT DEFAULT 0 COMMENT 'Leads converted to admissions today',
  reclaimed_count INT DEFAULT 0 COMMENT 'Leads taken AWAY from this user today due to inactivity',
  
  -- Activity Metrics
  calls_count INT DEFAULT 0,
  sms_count INT DEFAULT 0,
  total_call_duration_seconds INT DEFAULT 0,
  status_changes_count INT DEFAULT 0,
  
  -- Breakdown (JSON)
  -- Based on role: Counselors -> call_status breakdown, PRO -> visit_status breakdown
  -- Example: {"Interested": 10, "Call Back": 5, "Not Interested": 2}
  status_breakdown JSON DEFAULT NULL, 
  
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- Constraints and Indexes for high-performance querying
  UNIQUE KEY unique_user_date_group (user_id, academic_year, student_group, summary_date),
  INDEX idx_user_date (user_id, summary_date),
  INDEX idx_summary_date (summary_date),
  INDEX idx_academic_year_group (academic_year, student_group)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Note: This table should be populated initially via a hydration script 
-- and updated in real-time via application hooks.
