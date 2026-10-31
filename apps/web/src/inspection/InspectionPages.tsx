import { useEffect, useState, type ReactNode } from "react";
import type { AgentCapabilities, WorkspaceAuditItem, WorkspaceConfiguration } from "@launchpad/shared";
import { Button, EmptyState, ErrorState, Loading, PageHeader } from "../ui";
import { useCurrentWorkspace } from "../useCurrentWorkspace";
import { WorkspaceRequired } from "../runs/RunsPage";
import { inspectionApi } from "./inspection-api";
import "./inspection.css";

function useConfiguration(workspaceId: string) {
  const [data, setData] = useState<WorkspaceConfiguration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    void inspectionApi.configuration(workspaceId).then((result) => {
      if (live) setData(result);
    }).catch((reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { live = false; };
  }, [workspaceId, reload]);
  return { data, error, retry: () => setReload((n) => n + 1) };
}

function ConfigPage({ workspaceId, title, description, children }: {
  workspaceId: string; title: string; description: string;
  children: (data: WorkspaceConfiguration) => ReactNode;
}) {
  const { data, error, retry } = useConfiguration(workspaceId);
  return <div className="page inspection-page"><PageHeader title={title} description={description} />
    {error ? <ErrorState title={`${title} could not be loaded`} message={error} onRetry={retry} />
      : data === null ? <Loading label={`Loading ${title.toLowerCase()}`} /> : children(data)}
  </div>;
}

function capabilities(c: AgentCapabilities) {
  return `Write ${yes(c.write)} · Shell ${yes(c.shell)} · Network ${yes(c.network)} · Delegate ${yes(c.delegate)} · Depth ${c.maxDelegationDepth}`;
}
const yes = (value: boolean) => value ? "on" : "off";

export function AgentsPage() {
  return <WorkspaceRequired>{(workspaceId) => <ConfigPage workspaceId={workspaceId} title="Agents" description="Registered agents, their assigned profiles, and available capability settings.">
    {(data) => data.agents.length === 0 ? <EmptyState title="No agents configured">Agents will appear here when they are registered in this workspace.</EmptyState> :
      <div className="inspection-list">{data.agents.map((agent) => {
        const profile = data.profiles.find((candidate) => candidate.id === agent.profileId);
        return <article className="inspection-panel" key={agent.id}>
          <div className="inspection-heading"><h2>{agent.name}</h2><span className="inspection-tag">{agent.archivedAt ? "Archived" : agent.enabled ? "Enabled" : "Disabled"}</span></div>
          <p>{agent.description || "No description provided."}</p>
          <p className="inspection-meta">Profile: {profile?.name ?? "Unavailable"} · Version {agent.version}</p>
          {profile && <p className="inspection-meta">Profile capabilities: {capabilities(profile.capabilities)}</p>}
          <details><summary>Agent instructions</summary><pre>{agent.instructions || "No instructions."}</pre></details>
        </article>;
      })}</div>}
  </ConfigPage>}</WorkspaceRequired>;
}

export function PoliciesPage() {
  return <WorkspaceRequired>{(workspaceId) => <ConfigPage workspaceId={workspaceId} title="Policies" description="Active platform and workspace ceilings, with agent profile capabilities. Values shown are configuration inputs; the server remains authoritative for effective permissions.">
    {(data) => <>
      {data.policies.length === 0 && <EmptyState title="No active policies">No active policy records were returned for this workspace.</EmptyState>}
      <div className="inspection-list">{data.policies.map((policy) => <article className="inspection-panel" key={policy.id}>
        <div className="inspection-heading"><h2>{policy.name}</h2><span className="inspection-tag">{policy.scope}{policy.locked ? " · locked" : ""}</span></div>
        <p className="inspection-meta">Version {policy.version} · Rules schema v{policy.rulesSchemaVersion}</p>
        <dl className="inspection-capabilities">{(["write", "shell", "network", "delegate", "maxDelegationDepth"] as const).map((key) => <div key={key}><dt>{key}</dt><dd>{policy.capabilityCeiling[key] === undefined ? "No ceiling" : String(policy.capabilityCeiling[key])}</dd></div>)}</dl>
        {Object.keys(policy.rules).length > 0 && <p className="notice notice-held">This policy has rules that are not rendered here. The UI does not interpret rule semantics.</p>}
      </article>)}</div>
      <h2>Profiles</h2>
      {data.profiles.length === 0 ? <p>No profiles configured.</p> : <div className="inspection-list">{data.profiles.map((profile) => <article className="inspection-panel" key={profile.id}><div className="inspection-heading"><h3>{profile.name}</h3><span className="inspection-tag">{profile.archivedAt ? "Archived" : `v${profile.version}`}</span></div><p>{profile.description || "No description provided."}</p><p className="inspection-meta">{capabilities(profile.capabilities)}</p></article>)}</div>}
      <h2>Effective capability projection</h2>
      <p className="inspection-meta">Computed from profile flags and active capability ceilings using the server's AND/minimum rule. Unsupported policy rules make the server fail closed, so no projection is shown in that case.</p>
      {data.agents.filter((agent) => agent.enabled && agent.archivedAt === null).map((agent) => {
        const profile = data.profiles.find((candidate) => candidate.id === agent.profileId && candidate.archivedAt === null);
        const supported = data.policies.some((policy) => policy.scope === "platform") && data.policies.every((policy) => policy.rulesSchemaVersion === 1 && Object.keys(policy.rules).length === 0);
        if (!profile || !supported) return <p className="inspection-meta" key={agent.id}>{agent.name}: effective permissions unavailable (profile or policy rules unsupported).</p>;
        const ceilings = data.policies.map((policy) => policy.capabilityCeiling);
        const effective: AgentCapabilities = {
          write: profile.capabilities.write && ceilings.every((ceiling) => ceiling.write !== false),
          shell: profile.capabilities.shell && ceilings.every((ceiling) => ceiling.shell !== false),
          network: profile.capabilities.network && ceilings.every((ceiling) => ceiling.network !== false),
          delegate: profile.capabilities.delegate && ceilings.every((ceiling) => ceiling.delegate !== false),
          maxDelegationDepth: Math.min(profile.capabilities.maxDelegationDepth, ...ceilings.map((ceiling) => ceiling.maxDelegationDepth ?? Number.POSITIVE_INFINITY)),
        };
        if (!effective.delegate) effective.maxDelegationDepth = 0;
        return <article className="inspection-panel" key={agent.id}><h3>{agent.name}</h3><p className="inspection-meta">{capabilities(effective)}</p></article>;
      })}
    </>}
  </ConfigPage>}</WorkspaceRequired>;
}

const EVENT_LABEL: Record<string, string> = {
  "run.created": "Run created", "run.status_changed": "Run status changed", "task.created": "Task created", "task.status_changed": "Task status changed",
  "execution.started": "Execution started", "execution.finished": "Execution finished", "delegation.requested": "Delegation requested", "security.decision": "Security decision",
  "approval.requested": "Approval requested", "approval.resolved": "Approval resolved", "run.cancel_requested": "Run cancellation requested", "policy.created": "Policy created",
  "policy.updated": "Policy updated", "policy.archived": "Policy archived", "profile.created": "Profile created", "profile.updated": "Profile updated", "profile.archived": "Profile archived",
  "agent.created": "Agent created", "agent.updated": "Agent updated", "agent.archived": "Agent archived", "member.added": "Member added", "member.role_changed": "Member role changed",
  "member.removed": "Member removed", "user.created": "User created", "workspace.created": "Workspace created",
};

function AuditList({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<WorkspaceAuditItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    void inspectionApi.audit(workspaceId).then((page) => {
      if (live) { setItems(page.items); setCursor(page.nextCursor); }
    }).catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [workspaceId, generation]);
  const more = async () => {
    if (!cursor) return;
    try { const page = await inspectionApi.audit(workspaceId, cursor); setItems((old) => [...old, ...page.items]); setCursor(page.nextCursor); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  if (loading) return <Loading label="Loading audit history" />;
  if (error) return <ErrorState title="Audit history could not be loaded" message={error} onRetry={() => setGeneration((n) => n + 1)} />;
  if (!items.length) return <EmptyState title="No workspace audit events">Events will appear as workspace activity is recorded.</EmptyState>;
  return <><div className="inspection-audit">{items.map((item) => <article key={item.id} className="inspection-audit-row"><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time><strong>{EVENT_LABEL[item.eventType] ?? item.eventType}</strong><span>{item.actorType}{item.actorId ? ` · ${item.actorId.slice(0, 8)}` : ""}</span><span>{item.runId ? `Run ${item.runId.slice(0, 8)}` : "Workspace"}</span></article>)}</div>{cursor && <Button onClick={() => void more()}>Load older events</Button>}</>;
}

export function AuditPage() {
  return <WorkspaceRequired>{(workspaceId) => <div className="page inspection-page"><PageHeader title="Audit" description="Append-only workspace event history. Event metadata and raw traces are not exposed in this view." /><AuditList workspaceId={workspaceId} /></div>}</WorkspaceRequired>;
}

export function BenchmarksPage() {
  const { current } = useCurrentWorkspace();
  return <div className="page inspection-page"><PageHeader title="Benchmarks" description="Evaluation evidence committed with this repository. These are recorded runs, not live measurements of this workspace." />
    <section className="inspection-panel"><div className="inspection-heading"><h2>Leash security replay</h2><span className="inspection-tag">Recorded · 31 Aug 2026</span></div>
      <p>12 replay-scored runs across 8 scenarios, with up to one trial per cell. In the recorded slice, guards were off for 3 attack runs: 1 leaked. With guards on, 0 of 4 leaked and 3 were blocked. No guard interruption occurred in the 3 benign runs; all 3 completed the task.</p>
      <p className="inspection-meta">This is a small replay slice. Detection and time-to-catch are counterfactual; replay cannot establish containment or model refusal rates. Read the counts, not percentages.</p>
    </section>
    <section className="inspection-panel"><div className="inspection-heading"><h2>Orchestration evaluation</h2><span className="inspection-tag">Reproducible harness</span></div>
      <p>Seeded correctness fuzzing and simulated HTTP load measurements cover in-memory and PostgreSQL stores. They exercise lifecycle, approvals, retries, cancellation, concurrency, and event invariants.</p>
      <p className="inspection-meta">The load harness uses simulated planners and agents. There is no published live-model, container-backed multi-agent efficacy result. Nothing here runs a benchmark or makes provider calls.</p>
    </section>
    <p className="inspection-meta">Workspace: {current?.name ?? "No workspace selected"}. Benchmark results are repository-wide evidence and are not attributed to this workspace.</p>
  </div>;
}
