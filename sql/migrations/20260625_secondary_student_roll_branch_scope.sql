-- Secondary student DB: branch-scoped roll number counters (one 001..N series per branch).

ALTER TABLE student_roll_counters
  ADD COLUMN branch_scope VARCHAR(64) NOT NULL DEFAULT '' COMMENT 'Stable branch key id:N or label:NAME' AFTER branch_prefix;

UPDATE student_roll_counters
SET branch_scope = CONCAT('legacy:', branch_prefix)
WHERE branch_scope = '' OR branch_scope IS NULL;

ALTER TABLE student_roll_counters DROP PRIMARY KEY;
ALTER TABLE student_roll_counters ADD PRIMARY KEY (batch, branch_scope);

ALTER TABLE student_roll_numbers
  ADD COLUMN branch_scope VARCHAR(64) NULL COMMENT 'Stable branch key id:N or label:NAME' AFTER branch_prefix;
