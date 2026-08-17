CREATE TABLE data_snapshots (
  id uuid PRIMARY KEY,
  ingest_id uuid NOT NULL,
  object_prefix text NOT NULL UNIQUE,
  snapshot_date date NOT NULL,
  row_count bigint NOT NULL,
  country_count integer NOT NULL,
  category_count integer NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'failed')),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX data_snapshots_one_active_idx ON data_snapshots(active) WHERE active;

CREATE TABLE dashboards (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  summary text NOT NULL,
  current_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dashboard_revisions (
  id uuid PRIMARY KEY,
  dashboard_id uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  parent_revision_id uuid REFERENCES dashboard_revisions(id),
  restored_from_revision_id uuid REFERENCES dashboard_revisions(id),
  prompt text NOT NULL,
  artifact jsonb NOT NULL,
  model text NOT NULL,
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dashboard_id, revision_number)
);

ALTER TABLE dashboards
  ADD CONSTRAINT dashboards_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES dashboard_revisions(id);

CREATE TABLE generation_runs (
  id uuid PRIMARY KEY,
  dashboard_id uuid REFERENCES dashboards(id),
  base_revision_id uuid REFERENCES dashboard_revisions(id),
  revision_id uuid REFERENCES dashboard_revisions(id),
  mode text NOT NULL CHECK (mode IN ('create', 'refine')),
  prompt text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  model text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE TABLE generation_run_events (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  message text NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX generation_run_events_run_idx ON generation_run_events(run_id, id);

CREATE TABLE query_result_snapshots (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES dashboard_revisions(id) ON DELETE CASCADE,
  dataset_id text NOT NULL,
  columns jsonb NOT NULL,
  rows jsonb NOT NULL,
  row_count integer NOT NULL,
  truncated boolean NOT NULL,
  source_snapshot_id uuid NOT NULL REFERENCES data_snapshots(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX query_result_latest_idx ON query_result_snapshots(revision_id, dataset_id, created_at DESC);
