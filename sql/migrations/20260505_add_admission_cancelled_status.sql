-- Migration to add 'Admission Cancelled' status to admissions table
-- Date: 2026-05-05

-- In MySQL 8.0.16+, check constraints can be dropped and added.
-- First, we need to find the constraint name. Usually it's admissions_chk_1.
-- If it's not, this script might need adjustment.

-- Since we know the name from the error message: admissions_chk_1
ALTER TABLE admissions DROP CHECK admissions_chk_1;

ALTER TABLE admissions ADD CONSTRAINT admissions_chk_1 CHECK (status IN ('active', 'withdrawn', 'Admission Cancelled'));
