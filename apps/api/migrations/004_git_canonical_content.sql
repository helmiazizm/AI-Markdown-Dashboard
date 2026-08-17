ALTER TABLE dashboards
  ADD COLUMN IF NOT EXISTS content_path text;

CREATE UNIQUE INDEX IF NOT EXISTS dashboards_content_path_idx
  ON dashboards(content_path) WHERE content_path IS NOT NULL;

ALTER TABLE dashboard_revisions
  ADD COLUMN IF NOT EXISTS publication_status text NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS git_commit_sha text,
  ADD COLUMN IF NOT EXISTS git_source_commit_sha text,
  ADD COLUMN IF NOT EXISTS git_tree_sha text,
  ADD COLUMN IF NOT EXISTS artifact_hash text,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS publication_error text;

UPDATE dashboard_revisions SET published_at = created_at
WHERE publication_status = 'published' AND published_at IS NULL;

ALTER TABLE dashboard_revisions
  DROP CONSTRAINT IF EXISTS dashboard_revisions_publication_status_check,
  DROP CONSTRAINT IF EXISTS dashboard_revisions_source_kind_check;

ALTER TABLE dashboard_revisions
  ADD CONSTRAINT dashboard_revisions_publication_status_check
    CHECK (publication_status IN ('pending', 'published', 'blocked', 'failed')),
  ADD CONSTRAINT dashboard_revisions_source_kind_check
    CHECK (source_kind IN ('agent', 'manual', 'restore', 'legacy', 'bootstrap'));

ALTER TABLE generation_runs
  DROP CONSTRAINT IF EXISTS generation_runs_status_check;

ALTER TABLE generation_runs
  ADD CONSTRAINT generation_runs_status_check
    CHECK (status IN ('queued', 'running', 'publishing', 'publication_blocked', 'completed', 'failed'));

CREATE TABLE IF NOT EXISTS content_repository_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  configured_branch text NOT NULL DEFAULT 'main',
  current_head text,
  last_indexed_head text,
  readiness_state text NOT NULL DEFAULT 'uninitialized',
  activated boolean NOT NULL DEFAULT false,
  last_successful_scan timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO content_repository_state(singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS content_publications (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL UNIQUE REFERENCES dashboard_revisions(id) ON DELETE CASCADE,
  run_id uuid REFERENCES generation_runs(id) ON DELETE SET NULL,
  dashboard_id uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  expected_head text,
  expected_base_revision_id uuid REFERENCES dashboard_revisions(id),
  expected_bundle_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('prepared', 'publishing', 'committed', 'published', 'blocked', 'failed')),
  commit_sha text,
  journal jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_count integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_publications_status_idx
  ON content_publications(status, updated_at);

CREATE TABLE IF NOT EXISTS content_publication_events (
  id bigserial PRIMARY KEY,
  publication_id uuid NOT NULL REFERENCES content_publications(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  message text NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_publication_events_publication_idx
  ON content_publication_events(publication_id, id);

CREATE TABLE IF NOT EXISTS content_validation_runs (
  id uuid PRIMARY KEY,
  expected_head text,
  repository_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'valid', 'invalid', 'imported', 'expired')),
  affected_dashboards jsonb NOT NULL DEFAULT '[]'::jsonb,
  candidate_payload jsonb,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS content_validation_events (
  id bigserial PRIMARY KEY,
  validation_id uuid NOT NULL REFERENCES content_validation_runs(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  message text NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_validation_events_validation_idx
  ON content_validation_events(validation_id, id);
