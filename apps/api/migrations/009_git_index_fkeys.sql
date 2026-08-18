ALTER TABLE generation_runs
  DROP CONSTRAINT IF EXISTS generation_runs_dashboard_id_fkey,
  DROP CONSTRAINT IF EXISTS generation_runs_revision_id_fkey,
  DROP CONSTRAINT IF EXISTS generation_runs_base_revision_id_fkey;

ALTER TABLE generation_runs
  ADD CONSTRAINT generation_runs_dashboard_id_fkey
    FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE SET NULL,
  ADD CONSTRAINT generation_runs_revision_id_fkey
    FOREIGN KEY (revision_id) REFERENCES dashboard_revisions(id) ON DELETE SET NULL,
  ADD CONSTRAINT generation_runs_base_revision_id_fkey
    FOREIGN KEY (base_revision_id) REFERENCES dashboard_revisions(id) ON DELETE SET NULL;

ALTER TABLE dashboards
  DROP CONSTRAINT IF EXISTS dashboards_current_revision_fk;

ALTER TABLE dashboards
  ADD CONSTRAINT dashboards_current_revision_fk
    FOREIGN KEY (current_revision_id) REFERENCES dashboard_revisions(id) ON DELETE SET NULL;
