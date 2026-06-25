-- CRM roll numbers are 2026 admissions only; remove legacy rows from other batches.

DELETE FROM student_roll_numbers
WHERE admission_number NOT LIKE '2026%' OR batch <> 2026;

DELETE FROM student_roll_counters
WHERE batch <> 2026;
