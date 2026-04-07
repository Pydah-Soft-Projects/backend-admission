-- Backfill leads.call_status from the latest communications row per lead (type = 'call', non-empty call_outcome).
-- Requires MySQL 8+ (ROW_NUMBER). Replace admissions_db if your schema name differs.
--
-- Preview (run first):
-- SELECT l.id, l.call_status AS current_call_status, x.call_outcome AS from_latest_call
-- FROM leads l
-- INNER JOIN (
--   SELECT lead_id, call_outcome
--   FROM (
--     SELECT lead_id, call_outcome,
--       ROW_NUMBER() OVER (PARTITION BY lead_id ORDER BY sent_at DESC, id DESC) AS rn
--     FROM communications
--     WHERE type = 'call'
--       AND call_outcome IS NOT NULL
--       AND TRIM(call_outcome) <> ''
--   ) t
--   WHERE rn = 1
-- ) x ON l.id = x.lead_id
-- WHERE l.call_status IS NULL OR TRIM(l.call_status) = '';

UPDATE leads l
INNER JOIN (
  SELECT lead_id, call_outcome
  FROM (
    SELECT lead_id, call_outcome,
      ROW_NUMBER() OVER (PARTITION BY lead_id ORDER BY sent_at DESC, id DESC) AS rn
    FROM communications
    WHERE type = 'call'
      AND call_outcome IS NOT NULL
      AND TRIM(call_outcome) <> ''
  ) t
  WHERE rn = 1
) x ON l.id = x.lead_id
SET l.call_status = x.call_outcome
WHERE l.call_status IS NULL OR TRIM(l.call_status) = '';
