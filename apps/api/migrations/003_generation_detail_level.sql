ALTER TABLE generation_runs
  ADD COLUMN IF NOT EXISTS detail_level text NOT NULL DEFAULT 'standard'
  CHECK (detail_level IN ('standard', 'detailed'));
