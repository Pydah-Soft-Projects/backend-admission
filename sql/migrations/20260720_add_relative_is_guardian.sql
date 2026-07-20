-- Mark a relative/friend row as the guardian contact for preferred-mobile selection.
-- Apply to primary admissions DB.

ALTER TABLE joining_relatives
  ADD COLUMN is_guardian TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Guardian entry for preferred mobile' AFTER phone;

ALTER TABLE admission_relatives
  ADD COLUMN is_guardian TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Guardian entry for preferred mobile' AFTER phone;
