-- Optional: run with mysql CLI if you prefer SQL over Node.
-- mysql -u USER -p DATABASE < src/scripts-sql/addUserAnalyticsPerformanceIndexes.sql
--
-- Safe to run twice only if your MySQL version supports IF NOT EXISTS for indexes (8.0.29+).
-- Otherwise use: node src/scripts-sql/addUserAnalyticsPerformanceIndexes.js (skips existing indexes).

CREATE INDEX idx_activity_logs_type_target_user_created ON activity_logs (type, target_user_id, created_at);
CREATE INDEX idx_activity_logs_type_performed_by_created ON activity_logs (type, performed_by, created_at);
CREATE INDEX idx_activity_logs_type_source_user_created ON activity_logs (type, source_user_id, created_at);
CREATE INDEX idx_communications_type_sent_by_sent_at ON communications (type, sent_by, sent_at);
