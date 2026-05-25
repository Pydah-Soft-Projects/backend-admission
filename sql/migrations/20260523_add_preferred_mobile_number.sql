-- Preferred contact mobile for joining/admission (dropdown: student / father / mother).
-- Apply to primary admissions DB.

ALTER TABLE joinings
  ADD COLUMN preferred_mobile_number VARCHAR(20) DEFAULT '' COMMENT 'Preferred SMS/contact mobile from student/father/mother' AFTER mother_phone;

ALTER TABLE admissions
  ADD COLUMN preferred_mobile_number VARCHAR(20) DEFAULT '' COMMENT 'Preferred contact mobile copied from joining at approval' AFTER mother_phone;
