-- Preserve the successful workspace lineage between separately audited Runs.
ALTER TABLE runs ADD COLUMN parent_run_id uuid;
ALTER TABLE runs
  ADD CONSTRAINT runs_parent_same_workspace_fk
  FOREIGN KEY (parent_run_id, workspace_id) REFERENCES runs (id, workspace_id);
