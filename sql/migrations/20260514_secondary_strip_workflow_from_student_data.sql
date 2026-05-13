-- Run on **secondary** (student) database only — not admissions_db.
-- Removes joining/admission workflow tokens from `student_data` where legacy UIs confuse `status` with student lifecycle.
-- Created: 2026-05-14

UPDATE students
SET student_data = JSON_REMOVE(student_data, '$.status')
WHERE JSON_EXTRACT(student_data, '$.status') IS NOT NULL
  AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(student_data, '$.status'))) IN ('draft', 'pending_approval', 'approved');

UPDATE students
SET student_data = JSON_REMOVE(student_data, '$.registrationFormData.student_status')
WHERE JSON_EXTRACT(student_data, '$.registrationFormData.student_status') IS NOT NULL
  AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(student_data, '$.registrationFormData.student_status'))) IN (
    'draft',
    'pending_approval',
    'approved'
  );
