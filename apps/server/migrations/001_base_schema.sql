-- Base schema for the Run -> Task -> AgentExecution model.
-- Columns mirror the Zod schemas in packages/shared (snake_case here, camelCase
-- there). Rules follow docs/contract-decisions.md, "Guidance for P3's schema".
-- Enum values must match packages/shared/src/enums.ts; a test checks this.

CREATE TYPE workspace_role AS ENUM ('developer', 'security_admin', 'auditor');
CREATE TYPE platform_role AS ENUM ('platform_admin');
CREATE TYPE policy_scope AS ENUM ('platform', 'workspace');
CREATE TYPE run_status AS ENUM ('queued', 'planning', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled');
CREATE TYPE task_status AS ENUM ('pending', 'ready', 'running', 'waiting_approval', 'completed', 'failed', 'skipped', 'cancelled');
CREATE TYPE execution_status AS ENUM ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled');
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'denied', 'timed_out', 'cancelled');
CREATE TYPE finding_severity AS ENUM ('info', 'low', 'medium', 'high', 'critical');
CREATE TYPE security_layer AS ENUM ('deterministic', 'semantic', 'policy', 'memory', 'runtime');
CREATE TYPE orchestration_mode AS ENUM ('single', 'auto');
CREATE TYPE action_type AS ENUM ('command', 'file_change', 'delegation', 'context_handoff');
CREATE TYPE approval_reason AS ENUM ('high_consequence', 'semantic_uncertainty', 'semantic_unavailable', 'policy_required');
CREATE TYPE actor_type AS ENUM ('user', 'agent', 'system');

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  auth_subject text NOT NULL UNIQUE,
  platform_role platform_role,
  password_hash text,
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL
);

-- Only the SHA-256 of the session token is stored.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  created_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  source_path text,
  repository_url text,
  default_branch text,
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  user_id uuid NOT NULL REFERENCES users (id),
  role workspace_role NOT NULL,
  joined_at timestamptz(3) NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_id_idx ON workspace_members (user_id);

CREATE TABLE agent_profiles (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  name text NOT NULL,
  description text,
  cap_write boolean NOT NULL DEFAULT false,
  cap_shell boolean NOT NULL DEFAULT false,
  cap_network boolean NOT NULL DEFAULT false,
  cap_delegate boolean NOT NULL DEFAULT false,
  cap_max_delegation_depth integer NOT NULL DEFAULT 0 CHECK (cap_max_delegation_depth >= 0),
  version integer NOT NULL CHECK (version >= 1),
  archived_at timestamptz(3),
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  UNIQUE (id, workspace_id)
);
CREATE INDEX agent_profiles_workspace_idx ON agent_profiles (workspace_id) WHERE archived_at IS NULL;

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  name text NOT NULL,
  description text,
  instructions text NOT NULL,
  profile_id uuid NOT NULL,
  enabled boolean NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  version integer NOT NULL CHECK (version >= 1),
  archived_at timestamptz(3),
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  UNIQUE (id, workspace_id),
  -- An agent's profile must belong to the same workspace.
  FOREIGN KEY (profile_id, workspace_id) REFERENCES agent_profiles (id, workspace_id)
);
CREATE INDEX agents_workspace_idx ON agents (workspace_id) WHERE archived_at IS NULL;

-- Ceiling columns are nullable: a missing key does not restrict that capability.
CREATE TABLE security_policies (
  id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces (id),
  name text NOT NULL,
  scope policy_scope NOT NULL,
  ceil_write boolean,
  ceil_shell boolean,
  ceil_network boolean,
  ceil_delegate boolean,
  ceil_max_delegation_depth integer CHECK (ceil_max_delegation_depth >= 0),
  rules jsonb NOT NULL,
  rules_schema_version integer NOT NULL CHECK (rules_schema_version >= 1),
  locked boolean NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  archived_at timestamptz(3),
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  CHECK ((scope = 'platform') = (workspace_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (workspace_id, name)
);

CREATE TABLE runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  supervisor_agent_id uuid,
  user_prompt text NOT NULL,
  orchestration_mode orchestration_mode NOT NULL,
  status run_status NOT NULL,
  final_output text,
  error text,
  cancel_requested_at timestamptz(3),
  evaluation jsonb,
  -- Per-run RunEvent counter, bumped in the same transaction as the write it describes (decision 9).
  last_event_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  started_at timestamptz(3),
  completed_at timestamptz(3),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (supervisor_agent_id, workspace_id) REFERENCES agents (id, workspace_id)
);
CREATE INDEX runs_workspace_created_idx ON runs (workspace_id, created_at DESC);
CREATE INDEX runs_active_idx ON runs (status) WHERE status NOT IN ('completed', 'failed', 'cancelled');

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs (id),
  parent_task_id uuid,
  created_by_execution_id uuid,
  title text NOT NULL,
  objective text NOT NULL,
  assigned_agent_id uuid REFERENCES agents (id),
  status task_status NOT NULL,
  result text,
  error text,
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  started_at timestamptz(3),
  completed_at timestamptz(3),
  UNIQUE (id, run_id),
  FOREIGN KEY (parent_task_id, run_id) REFERENCES tasks (id, run_id)
);
CREATE INDEX tasks_run_created_idx ON tasks (run_id, created_at, id);

-- Composite keys keep every edge inside one run.
CREATE TABLE task_dependencies (
  run_id uuid NOT NULL,
  task_id uuid NOT NULL,
  depends_on_task_id uuid NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (task_id, run_id) REFERENCES tasks (id, run_id),
  FOREIGN KEY (depends_on_task_id, run_id) REFERENCES tasks (id, run_id)
);
CREATE INDEX task_dependencies_run_idx ON task_dependencies (run_id);

CREATE TABLE agent_executions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  task_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents (id),
  attempt integer NOT NULL CHECK (attempt >= 1),
  status execution_status NOT NULL,
  -- Effective capabilities when the execution launched (decision 3).
  cap_write boolean NOT NULL,
  cap_shell boolean NOT NULL,
  cap_network boolean NOT NULL,
  cap_delegate boolean NOT NULL,
  cap_max_delegation_depth integer NOT NULL CHECK (cap_max_delegation_depth >= 0),
  thread_id text,
  output text,
  error text,
  usage jsonb,
  trace_path text,
  trace_truncated boolean NOT NULL DEFAULT false,
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  started_at timestamptz(3),
  completed_at timestamptz(3),
  UNIQUE (task_id, attempt),
  FOREIGN KEY (task_id, run_id) REFERENCES tasks (id, run_id)
);
CREATE INDEX agent_executions_run_idx ON agent_executions (run_id);

ALTER TABLE tasks ADD FOREIGN KEY (created_by_execution_id) REFERENCES agent_executions (id);

-- Postgres orders enum values by declaration, so ORDER BY severity is info < ... < critical.
CREATE TABLE security_findings (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs (id),
  task_id uuid REFERENCES tasks (id),
  execution_id uuid REFERENCES agent_executions (id),
  agent_id uuid REFERENCES agents (id),
  layer security_layer NOT NULL,
  check_name text NOT NULL, -- Finding.check; "check" is a reserved word
  code text NOT NULL,
  severity finding_severity NOT NULL,
  message text NOT NULL,
  facts jsonb,
  evidence jsonb,
  intervened boolean NOT NULL,
  created_at timestamptz(3) NOT NULL
);
CREATE INDEX security_findings_run_idx ON security_findings (run_id, created_at, id);
CREATE INDEX security_findings_execution_idx ON security_findings (execution_id);

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs (id),
  task_id uuid REFERENCES tasks (id),
  execution_id uuid REFERENCES agent_executions (id),
  agent_id uuid NOT NULL REFERENCES agents (id),
  action_type action_type NOT NULL,
  action_id text,
  reason approval_reason NOT NULL,
  summary text NOT NULL,
  safe_details jsonb,
  status approval_status NOT NULL,
  requested_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3),
  resolved_at timestamptz(3),
  resolved_by_user_id uuid REFERENCES users (id)
);
CREATE INDEX approvals_run_idx ON approvals (run_id);
CREATE INDEX approvals_due_idx ON approvals (expires_at) WHERE status = 'pending';

CREATE TABLE reflections (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents (id),
  code text NOT NULL,
  facts jsonb NOT NULL,
  -- reflectionKey(code, facts) from apps/server/src/reflections.ts.
  dedup_key text NOT NULL,
  first_seen_at timestamptz(3) NOT NULL,
  last_seen_at timestamptz(3) NOT NULL,
  UNIQUE (agent_id, dedup_key)
);

-- run_id and execution_id are null only for rows migrated from the JSON store.
CREATE TABLE reflection_sightings (
  id uuid PRIMARY KEY,
  reflection_id uuid NOT NULL REFERENCES reflections (id),
  run_id uuid REFERENCES runs (id),
  execution_id uuid REFERENCES agent_executions (id),
  thread_id text,
  seen_at timestamptz(3) NOT NULL
);
CREATE INDEX reflection_sightings_reflection_idx ON reflection_sightings (reflection_id);

-- Append-only. event_type is validated against AUDIT_EVENT_TYPES by the shared schema.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces (id),
  actor_type actor_type NOT NULL,
  actor_id uuid,
  event_type text NOT NULL,
  run_id uuid REFERENCES runs (id),
  task_id uuid REFERENCES tasks (id),
  execution_id uuid REFERENCES agent_executions (id),
  metadata jsonb,
  created_at timestamptz(3) NOT NULL,
  CHECK (actor_type = 'system' OR actor_id IS NOT NULL)
);
CREATE INDEX audit_events_workspace_idx ON audit_events (workspace_id, created_at DESC, id);
CREATE INDEX audit_events_run_idx ON audit_events (run_id);

CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
