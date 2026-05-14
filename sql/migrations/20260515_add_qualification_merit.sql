-- Merit qualification (Yes/No): NULL = not answered, 0 = No, 1 = Yes.
-- Apply to primary admissions DB (joinings + admissions).

ALTER TABLE joinings
  ADD COLUMN qualification_merit TINYINT(1) NULL DEFAULT NULL
  AFTER qualification_ug;

ALTER TABLE admissions
  ADD COLUMN qualification_merit TINYINT(1) NULL DEFAULT NULL
  AFTER qualification_ug;
