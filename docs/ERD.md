# Data model

The PostgreSQL schema from `apps/server/migrations/`. Field-level meaning lives in
`packages/shared/src`, and the reasons in `docs/contract-decisions.md`.

```mermaid
erDiagram
    users ||--o{ sessions : "signs in with"
    users ||--o{ workspace_members : "holds a role through"
    workspaces ||--o{ workspace_members : has
    workspaces ||--o{ agent_profiles : owns
    workspaces ||--o{ agents : owns
    workspaces |o--o{ security_policies : "scopes (null means platform)"
    agent_profiles ||--o{ agents : "limits"
    workspaces ||--o{ runs : contains
    users ||--o{ runs : starts
    agents |o--o{ runs : supervises
    runs ||--o{ tasks : "breaks into"
    tasks ||--o{ task_dependencies : "waits through"
    tasks |o--o{ tasks : "parent of"
    agents |o--o{ tasks : "assigned to"
    tasks ||--o{ agent_executions : "attempted by"
    agents ||--o{ agent_executions : runs
    runs ||--o{ security_findings : records
    agent_executions |o--o{ security_findings : raises
    runs ||--o{ approvals : records
    agent_executions |o--o{ approvals : holds
    users |o--o{ approvals : resolves
    agents ||--o{ reflections : remembers
    reflections ||--o{ reflection_sightings : "seen in"
    workspaces |o--o{ audit_events : logs
    runs |o--o{ audit_events : logs

    workspace_members {
        uuid workspace_id PK
        uuid user_id PK
        enum role "developer, security_admin, auditor"
    }
    agent_profiles {
        uuid id PK
        boolean cap_write
        boolean cap_shell
        boolean cap_network
        boolean cap_delegate
        int cap_max_delegation_depth
        int version
    }
    security_policies {
        uuid id PK
        enum scope "platform, workspace"
        boolean ceil_write "null means no limit"
        jsonb rules "policyRulesSchema"
        boolean locked
        int version
    }
    runs {
        uuid id PK
        text user_prompt
        enum status
        bigint last_event_seq
    }
    tasks {
        uuid id PK
        enum status
        text result
        text error
    }
    agent_executions {
        uuid id PK
        int attempt
        enum status
        jsonb usage
        text trace_path "raw trace stays outside SQL"
    }
    approvals {
        uuid id PK
        enum reason
        jsonb safe_details "redacted, bounded"
        enum status
        timestamptz expires_at
    }
    audit_events {
        uuid id PK
        text event_type
        jsonb metadata "ids and summaries, append-only"
    }
```

Rules the diagram cannot show:

- Composite keys and triggers keep a Run's tasks, executions, findings and approvals
  inside that Run, and its agents inside its workspace.
- A trigger makes `audit_events` append-only for the application.
- Agents, profiles and policies are archived, never deleted, so evidence can still
  name them.
- `reflections` and `reflection_sightings` exist but are not yet read or written.
