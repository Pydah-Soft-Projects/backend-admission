-- AC / Non-AC qualification: NULL = not answered, 0 = Non-AC, 1 = AC.
-- Apply to primary admissions DB (joinings + admissions).

ALTER TABLE joinings
  ADD COLUMN qualification_ac TINYINT(1) NULL DEFAULT NULL
  AFTER qualification_merit;

ALTER TABLE admissions
  ADD COLUMN qualification_ac TINYINT(1) NULL DEFAULT NULL
  AFTER qualification_merit;
