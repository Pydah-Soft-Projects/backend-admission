-- Mobile number for relative/friend addresses on joining and admission forms.
-- Apply to primary admissions DB.
-- Safe to re-run via: npm run migrate:relative-phone

ALTER TABLE joining_relatives
  ADD COLUMN phone VARCHAR(20) DEFAULT '' COMMENT 'Relative or friend mobile number' AFTER relationship;

ALTER TABLE admission_relatives
  ADD COLUMN phone VARCHAR(20) DEFAULT '' COMMENT 'Relative or friend mobile number' AFTER relationship;