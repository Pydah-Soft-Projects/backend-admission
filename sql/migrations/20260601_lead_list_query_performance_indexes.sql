-- Lead list + dashboard query performance (safe to re-run: skip if index exists).
-- Apply in MySQL editor or: node src/scripts-sql/addLeadListPerformanceIndexes.js

-- Paginated list ORDER BY created_at DESC, id
CREATE INDEX idx_leads_created_id ON leads (created_at DESC, id ASC);

-- Counsellor / PRO scoped lists
CREATE INDEX idx_leads_assigned_created_id ON leads (assigned_to, created_at DESC, id ASC);
CREATE INDEX idx_leads_assigned_pro_created_id ON leads (assigned_to_pro, created_at DESC, id ASC);

-- scheduledOn dashboard filter (range on next_scheduled_call)
CREATE INDEX idx_leads_next_scheduled_created ON leads (next_scheduled_call, created_at DESC, id ASC);

-- Missed-call / excludeTouchedToday subqueries on communications
CREATE INDEX idx_communications_lead_type_sent_at ON communications (lead_id, type, sent_at);

-- touchedToday / excludeTouchedToday on activity_logs
CREATE INDEX idx_activity_logs_lead_performed_created ON activity_logs (lead_id, performed_by, created_at);
