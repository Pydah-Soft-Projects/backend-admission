-- Permanent campus self-registration QR (plain token stored for admin display; hash validated at runtime)
CREATE TABLE IF NOT EXISTS joining_self_registration_link (
  id CHAR(36) PRIMARY KEY,
  token_plain VARCHAR(128) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  public_edit_token_id CHAR(36) NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_self_reg_token_hash (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
