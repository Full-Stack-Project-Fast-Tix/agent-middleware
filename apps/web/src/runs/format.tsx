import type { Agent } from "@launchpad/shared";
import { ForeignInline } from "../ui";

export { SeverityBadge, StatusBadge } from "../ui";

/** A task's title. A planner wrote a delegated task's title, so it must not read as a system statement. */
export function TaskName({ title, writtenByPlan }: { title: string; writtenByPlan: boolean }) {
  return writtenByPlan ? <ForeignInline>{title}</ForeignInline> : <>{title}</>;
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

/** A date and time for tables, where runs can be days old. */
export function formatWhen(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

/** "file_change" reads "File change". */
export function humanize(value: string): string {
  const words = value.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Agent names for display; falls back to a short id for an agent this page does not know. */
export function agentName(agents: ReadonlyMap<string, Agent>, agentId: string | null): string {
  if (agentId === null) return "Unassigned";
  return agents.get(agentId)?.name ?? `Agent ${agentId.slice(0, 8)}`;
}
