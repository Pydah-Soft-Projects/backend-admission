-- Run once on existing databases (new installs get this from schema.sql).
CREATE TABLE IF NOT EXISTS joining_public_edit_tokens (
    id CHAR(36) PRIMARY KEY,
    token_hash CHAR(64) NOT NULL,
    route_key VARCHAR(64) NOT NULL COMMENT 'Same segment as /joinings/:leadId (joining id or lead id)',
    expires_at DATETIME NOT NULL,
    created_by CHAR(36) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_joining_public_edit_token_hash (token_hash),
    KEY idx_joining_public_edit_expires_at (expires_at),
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
