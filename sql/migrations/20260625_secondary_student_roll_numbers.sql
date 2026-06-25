-- Secondary student DB: branch-based roll numbers for admitted students (e.g. CSE001).

CREATE TABLE IF NOT EXISTS student_roll_counters (
  batch SMALLINT UNSIGNED NOT NULL COMMENT 'Intake calendar year e.g. 2026',
  branch_scope VARCHAR(64) NOT NULL COMMENT 'Stable branch key id:N or label:NAME',
  branch_prefix VARCHAR(20) NOT NULL DEFAULT '' COMMENT 'Last issued prefix for reference',
  last_serial INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (batch, branch_scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_roll_numbers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT UNSIGNED NOT NULL,
  admission_number VARCHAR(50) NOT NULL,
  roll_number VARCHAR(30) NOT NULL,
  branch_prefix VARCHAR(20) NOT NULL,
  branch_scope VARCHAR(64) NULL,
  serial INT UNSIGNED NOT NULL,
  batch SMALLINT UNSIGNED NOT NULL,
  managed_branch_id INT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_student_roll_admission (admission_number),
  UNIQUE KEY uk_student_roll_student_id (student_id),
  UNIQUE KEY uk_student_roll_batch_number (batch, roll_number),
  INDEX idx_student_roll_batch_branch (batch, branch_scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
