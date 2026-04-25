-- SMS bulk job: store audience filters for reports (e.g. user-specific leads: selected users + student group)
ALTER TABLE sms_bulk_jobs
  ADD COLUMN report_context JSON NULL COMMENT 'e.g. selectedUsers, studentGroup, district for user_specific_leads' AFTER source;
