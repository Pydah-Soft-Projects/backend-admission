-- Parent portrait blobs: same format as registration extras / student_photo (data URL, URL, or filename).
-- Apply to primary admissions DB.

ALTER TABLE joinings
  ADD COLUMN father_photo LONGTEXT NULL COMMENT 'Father portrait from joining registration upload' AFTER mother_aadhaar_number,
  ADD COLUMN mother_photo LONGTEXT NULL COMMENT 'Mother portrait from joining registration upload' AFTER father_photo;

ALTER TABLE admissions
  ADD COLUMN father_photo LONGTEXT NULL COMMENT 'Father portrait copied from joining at approval' AFTER mother_aadhaar_number,
  ADD COLUMN mother_photo LONGTEXT NULL COMMENT 'Mother portrait copied from joining at approval' AFTER father_photo;
