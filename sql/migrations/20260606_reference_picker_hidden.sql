-- Names hidden from the reference picker (does not clear reference1 on existing records)
CREATE TABLE IF NOT EXISTS reference_picker_hidden (
  id CHAR(36) PRIMARY KEY,
  name_normalized VARCHAR(255) NOT NULL,
  original_name VARCHAR(512) NOT NULL,
  hidden_by CHAR(36) NULL,
  hidden_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reference_picker_hidden_norm (name_normalized)
);
