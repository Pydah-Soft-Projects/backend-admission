-- Admission desk: DLT-approved SMS sent automatically when a joining is approved.
-- Template id 1707177813524494745 — variables: {#var#}=studentName, {#var#}=admissionNumber.
-- Same tables as Communications → Message templates. Safe to run multiple times
-- (skips when template name already exists).

INSERT INTO message_template_groups (id, name, created_at, updated_at)
SELECT UUID(), 'Admission desk', NOW(), NOW()
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM message_template_groups WHERE name = 'Admission desk' LIMIT 1);

INSERT INTO message_templates (
  id,
  name,
  template_group_id,
  dlt_template_id,
  language,
  content,
  description,
  is_unicode,
  variables,
  variable_count,
  is_active,
  created_by,
  updated_by,
  created_at,
  updated_at
)
SELECT
  UUID(),
  'Admission · confirmation on approval',
  (SELECT id FROM message_template_groups WHERE name = 'Admission desk' ORDER BY created_at ASC LIMIT 1),
  '1707177813524494745',
  'en',
  'Dear {#var#}, Congratulations and welcome to Pydah Group! Your admission has been successfully processed. Admission Number: {#var#}. We look forward to being part of your academic journey. Warm Regards, Pydah Group',
  'Auto-sent when a joining form is approved. Variable 1 = student name, variable 2 = admission number.',
  FALSE,
  JSON_ARRAY(
    JSON_OBJECT('key', 'studentName',     'label', 'Student name',     'defaultValue', '', 'isGlobal', FALSE),
    JSON_OBJECT('key', 'admissionNumber', 'label', 'Admission number', 'defaultValue', '', 'isGlobal', FALSE)
  ),
  2,
  TRUE,
  NULL,
  NULL,
  NOW(),
  NOW()
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates WHERE name = 'Admission · confirmation on approval' LIMIT 1
)
AND (
  SELECT id FROM message_template_groups WHERE name = 'Admission desk' ORDER BY created_at ASC LIMIT 1
) IS NOT NULL;
