import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentResponseSchema,
  apiPaths,
  approvalPageSchema,
  auditPageSchema,
  effectivePermissionsResponseSchema,
  findingPageSchema,
  policiesResponseSchema,
  policyResponseSchema,
  profileResponseSchema,
  profilesResponseSchema,
} from "@launchpad/shared";
import type { AgentService } from "../../src/agent-service.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { addUser, addWorkspace, setMember } from "../../src/db/admin.js";
import { openDatabase } from "../../src/db/pool.js";
import { PostgresIdentity } from "../../src/db/postgres-identity.js";
import { insertRow } from "../../src/db/rows.js";

// Evidence and configuration routes with real sign-in, roles and audit rows.
// Needs TEST_DATABASE_URL (see schema.test.ts).

const url = process.env.TEST_DATABASE_URL;
const schema = `test_${randomUUID().replaceAll("-", "")}`;
const PASSWORD = "correct horse battery";

let pool: pg.Pool | undefined;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  if (!url) return;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = await openDatabase({ connectionString: url, options: `-c search_path=${schema}`, max: 8 });
  app = await createApp(loadConfig({ NODE_ENV: "test" }), {} as unknown as AgentService, {
    identity: new PostgresIdentity(pool),
    memberDatabase: pool,
  });
});

afterAll(async () => {
  await app?.close();
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

interface Person {
  id: string;
  email: string;
  headers: { authorization: string };
}

async function person(name: string): Promise<Person> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`;
  const id = await addUser(pool!, { email, name, password: PASSWORD });
  const signedIn = await app!.inject({ method: "POST", url: "/api/auth/session", payload: { email, password: PASSWORD } });
  return { id, email, headers: { authorization: `Bearer ${signedIn.json().token as string}` } };
}

async function workspace() {
  const [admin, developer, auditor, outsider] = await Promise.all([person("Admin"), person("Dev"), person("Auditor"), person("Outsider")]);
  const id = await addWorkspace(pool!, { name: `Project ${randomUUID()}`, sourcePath: null, ownerEmail: admin!.email });
  await setMember(pool!, { workspaceId: id, email: developer!.email, role: "developer" });
  await setMember(pool!, { workspaceId: id, email: auditor!.email, role: "auditor" });
  return { id, admin: admin!, developer: developer!, auditor: auditor!, outsider: outsider! };
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";
const call = (method: Method, target: string, who: Person, payload?: object) =>
  app!.inject({ method, url: target, headers: who.headers, ...(payload === undefined ? {} : { payload }) });

async function agents(workspaceId: string, who: Person) {
  // The agent listing is the run routes', which this app does not mount.
  const { rows } = await pool!.query("SELECT id, name, profile_id, version FROM agents WHERE workspace_id = $1", [workspaceId]);
  expect(who.id).toBeTruthy();
  return rows as Array<{ id: string; name: string; profile_id: string; version: number }>;
}

async function auditTypes(workspaceId: string, who: Person): Promise<string[]> {
  const response = await call("GET", `${apiPaths.workspaceAudit(workspaceId)}?limit=200`, who);
  return auditPageSchema.parse(response.json()).items.map((event) => event.eventType);
}

const specialist = { write: false, shell: false, network: false, delegate: false, maxDelegationDepth: 0 };

describe.skipIf(!url)("workspace configuration", () => {
  it("lets any role read, and hides a workspace from everyone else", async () => {
    const team = await workspace();
    for (const target of [
      apiPaths.workspaceProfiles(team.id),
      apiPaths.workspacePolicies(team.id),
      apiPaths.workspaceFindings(team.id),
      apiPaths.workspaceApprovals(team.id),
      apiPaths.workspaceAudit(team.id),
      apiPaths.workspaceEffectivePermissions(team.id),
    ]) {
      expect((await call("GET", target, team.auditor)).statusCode, target).toBe(200);
      expect((await call("GET", target, team.outsider)).statusCode, target).toBe(404);
    }
  });

  it("shows what each agent may really do once policies apply", async () => {
    const team = await workspace();
    const response = await call("GET", apiPaths.workspaceEffectivePermissions(team.id), team.auditor);
    const permissions = effectivePermissionsResponseSchema.parse(response.json()).agents;
    expect(permissions).toHaveLength(4);
    // The platform baseline denies network whatever a profile says.
    expect(permissions.every((entry) => entry.policy?.capabilities.network === false)).toBe(true);
  });

  it("lets a developer edit an agent, with a version check and an audit row", async () => {
    const team = await workspace();
    const [agent] = await agents(team.id, team.developer);
    const target = apiPaths.workspaceAgent(team.id, agent!.id);

    const updated = await call("PATCH", target, team.developer, { instructions: "Be careful.", expectedVersion: 1 });
    expect(updated.statusCode).toBe(200);
    expect(agentResponseSchema.parse(updated.json()).agent).toMatchObject({ instructions: "Be careful.", version: 2 });

    expect((await call("PATCH", target, team.developer, { instructions: "Stale.", expectedVersion: 1 })).statusCode).toBe(409);
    expect((await call("PATCH", target, team.auditor, { instructions: "No.", expectedVersion: 2 })).statusCode).toBe(403);
    expect(await auditTypes(team.id, team.admin)).toContain("agent.updated");
  });

  it("keeps changing an agent's profile to a Security Admin", async () => {
    const team = await workspace();
    const all = await agents(team.id, team.admin);
    const analyst = all.find((agent) => agent.name === "Analyst")!;
    const developer = all.find((agent) => agent.name === "Developer")!;
    const target = apiPaths.workspaceAgent(team.id, analyst.id);
    const change = { profileId: developer.profile_id, expectedVersion: 1 };

    expect((await call("PATCH", target, team.developer, change)).statusCode).toBe(403);
    expect((await call("PATCH", target, team.admin, change)).statusCode).toBe(200);
  });

  it("refuses a second agent that delegates, which would stop automatic runs", async () => {
    const team = await workspace();
    const supervisor = (await agents(team.id, team.admin)).find((agent) => agent.name === "Supervisor")!;
    const response = await call("POST", apiPaths.workspaceAgents(team.id), team.developer, { name: "Second", profileId: supervisor.profile_id });
    expect(response.statusCode).toBe(409);
  });

  it("refuses a profile from another workspace", async () => {
    const [mine, theirs] = await Promise.all([workspace(), workspace()]);
    const foreign = (await agents(theirs.id, theirs.admin))[0]!;
    const response = await call("POST", apiPaths.workspaceAgents(mine.id), mine.developer, { name: "Spy", profileId: foreign.profile_id });
    expect(response.statusCode).toBe(400);
  });

  it("leaves profiles to a Security Admin, and records capabilities before and after", async () => {
    const team = await workspace();
    const body = { name: "Reader", capabilities: specialist };
    expect((await call("POST", apiPaths.workspaceProfiles(team.id), team.developer, body)).statusCode).toBe(403);

    const created = await call("POST", apiPaths.workspaceProfiles(team.id), team.admin, body);
    expect(created.statusCode).toBe(201);
    const { profile } = profileResponseSchema.parse(created.json());

    const target = apiPaths.workspaceProfile(team.id, profile.id);
    const changed = await call("PATCH", target, team.admin, { capabilities: { ...specialist, shell: true }, expectedVersion: 1 });
    expect(profileResponseSchema.parse(changed.json()).profile.capabilities.shell).toBe(true);

    const events = auditPageSchema.parse((await call("GET", `${apiPaths.workspaceAudit(team.id)}?eventType=profile.updated`, team.auditor)).json()).items;
    expect(events[0]!.metadata).toMatchObject({ capabilitiesBefore: { shell: false }, capabilitiesAfter: { shell: true } });

    expect((await call("DELETE", target, team.admin)).statusCode).toBe(204);
    const profiles = profilesResponseSchema.parse((await call("GET", apiPaths.workspaceProfiles(team.id), team.admin)).json()).profiles;
    expect(profiles.find((entry) => entry.id === profile.id)?.archivedAt).not.toBeNull();
  });

  it("will not archive a profile agents still use", async () => {
    const team = await workspace();
    const agent = (await agents(team.id, team.admin))[0]!;
    expect((await call("DELETE", apiPaths.workspaceProfile(team.id, agent.profile_id), team.admin)).statusCode).toBe(409);
  });

  it("lets a workspace policy require approval, which then shows in effective permissions", async () => {
    const team = await workspace();
    const body = { name: "Every edit asks", capabilityCeiling: { shell: false }, rules: { requireApproval: ["file_change"] } };
    expect((await call("POST", apiPaths.workspacePolicies(team.id), team.developer, body)).statusCode).toBe(403);
    const created = await call("POST", apiPaths.workspacePolicies(team.id), team.admin, body);
    expect(created.statusCode).toBe(201);
    const { policy } = policyResponseSchema.parse(created.json());

    const permissions = () => call("GET", apiPaths.workspaceEffectivePermissions(team.id), team.auditor).then((response) => effectivePermissionsResponseSchema.parse(response.json()).agents);
    const first = (await permissions())[0]!.policy!;
    expect(first.approvalActions).toEqual(["file_change"]);
    expect(first.capabilities.shell).toBe(false);

    // Clearing a ceiling key stops restricting that capability; it is not left behind.
    const cleared = await call("PATCH", apiPaths.workspacePolicy(team.id, policy.id), team.admin, { capabilityCeiling: {}, expectedVersion: 1 });
    expect(policyResponseSchema.parse(cleared.json()).policy.capabilityCeiling).toEqual({});

    expect((await call("DELETE", apiPaths.workspacePolicy(team.id, policy.id), team.admin)).statusCode).toBe(204);
    expect((await permissions())[0]!.policy!.approvalActions).toEqual([]);
  });

  it("refuses a rule nothing would enforce, so it cannot stop every run in the workspace", async () => {
    const team = await workspace();
    const response = await call("POST", apiPaths.workspacePolicies(team.id), team.admin, { name: "Bad", rules: { blockedPaths: [".env"] } });
    expect(response.statusCode).toBe(400);
  });

  it("never lets a workspace change platform policy, or another workspace's", async () => {
    const [team, other] = await Promise.all([workspace(), workspace()]);
    const policies = policiesResponseSchema.parse((await call("GET", apiPaths.workspacePolicies(team.id), team.admin)).json()).policies;
    const platform = policies.find((policy) => policy.scope === "platform")!;
    const target = apiPaths.workspacePolicy(team.id, platform.id);
    expect((await call("PATCH", target, team.admin, { name: "Mine now", expectedVersion: platform.version })).statusCode).toBe(403);
    expect((await call("DELETE", target, team.admin)).statusCode).toBe(403);

    const theirs = policyResponseSchema.parse(
      (await call("POST", apiPaths.workspacePolicies(other.id), other.admin, { name: "Theirs" })).json(),
    ).policy;
    expect((await call("DELETE", apiPaths.workspacePolicy(team.id, theirs.id), team.admin)).statusCode).toBe(404);
  });
});

describe.skipIf(!url)("workspace evidence", () => {
  async function seed() {
    const team = await workspace();
    const agent = (await agents(team.id, team.admin))[0]!;
    const at = (minute: number) => `2026-10-31T10:${String(minute).padStart(2, "0")}:00.000Z`;
    const runId = randomUUID();
    await insertRow(pool!, "runs", {
      id: runId,
      workspaceId: team.id,
      createdByUserId: team.developer.id,
      userPrompt: "Add validation",
      orchestrationMode: "single",
      status: "running",
      lastEventSeq: 0,
      createdAt: at(0),
      updatedAt: at(0),
    });
    for (let minute = 1; minute <= 3; minute += 1) {
      await insertRow(pool!, "security_findings", {
        id: randomUUID(),
        runId,
        layer: "policy",
        check: "capability-policy",
        code: `finding-${minute}`,
        severity: minute === 3 ? "high" : "low",
        message: "Blocked.",
        intervened: true,
        createdAt: at(minute),
      });
      await insertRow(pool!, "approvals", {
        id: randomUUID(),
        runId,
        agentId: agent.id,
        actionType: "command",
        reason: "high_consequence",
        summary: `Run ${minute}`,
        status: minute === 3 ? "pending" : "denied",
        requestedAt: at(minute),
      });
    }
    return team;
  }

  it("pages findings newest first, and filters them", async () => {
    const team = await seed();
    const first = findingPageSchema.parse((await call("GET", `${apiPaths.workspaceFindings(team.id)}?limit=2`, team.auditor)).json());
    expect(first.items.map((finding) => finding.code)).toEqual(["finding-3", "finding-2"]);
    const second = findingPageSchema.parse(
      (await call("GET", `${apiPaths.workspaceFindings(team.id)}?limit=2&cursor=${first.nextCursor!}`, team.auditor)).json(),
    );
    expect(second.items.map((finding) => finding.code)).toEqual(["finding-1"]);
    expect(second.nextCursor).toBeNull();

    const high = findingPageSchema.parse((await call("GET", `${apiPaths.workspaceFindings(team.id)}?severity=high`, team.auditor)).json());
    expect(high.items.map((finding) => finding.code)).toEqual(["finding-3"]);
    expect((await call("GET", `${apiPaths.workspaceFindings(team.id)}?cursor=nonsense`, team.auditor)).statusCode).toBe(400);
  });

  it("lists approvals across runs, saying whose they are", async () => {
    const team = await seed();
    const pending = approvalPageSchema.parse((await call("GET", `${apiPaths.workspaceApprovals(team.id)}?status=pending`, team.auditor)).json());
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]).toMatchObject({ summary: "Run 3", runCreatedByUserId: team.developer.id, taskTitle: null });
  });

  it("does not show one workspace's evidence in another", async () => {
    const [team, other] = await Promise.all([seed(), workspace()]);
    expect(team.id).not.toBe(other.id);
    const empty = findingPageSchema.parse((await call("GET", apiPaths.workspaceFindings(other.id), other.admin)).json());
    expect(empty.items).toEqual([]);
  });
});
