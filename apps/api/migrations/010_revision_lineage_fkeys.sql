-- The content indexer rebuilds the dashboard projection by deleting revisions that committed
-- Git history no longer contains and re-upserting the rest. Both revision lineage columns
-- referenced dashboard_revisions with the default NO ACTION, so deleting a parent while a
-- surviving sibling still pointed at it aborted the whole reindex transaction, and the loop
-- retried the same failure forever without projecting anything. Migration 009 gave the other
-- index-maintenance foreign keys ON DELETE SET NULL; these two were missed. applyContentIndex
-- repopulates the pointers it can still resolve immediately after the delete.
ALTER TABLE dashboard_revisions
  DROP CONSTRAINT IF EXISTS dashboard_revisions_parent_revision_id_fkey,
  DROP CONSTRAINT IF EXISTS dashboard_revisions_restored_from_revision_id_fkey;

ALTER TABLE dashboard_revisions
  ADD CONSTRAINT dashboard_revisions_parent_revision_id_fkey
    FOREIGN KEY (parent_revision_id) REFERENCES dashboard_revisions(id) ON DELETE SET NULL,
  ADD CONSTRAINT dashboard_revisions_restored_from_revision_id_fkey
    FOREIGN KEY (restored_from_revision_id) REFERENCES dashboard_revisions(id) ON DELETE SET NULL;
