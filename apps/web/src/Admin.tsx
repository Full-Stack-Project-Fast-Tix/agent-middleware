import { useMemo, useState, type ReactNode } from "react";
import { formatWhen } from "./runs/format";
import type { AdminOverview, Agent } from "./types";
import { Button, DataTable, DecisionMark, ForeignInline, Loading, PageHeader } from "./ui";

type Tab = "overview" | "interventions" | "patterns";

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ["overview", "Overview"],
  ["interventions", "Interventions"],
  ["patterns", "Learned patterns"],
];

const labels: Record<string, string> = {
  data_exfiltration: "Data exfiltration",
  security_weakening: "Security weakening",
  scope_expansion: "Scope expansion",
  destructive_divergence: "Destructive divergence",
  persistence: "Persistence",
  oversight_evasion: "Oversight evasion",
  deception: "Deception",
  untrusted_instruction_adoption: "Untrusted instruction adoption",
  runtime_failure: "Runtime enforcement failure",
  timed_out: "Timed out",
};

function label(value: string): string {
  const known = labels[value];
  if (known !== undefined) return known;
  const words = value.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const PATTERN_NOTE = "These only warn and steer. They cannot approve or block an action.";

export function Admin({ overview, agents, agentId, onSelectAgent, onReturnToChat, onViewRun }: {
  overview: AdminOverview | null;
  agents: Agent[];
  /** A selected agent switches the same live report into its operational view. */
  agentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onReturnToChat: (agentId: string) => void;
  onViewRun: (agentId: string, runId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  if (overview === null) {
    return <div className="page"><Loading label="Loading safety records" /></div>;
  }

  const agent = agentId === null ? null : agents.find((item) => item.id === agentId) ?? null;
  if (agent !== null) {
    return <AgentSafety overview={overview} agent={agent} onBack={() => onReturnToChat(agent.id)} onViewRun={onViewRun} />;
  }

  return (
    <div className="page">
      <PageHeader
        title="Safety"
        description="What the guards recorded across single-agent runs: interventions, approvals and learned safety memory. This page only reads."
      />
      <div className="tab-row" role="tablist" aria-label="Safety views">
        {TABS.map(([item, name]) => (
          <button
            key={item}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === item}
            onClick={() => setTab(item)}
          >
            {name}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview overview={overview} agents={agents} onSelectAgent={onSelectAgent} />}
      {tab === "interventions" && <Interventions overview={overview} onViewRun={onViewRun} />}
      {tab === "patterns" && <Patterns overview={overview} />}
    </div>
  );
}

/** Counts as a plain two-column table: the name, then the number. */
function FactTable({ caption, facts }: { caption: string; facts: ReadonlyArray<readonly [string, number]> }) {
  return (
    <DataTable caption={caption}>
      <tbody>
        {facts.map(([name, value]) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td className="num fact-value">{value}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function CategoryTable({ caption, categories }: { caption: string; categories: ReadonlyArray<{ category: string; count: number }> }) {
  return <FactTable caption={caption} facts={categories.map(({ category, count }) => [label(category), count] as const)} />;
}

function Overview({ overview, agents, onSelectAgent }: {
  overview: AdminOverview;
  agents: Agent[];
  onSelectAgent: (agentId: string) => void;
}) {
  const metrics = [
    ["Runs", overview.totals.runs], ["Runs with an intervention", overview.totals.intervenedRuns],
    ["Blocked actions", overview.totals.blockedActions], ["Steered", overview.totals.redirects],
    ["Approval requests", overview.totals.approvalRequests], ["Approved", overview.totals.approvals],
    ["Denied or timed out", overview.totals.denials + overview.totals.timeouts],
    ["Needs attention", overview.totals.needsAttention],
  ] as const;
  return <>
    <div className="safety-columns">
      <section className="page-section">
        <h2>Totals</h2>
        <FactTable caption="Safety totals" facts={metrics} />
      </section>
      <section className="page-section">
        <h2>Intervention categories</h2>
        {overview.categories.length === 0
          ? <p className="meta">No categorized interventions have been recorded.</p>
          : <CategoryTable caption="Interventions by category" categories={overview.categories} />}
      </section>
    </div>
    <section className="page-section">
      <h2>Agent safety</h2>
      <p className="meta">Open an agent to see only its interventions, approvals and learned memory.</p>
      {agents.length === 0 ? <p className="meta">No agents have been created.</p> : (
        <DataTable caption="Safety records by agent">
          <thead><tr><th>Agent</th><th className="wide-only">Description</th><th>Interventions</th><th className="wide-only">Patterns</th><th><span className="sr-only">Open</span></th></tr></thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.id}>
                <td>{agent.name}</td>
                <td className="cell-prompt wide-only">{agent.description || "Coding agent"}</td>
                <td className="num">{overview.interventions.filter((event) => event.agentId === agent.id).length}</td>
                <td className="num wide-only">{overview.learnedPatterns.filter((pattern) => pattern.agentId === agent.id).length}</td>
                <td><Button onClick={() => onSelectAgent(agent.id)} aria-label={`View safety for ${agent.name}`}>View safety</Button></td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </section>
  </>;
}

function AgentSafety({ overview, agent, onBack, onViewRun }: {
  overview: AdminOverview;
  agent: Agent;
  onBack: () => void;
  onViewRun: (agentId: string, runId: string) => void;
}) {
  return (
    <div className="page">
      <PageHeader
        title={agent.name}
        description="This agent only. The Safety page shows every agent."
        actions={<Button onClick={onBack}>Back to {agent.name}</Button>}
      />
      <AgentSafetyDetails overview={overview} agent={agent} onViewRun={onViewRun} />
    </div>
  );
}

/** Live, agent-scoped safety evidence. Reused in the chat-side safety panel. */
export function AgentSafetyDetails({ overview, agent, onViewRun }: {
  overview: AdminOverview;
  agent: Agent;
  onViewRun: (agentId: string, runId: string) => void;
}) {
  const data = useMemo(() => {
    const interventions = overview.interventions.filter((event) => event.agentId === agent.id);
    const patterns = overview.learnedPatterns.filter((pattern) => pattern.agentId === agent.id);
    const human = interventions.filter((event) => event.layer === "human");
    const categories = new Map<string, number>();
    for (const event of interventions) {
      if (event.category !== null) categories.set(event.category, (categories.get(event.category) ?? 0) + 1);
    }
    return {
      interventions,
      patterns,
      categories: [...categories.entries()].map(([category, count]) => ({ category, count })),
      blocked: interventions.filter((event) => event.outcome === "blocked").length,
      redirected: interventions.filter((event) => event.outcome === "redirected").length,
      approvals: human.filter((event) => event.outcome === "approved").length,
      denied: human.filter((event) => event.outcome === "denied" || event.outcome === "timed_out").length,
    };
  }, [agent.id, overview]);
  const metrics = [
    ["Interventions", data.interventions.length], ["Blocked", data.blocked], ["Steered", data.redirected],
    ["Approved actions", data.approvals], ["Denied or timed out", data.denied], ["Learned patterns", data.patterns.length],
  ] as const;

  return <div className="safety-details">
    <section className="page-section">
      <h2>Totals</h2>
      <FactTable caption={`Safety totals for ${agent.name}`} facts={metrics} />
    </section>
    <section className="page-section">
      <h2>What this agent needed help with</h2>
      {data.categories.length === 0
        ? <p className="meta">No categorized interventions have been recorded for this agent.</p>
        : <CategoryTable caption={`Interventions by category for ${agent.name}`} categories={data.categories} />}
    </section>
    <section className="page-section">
      <h2>Intervention history</h2>
      {data.interventions.length === 0
        ? <p className="meta">No interventions have been recorded for this agent.</p>
        : <InterventionList interventions={data.interventions} onViewRun={onViewRun} />}
    </section>
    <section className="page-section">
      <h2>Learned safety memory</h2>
      <p className="meta">{PATTERN_NOTE}</p>
      {data.patterns.length === 0
        ? <p className="meta">No learned patterns have been recorded for this agent.</p>
        : <PatternList patterns={data.patterns} />}
    </section>
  </div>;
}

function Interventions({ overview, onViewRun }: { overview: AdminOverview; onViewRun: (agentId: string, runId: string) => void }) {
  return <section className="page-section">
    <h2>Interventions</h2>
    {overview.interventions.length === 0
      ? <p className="meta">No interventions have been recorded.</p>
      : <InterventionList interventions={overview.interventions} onViewRun={onViewRun} />}
  </section>;
}

function outcomeMark(outcome: AdminOverview["interventions"][number]["outcome"]): ReactNode {
  switch (outcome) {
    case "blocked": return <DecisionMark decision="block" />;
    case "redirected": return <DecisionMark decision="steer" />;
    case "approved": return <DecisionMark decision="allow" label="Approved" />;
    case "denied": return <DecisionMark decision="block" label="Denied" />;
    case "timed_out": return <DecisionMark decision="block" label="Timed out" />;
    case "runtime_failure": return <DecisionMark decision="block" label="Runtime failure" />;
    case "warning": return <span className="badge badge-held">Warning</span>;
  }
}

function InterventionList({ interventions, onViewRun }: { interventions: AdminOverview["interventions"]; onViewRun: (agentId: string, runId: string) => void }) {
  return <ol className="safety-list">{interventions.map((event) => (
    <li className="safety-event" key={event.id}>
      <div className="safety-event-mark">{outcomeMark(event.outcome)}</div>
      <div className="safety-event-body">
        <p>{event.summary}</p>
        <div className="cluster meta">
          <span>{event.agentName}</span>
          <time dateTime={event.at}>{formatWhen(event.at)}</time>
          <span>{label(event.layer)} layer</span>
          {event.category && <span>{label(event.category)}</span>}
        </div>
      </div>
      <Button onClick={() => onViewRun(event.agentId, event.runId)}>View run</Button>
    </li>
  ))}</ol>;
}

function Patterns({ overview }: { overview: AdminOverview }) {
  return <section className="page-section">
    <h2>Learned patterns</h2>
    <p className="meta">{PATTERN_NOTE}</p>
    {overview.learnedPatterns.length === 0
      ? <p className="meta">No learned patterns have been recorded.</p>
      : <PatternList patterns={overview.learnedPatterns} />}
  </section>;
}

function PatternList({ patterns }: { patterns: AdminOverview["learnedPatterns"] }) {
  return <ul className="safety-list">{patterns.map((pattern, index) => (
    <li className="safety-pattern" key={`${pattern.agentId}:${pattern.value}:${index}`}>
      <div className="cluster">
        <ForeignInline>{pattern.value}</ForeignInline>
        {pattern.recurring && <span className="badge">Recurring</span>}
        {pattern.needsAttention && <span className="badge badge-held">Needs attention</span>}
      </div>
      <p>{pattern.effect}</p>
      <div className="cluster meta">
        <span>{pattern.agentName}</span>
        <span>Watches a {pattern.subjectType}{pattern.derivedFamily ? ", derived family" : ""}</span>
        <span>Precondition: {pattern.precondition}</span>
        {pattern.channel && <span>Channel: {pattern.channel}</span>}
        <span>{pattern.sightings} sighting{pattern.sightings === 1 ? "" : "s"}</span>
        {pattern.conversations !== null && <span>{pattern.conversations} conversation{pattern.conversations === 1 ? "" : "s"}</span>}
      </div>
    </li>
  ))}</ul>;
}
