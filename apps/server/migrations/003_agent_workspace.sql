-- An agent named on a task, execution, finding or approval must belong to the
-- run's workspace. These tables have no workspace_id to build a composite key
-- from, so a trigger checks it. Agents and runs never change workspace.
CREATE FUNCTION agent_in_run_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  agent uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
BEGIN
  IF agent IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runs r JOIN agents a ON a.workspace_id = r.workspace_id WHERE r.id = NEW.run_id AND a.id = agent
  ) THEN
    RAISE EXCEPTION '%.% % is not an agent of run %''s workspace', TG_TABLE_NAME, TG_ARGV[0], agent, NEW.run_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_agent_workspace BEFORE INSERT OR UPDATE OF assigned_agent_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION agent_in_run_workspace('assigned_agent_id');
CREATE TRIGGER agent_executions_agent_workspace BEFORE INSERT OR UPDATE OF agent_id ON agent_executions
  FOR EACH ROW EXECUTE FUNCTION agent_in_run_workspace('agent_id');
CREATE TRIGGER security_findings_agent_workspace BEFORE INSERT OR UPDATE OF agent_id ON security_findings
  FOR EACH ROW EXECUTE FUNCTION agent_in_run_workspace('agent_id');
CREATE TRIGGER approvals_agent_workspace BEFORE INSERT OR UPDATE OF agent_id ON approvals
  FOR EACH ROW EXECUTE FUNCTION agent_in_run_workspace('agent_id');
