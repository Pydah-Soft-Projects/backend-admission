-- Student-database course/branch ids (no FK to primary courses — those IDs live in student_database).
-- Primary course_id/branch_id remain for legacy primary-catalog FKs when present.
-- Created: 2026-05-13

ALTER TABLE joinings
  ADD COLUMN managed_course_id VARCHAR(64) NULL COMMENT 'Secondary student DB course id' AFTER branch_id,
  ADD COLUMN managed_branch_id VARCHAR(64) NULL COMMENT 'Secondary student DB branch id' AFTER managed_course_id;

ALTER TABLE admissions
  ADD COLUMN managed_course_id VARCHAR(64) NULL COMMENT 'Secondary student DB course id' AFTER branch_id,
  ADD COLUMN managed_branch_id VARCHAR(64) NULL COMMENT 'Secondary student DB branch id' AFTER managed_course_id;

ALTER TABLE joinings ADD INDEX idx_joinings_managed_course_id (managed_course_id);
ALTER TABLE admissions ADD INDEX idx_admissions_managed_course_id (managed_course_id);

-- Backfill from lead_data sidecar (where counsellors picked a course in the UI)
UPDATE joinings j
SET
  managed_course_id = NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$._joiningManagedCourseId'))), ''),
  managed_branch_id = NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$._joiningManagedBranchId'))), '')
WHERE
  (j.managed_course_id IS NULL OR TRIM(j.managed_course_id) = '')
  AND JSON_EXTRACT(j.lead_data, '$._joiningManagedCourseId') IS NOT NULL
  AND TRIM(JSON_UNQUOTE(JSON_EXTRACT(j.lead_data, '$._joiningManagedCourseId'))) != '';

UPDATE admissions a
INNER JOIN joinings j ON j.id = a.joining_id
SET
  a.managed_course_id = COALESCE(NULLIF(TRIM(a.managed_course_id), ''), NULLIF(TRIM(j.managed_course_id), '')),
  a.managed_branch_id = COALESCE(NULLIF(TRIM(a.managed_branch_id), ''), NULLIF(TRIM(j.managed_branch_id), ''))
WHERE
  a.managed_course_id IS NULL
  OR TRIM(a.managed_course_id) = '';
