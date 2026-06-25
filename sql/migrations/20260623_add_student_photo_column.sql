-- Add student_photo dedicated column to joinings and admissions tables.
-- Mirrors the pattern used for father_photo / mother_photo (added in 20260514).
-- Apply to primary admissions DB.

ALTER TABLE joinings
  ADD COLUMN student_photo LONGTEXT NULL COMMENT 'Student portrait from joining registration upload (data URL, URL, or filename)' AFTER mother_photo;

ALTER TABLE admissions
  ADD COLUMN student_photo LONGTEXT NULL COMMENT 'Student portrait copied from joining at approval' AFTER mother_photo;
