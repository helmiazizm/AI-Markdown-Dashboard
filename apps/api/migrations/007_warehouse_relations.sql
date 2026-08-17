CREATE TABLE warehouse_relations (
  project text NOT NULL,
  schema_name text NOT NULL,
  table_name text NOT NULL,
  dataset_name text NOT NULL,
  snapshot_column text,
  grain text NOT NULL,
  cautions jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_revision bigint NOT NULL DEFAULT 1 CHECK (source_revision > 0),
  duckdb_file text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project, schema_name, table_name),
  CHECK (project ~ '^[a-z][a-z0-9_]*$'),
  CHECK (schema_name ~ '^[a-z][a-z0-9_]*$'),
  CHECK (table_name ~ '^[a-z][a-z0-9_]*$'),
  CHECK (duckdb_file ~ '^[a-z][a-z0-9_]*\.duckdb$'),
  CHECK (snapshot_column IS NULL OR snapshot_column ~ '^[a-z][a-z0-9_]*$'),
  CHECK (jsonb_typeof(cautions) = 'array')
);

CREATE TABLE warehouse_ingests (
  id uuid PRIMARY KEY,
  catalog_sha256 text NOT NULL UNIQUE,
  source_path text NOT NULL,
  snapshot_date date,
  row_count bigint,
  status text NOT NULL CHECK (status IN ('loading', 'transforming', 'ready', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

INSERT INTO warehouse_relations (
  project, schema_name, table_name, dataset_name, snapshot_column, grain, cautions, duckdb_file
) VALUES
  (
    'nike', 'catalog', 'listings', 'Nike global catalog', 'snapshot_date',
    'One product-size-market observation from the captured catalog snapshot.',
    '["Use distinct product_id when measuring product breadth; raw rows include size and market repetition.","Local prices are not FX-normalized and must not be compared across currencies without conversion.","Availability fields are point-in-time source flags, not demand or inventory forecasts."]'::jsonb,
    'nike.duckdb'
  ),
  (
    'tlc', 'taxi', 'yellow_trips', 'NYC TLC yellow taxi trips', 'data_month',
    'One row is one TLC yellow taxi trip record.',
    '["Filter on data_month before scanning; the grain table is a multi-year trip history.","Fares and totals are USD as recorded by TLC and are not inflation-adjusted.","Pickup zone names come from the TLC taxi zone lookup joined at load time."]'::jsonb,
    'tlc.duckdb'
  )
ON CONFLICT (project, schema_name, table_name) DO NOTHING;

COMMENT ON COLUMN data_snapshots.relation_name IS
  'Catalog identity for the active warehouse revision (warehouse:catalog@<id>), not a grain table name.';
