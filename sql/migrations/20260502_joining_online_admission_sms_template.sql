-- Joining desk: default SMS template for "Send admission SMS" (public form link in {#var#}).
-- Same tables as Communications → Message templates. After migrate, open Communications and
-- replace dlt_template_id with your TRAI-approved DLT template id if the placeholder is still set.
--
-- Safe to run multiple times (skips when template name already exists).

INSERT INTO message_template_groups (id, name, created_at, updated_at)
SELECT UUID(), 'Joining desk', NOW(), NOW()
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM message_template_groups WHERE name = 'Joining desk' LIMIT 1);

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
  'Joining · online admission link',
  (SELECT id FROM message_template_groups WHERE name = 'Joining desk' ORDER BY created_at ASC LIMIT 1),
  'REPLACE_WITH_YOUR_DLT_TEMPLATE_ID',
  'en',
  'Complete your online admission form: https://YOUR_DOMAIN/joining/public?t={#var#}. Thank you.',
  'DLT: `?` before variable; variable = token only. Replace YOUR_DOMAIN with whitelisted host (must match DLT / CTA).',
  FALSE,
  JSON_ARRAY(JSON_OBJECT('key', 'token', 'label', 'Public form token (after public/)', 'defaultValue', '', 'isGlobal', FALSE)),
  1,
  TRUE,
  NULL,
  NULL,
  NOW(),
  NOW()
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM message_templates WHERE name = 'Joining · online admission link' LIMIT 1
)
AND (
  SELECT id FROM message_template_groups WHERE name = 'Joining desk' ORDER BY created_at ASC LIMIT 1
) IS NOT NULL;
