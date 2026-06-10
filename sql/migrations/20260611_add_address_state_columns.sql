-- Communication address state + relative/friend state on joining and admission records.
-- Apply to primary admissions DB.
-- Safe to re-run via: npm run migrate:joining-address

ALTER TABLE joinings
  ADD COLUMN address_state VARCHAR(255) DEFAULT '' COMMENT 'Communication address state' AFTER address_pin_code;

ALTER TABLE admissions
  ADD COLUMN address_state VARCHAR(255) DEFAULT '' COMMENT 'Communication address state' AFTER address_pin_code;

ALTER TABLE joining_relatives
  ADD COLUMN state VARCHAR(255) DEFAULT '' COMMENT 'Relative or friend address state' AFTER phone;

ALTER TABLE admission_relatives
  ADD COLUMN state VARCHAR(255) DEFAULT '' COMMENT 'Relative or friend address state' AFTER phone;
