-- Migration: Add composite index to fee_requests to optimize lookup by admission_number & status
CREATE INDEX idx_fee_requests_admission_number_status ON fee_requests (admission_number, status);
