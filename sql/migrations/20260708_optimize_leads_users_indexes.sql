-- Optimization Indexes for Leads (created_at, needs_manual_update) and Users (role_name)
-- Helps prevent full-table scans during analytics aggregates, filtering, and reporting scans.

-- 1. Index on leads(created_at) for fast date-range filtering
CREATE INDEX idx_leads_created_at_opt ON leads (created_at);

-- 2. Index on leads(needs_manual_update) for status checks
CREATE INDEX idx_leads_needs_manual_update_opt ON leads (needs_manual_update);

-- 3. Index on users(role_name) for fast role checks and cohort mapping joins
CREATE INDEX idx_users_role_name_opt ON users (role_name);
