import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUN_TIMELINE_MAX_ENTRIES, runTimelineSchema, type RunEvent } from "@launchpad/shared";
import { openDatabase } from "../../src/db/pool.js";
import { PostgresRunStore } from "../../src/db/postgres-run-store.js";
import { createDemoRuns, DEMO_USER_ID, DEMO_WORKSPACE, seedDemo } from "../../src/dev/demo-runs.js";
import { RunEventHub } from "../../src/run-events.js";
import { buildRunTimeline } from "../../src/run-timeline.js";
import { makeRun } from "../integration/harness/factories.js";
import { checkRunInvariants } from "../integration/harness/invariants.js";

// What index.ts does with DATABASE_URL and RUNS_DEMO set: migrate, seed, run
// the demo on PostgresRunStore, and close what a restart left active.

const url = process.env.TEST_DATABASE_URL;
const schema = `test_${randomUUID().replaceAll("-", "")}`;
let pool: pg.Pool | undefined;

beforeAll(async () => {
  if (!url) return;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = await openDatabase({ connectionString: url, options: `-c search_path=${schema}`, max: 5 });
});

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

describe.skipIf(!url)("RUNS_DEMO on Postgres", () => {
  it("seeds idempotently and completes the demo run", async () => {
    await seedDemo(pool!);
    await seedDemo(pool!);
    const hub = new RunEventHub();
    const demo = createDemoRuns(hub, { pauseScale: 0, store: new PostgresRunStore(pool!, hub) });
    const run = await demo.orchestrator.createRun({
      workspaceId: DEMO_WORKSPACE.id,
      createdByUserId: DEMO_USER_ID,
      userPrompt: "Add input validation to the checkout endpoint",
      orchestrationMode: "auto",
    });
    const events: RunEvent[] = [];
    hub.subscribe(run.id, 0, { onEvent: (event) => events.push(event), onResync: () => undefined });

    for (let tries = 0; tries < 400; tries += 1) {
      const pending = (await demo.store.listApprovals(run.id)).find((approval) => approval.status === "pending");
      if (pending) {
        await demo.orchestrator.resolveApproval(pending.id, "approve", DEMO_USER_ID);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await demo.orchestrator.whenSettled(run.id);

    const snapshot = (await demo.store.snapshot(run.id))!;
    expect(checkRunInvariants(run.id, events, snapshot)).toEqual([]);
    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.run.finalOutput).toContain("ready for review");

    // What the Dashboard and Run Detail read, from the rows that run saved.
    const listed = await demo.routes.listRuns(DEMO_WORKSPACE.id, {});
    expect(listed.pendingApprovalCount).toBe(0);
    expect(listed.runs.find((summary) => summary.id === run.id)).toMatchObject({
      status: "completed",
      taskCount: snapshot.tasks.length,
      pendingApprovalCount: 0,
      findingCount: snapshot.findings.length,
    });
    const [decisions, delegations] = await Promise.all([
      demo.routes.runAudit(run.id, "security.decision", RUN_TIMELINE_MAX_ENTRIES),
      demo.routes.runAudit(run.id, "delegation.requested", RUN_TIMELINE_MAX_ENTRIES),
    ]);
    const { entries, omittedEntries } = runTimelineSchema.parse(
      buildRunTimeline({
        decisions: decisions.events,
        omittedDecisions: decisions.total - decisions.events.length,
        delegations: delegations.events,
        approvals: snapshot.approvals,
      }),
    );
    expect(omittedEntries).toBe(0);
    expect(entries).toHaveLength(decisions.total);
    const approved = entries.find((entry) => entry.approval !== null);
    expect(approved?.approval?.status).toBe("approved");
    expect(approved?.proposed).not.toBeNull();
    expect(entries.filter((entry) => entry.actionType === "delegation").every((entry) => entry.proposed?.type === "delegation")).toBe(true);
  });

  it("fails a run the previous process left active", async () => {
    const hub = new RunEventHub();
    const store = new PostgresRunStore(pool!, hub);
    const run = await store.createRun(
      makeRun({ workspaceId: DEMO_WORKSPACE.id, createdByUserId: DEMO_USER_ID, status: "running", startedAt: new Date().toISOString() }),
    );

    const restarted = createDemoRuns(hub, { pauseScale: 0, store });
    expect(await restarted.orchestrator.recoverInterruptedRuns()).toBe(1);
    expect((await store.getRun(run.id))?.status).toBe("failed");
  });
});
