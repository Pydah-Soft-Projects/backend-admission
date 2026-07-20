-- Parent occupation for joining/admission parent details.
-- Apply to primary admissions DB.

ALTER TABLE joinings
  ADD COLUMN father_occupation VARCHAR(255) DEFAULT '' COMMENT 'Father occupation from joining parents form' AFTER father_photo;

ALTER TABLE joinings
  ADD COLUMN mother_occupation VARCHAR(255) DEFAULT '' COMMENT 'Mother occupation from joining parents form' AFTER mother_photo;

ALTER TABLE admissions
  ADD COLUMN father_occupation VARCHAR(255) DEFAULT '' COMMENT 'Father occupation copied from joining at approval' AFTER father_photo;

ALTER TABLE admissions
  ADD COLUMN mother_occupation VARCHAR(255) DEFAULT '' COMMENT 'Mother occupation copied from joining at approval' AFTER mother_photo;
