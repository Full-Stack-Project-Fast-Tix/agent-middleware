import type { Agent, FindingSeverity } from "@launchpad/shared";

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={"run-status run-status-" + status}>
      <span className="run-status-dot" />
      {status.replace("_", " ")}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  return <span className={"severity severity-" + severity}>{severity}</span>;
}

export function formatClock(value: string | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

export function formatDuration(from: string | null, to: string | null): string {
  if (from === null) return "not started";
  const end = to === null ? Date.now() : Date.parse(to);
  const seconds = Math.max(0, Math.round((end - Date.parse(from)) / 1000));
  const text = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return to === null ? `${text} so far` : text;
}

/** Agent names for display; falls back to a short id for an agent this page does not know. */
export function agentName(agents: ReadonlyMap<string, Agent>, agentId: string | null): string {
  if (agentId === null) return "Unassigned";
  return agents.get(agentId)?.name ?? `Agent ${agentId.slice(0, 8)}`;
}
