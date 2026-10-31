import { useState } from "react";
import { AUDIT_EVENT_TYPES, FINDING_SEVERITIES, type WorkspaceSummary } from "@launchpad/shared";
import { formatWhen, humanize } from "../runs/format";
import { Link, paths } from "../router";
import { Button, DataTable, EmptyState, ErrorState, Foreign, Loading, Select, SeverityBadge } from "../ui";
import { usePaged, WorkspacePage } from "./shared";
import { workspaceApi } from "./workspace-api";

const ANY = "any";
const SEVERITY_OPTIONS = [{ value: ANY, label: "Any severity" }, ...FINDING_SEVERITIES.map((severity) => ({ value: severity, label: humanize(severity) }))];
const EVENT_OPTIONS = [{ value: ANY, label: "Any event" }, ...AUDIT_EVENT_TYPES.map((type) => ({ value: type, label: type }))];

function Findings({ workspace }: { workspace: WorkspaceSummary }) {
  const [severity, setSeverity] = useState(ANY);
  const list = usePaged(`${workspace.id}:${severity}`, (cursor) =>
    workspaceApi.findings(workspace.id, { ...(severity === ANY ? {} : { severity }), ...(cursor === undefined ? {} : { cursor }) }),
  );
  return (
    <section className="page-section">
      <h2>Findings</h2>
      <div className="config-filters"><Select label="Severity" inlineLabel value={severity} onChange={setSeverity} options={SEVERITY_OPTIONS} /></div>
      {list.items === null ? (
        list.error !== null ? <ErrorState message={list.error} onRetry={() => void list.reload()} /> : <Loading label="Loading findings" />
      ) : list.items.length === 0 ? (
        <EmptyState title="No findings">What the security checks notice during a run appears here.</EmptyState>
      ) : (
        <DataTable caption="Security findings">
          <thead><tr><th>When</th><th>Severity</th><th>What</th><th>Check</th><th>Stopped it</th><th>Run</th></tr></thead>
          <tbody>
            {list.items.map((finding) => (
              <tr key={finding.id}>
                <td className="num">{formatWhen(finding.createdAt)}</td>
                <td><SeverityBadge severity={finding.severity} /></td>
                <td>{finding.message}</td>
                <td>{humanize(finding.layer)}: {finding.code}</td>
                <td>{finding.intervened ? "Yes" : "No"}</td>
                <td><Link to={paths.run(finding.runId)}>Open</Link></td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {list.hasMore && <p className="see-all"><Button busy={list.loadingMore} onClick={() => void list.loadMore()}>Load more</Button></p>}
    </section>
  );
}

function AuditHistory({ workspace }: { workspace: WorkspaceSummary }) {
  const [eventType, setEventType] = useState(ANY);
  const list = usePaged(`${workspace.id}:${eventType}`, (cursor) =>
    workspaceApi.audit(workspace.id, { ...(eventType === ANY ? {} : { eventType }), ...(cursor === undefined ? {} : { cursor }) }),
  );
  return (
    <section className="page-section">
      <h2>Audit history</h2>
      <p className="meta">Append-only: nothing here can be changed or removed.</p>
      <div className="config-filters"><Select label="Event" inlineLabel value={eventType} onChange={setEventType} options={EVENT_OPTIONS} /></div>
      {list.items === null ? (
        list.error !== null ? <ErrorState message={list.error} onRetry={() => void list.reload()} /> : <Loading label="Loading audit history" />
      ) : list.items.length === 0 ? (
        <EmptyState title="No audit events">Nothing of this type has happened in this workspace.</EmptyState>
      ) : (
        <DataTable caption="Audit history">
          <thead><tr><th>When</th><th>Event</th><th>By</th><th>Details</th></tr></thead>
          <tbody>
            {list.items.map((event) => (
              <tr key={event.id}>
                <td className="num">{formatWhen(event.createdAt)}</td>
                <td>{event.eventType}{event.runId !== null && <> <Link to={paths.run(event.runId)}>Open run</Link></>}</td>
                <td>{event.actorType === "system" ? "System" : `${humanize(event.actorType)} ${event.actorId!.slice(0, 8)}`}</td>
                <td>{event.metadata !== null && <Foreign preformatted maxHeight={120}>{JSON.stringify(event.metadata, null, 2)}</Foreign>}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {list.hasMore && <p className="see-all"><Button busy={list.loadingMore} onClick={() => void list.loadMore()}>Load more</Button></p>}
    </section>
  );
}

export function SecurityPage() {
  return (
    <WorkspacePage title="Security" description="What the checks found across this workspace's runs, and the full record of what happened.">
      {(workspace) => (
        <>
          <Findings workspace={workspace} />
          <AuditHistory workspace={workspace} />
        </>
      )}
    </WorkspacePage>
  );
}
