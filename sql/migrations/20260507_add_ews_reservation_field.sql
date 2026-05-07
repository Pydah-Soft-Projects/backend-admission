-- Migration to add EWS Yes/No option to joinings and admissions
-- Created: 2026-05-07

ALTER TABLE joinings 
ADD COLUMN reservation_is_ews BOOLEAN DEFAULT FALSE AFTER reservation_general;

ALTER TABLE admissions 
ADD COLUMN reservation_is_ews BOOLEAN DEFAULT FALSE AFTER reservation_general;
