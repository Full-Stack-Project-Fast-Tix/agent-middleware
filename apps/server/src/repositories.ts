import type { Agent, AgentRun, Database } from "./types.js";
import type { JsonStore } from "./store.js";

/** Persistence ports used by business logic. Implementations may be JSON, SQL, or remote. */
export interface AgentRepository {
  list(): Agent[];
  get(id: string): Agent | undefined;
}
export interface RunRepository {
  listByAgent(agentId: string): AgentRun[];
  get(id: string): AgentRun | undefined;
}
export interface FindingRepository {
  listForRun(runId: string): NonNullable<AgentRun["findings"]>;
}

/** Transitional adapters over the current atomic JSON store. */
export class JsonAgentRepository implements AgentRepository {
  constructor(private readonly store: JsonStore) {}
  list(): Agent[] { return this.store.snapshot().agents; }
  get(id: string): Agent | undefined { return this.list().find((agent) => agent.id === id); }
}
export class JsonRunRepository implements RunRepository {
  constructor(private readonly store: JsonStore) {}
  listByAgent(agentId: string): AgentRun[] { return this.store.snapshot().runs.filter((run) => run.agentId === agentId); }
  get(id: string): AgentRun | undefined { return this.store.snapshot().runs.find((run) => run.id === id); }
}
export class JsonFindingRepository implements FindingRepository {
  constructor(private readonly runs: RunRepository) {}
  listForRun(runId: string): NonNullable<AgentRun["findings"]> { return this.runs.get(runId)?.findings ?? []; }
}

/** Narrow read-only snapshot seam for future database implementations. */
export interface DatabaseSnapshotReader {
  snapshot(): Database;
}
