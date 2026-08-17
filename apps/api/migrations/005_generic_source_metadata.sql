ALTER TABLE data_snapshots
  ADD COLUMN dataset_name text NOT NULL DEFAULT 'Governed source dataset',
  ADD COLUMN relation_name text NOT NULL DEFAULT 'source_data',
  ADD COLUMN profile jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN data_snapshots.relation_name IS
  'Stable governed DuckDB relation exposed to agents; currently source_data.';

