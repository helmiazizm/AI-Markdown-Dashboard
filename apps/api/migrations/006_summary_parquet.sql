ALTER TABLE query_result_snapshots
  ADD COLUMN IF NOT EXISTS object_prefix text,
  ADD COLUMN IF NOT EXISTS version_id uuid;

ALTER TABLE query_result_snapshots
  ALTER COLUMN rows DROP NOT NULL;
