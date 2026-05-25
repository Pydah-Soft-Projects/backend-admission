-- Secondary student DB: preferred contact mobile synced on admission approval.

ALTER TABLE students
  ADD COLUMN preferred_mobile_number VARCHAR(20) DEFAULT '' COMMENT 'Preferred SMS/contact mobile from joining form' AFTER parent_mobile2;
