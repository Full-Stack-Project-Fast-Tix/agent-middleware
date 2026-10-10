-- Creation order: timestamps can tie at millisecond precision, so lists order
-- by these instead. Adding an identity column numbers the existing rows too.
ALTER TABLE tasks ADD COLUMN created_seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE agent_executions ADD COLUMN created_seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE security_findings ADD COLUMN created_seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE approvals ADD COLUMN created_seq bigint GENERATED ALWAYS AS IDENTITY;

DROP INDEX tasks_run_created_idx;
CREATE INDEX tasks_run_idx ON tasks (run_id, created_seq);
DROP INDEX agent_executions_run_idx;
CREATE INDEX agent_executions_run_idx ON agent_executions (run_id, created_seq);
DROP INDEX security_findings_run_idx;
CREATE INDEX security_findings_run_idx ON security_findings (run_id, created_seq);
DROP INDEX approvals_run_idx;
CREATE INDEX approvals_run_idx ON approvals (run_id, created_seq);

-- Rows that name a task or execution must name one from their own run.
ALTER TABLE agent_executions ADD UNIQUE (id, run_id);

ALTER TABLE security_findings
  ADD FOREIGN KEY (task_id, run_id) REFERENCES tasks (id, run_id),
  ADD FOREIGN KEY (execution_id, run_id) REFERENCES agent_executions (id, run_id);

ALTER TABLE approvals
  ADD FOREIGN KEY (task_id, run_id) REFERENCES tasks (id, run_id),
  ADD FOREIGN KEY (execution_id, run_id) REFERENCES agent_executions (id, run_id);

-- run_id is nullable on these, and a composite key with a null skips the check.
ALTER TABLE audit_events
  ADD CHECK ((task_id IS NULL AND execution_id IS NULL) OR run_id IS NOT NULL),
  ADD FOREIGN KEY (task_id, run_id) REFERENCES tasks (id, run_id),
  ADD FOREIGN KEY (execution_id, run_id) REFERENCES agent_executions (id, run_id);

ALTER TABLE reflection_sightings
  ADD CHECK (execution_id IS NULL OR run_id IS NOT NULL),
  ADD FOREIGN KEY (execution_id, run_id) REFERENCES agent_executions (id, run_id);
