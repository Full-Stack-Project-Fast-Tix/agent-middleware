// Drives one Codex turn for an AgentExecution, with every gated action decided
// by the security middleware through the orchestrator's ActionGate.
//
// This is the multi-agent counterpart of run-turn.ts. That file holds the
// legacy single-agent enforcement itself (checks, strike counting, human
// approval). Here none of that lives in the runtime: the guard keeps that state
// (docs/contract-decisions.md, decision 1), and this file only carries its
// decisions onto the wire:
//
//   approval request     -> gate.decide(action)
//     allow              -> accept
//     steer              -> steer, then accept
//     block, action      -> decline, then the guard's steer if it gave one
//     block, execution   -> decline and interrupt the turn
//   every trace record   -> gate.observe(record), in order
//     steer              -> steer once no command is running
//     block, execution   -> interrupt the turn
//
// It fails closed. A gate that throws declines the action and ends the turn. An
// action it cannot describe is declined. It refuses to start at all unless the
// runtime policy makes every non-read action stop at an approval request.

import type { ExecutionUsage, FileChange, ProposedAction, SecurityDecision } from "@launchpad/shared";
import { commandsOf, fileChangesOf } from "./checks.js";
import type { JsonRpcConnection } from "./codex-app-server-client.js";
import { RunCancelledError } from "./errors.js";
import type { ActionGate } from "./orchestrator/ports.js";
import { buildSandboxPolicy, openThread, readTurnError, readUsage } from "./run-turn.js";
import type { TraceRecord } from "./trace.js";
import type { TurnSecurityPolicy } from "./turn-security-policy.js";

export interface GatedTurnOptions {
  rpc: JsonRpcConnection;
  prompt: string;
  /** From the middleware's resolved policy. Must pass assertGatedPolicy. */
  policy: TurnSecurityPolicy;
  gate: ActionGate;
  /** The live trace of this session. */
  records: TraceRecord[];
  onRecord(listener: (record: TraceRecord) => void): void;
  /** Rejects when the container exits. */
  exited: Promise<never>;
  signal: AbortSignal;
}

export interface GatedTurnOutcome {
  /** The agent's last message, or "" if it sent none. */
  output: string;
  threadId: string | null;
  usage: ExecutionUsage | null;
  /** The middleware ended the execution. */
  stopped: boolean;
}

export class UngatedRuntimePolicyError extends Error {
  constructor(policy: TurnSecurityPolicy) {
    super(
      "Refusing to run an execution whose actions would not reach the security middleware: " +
        `sandbox ${policy.sandboxMode}, approval policy ${JSON.stringify(policy.approvalPolicy ?? null)}. ` +
        'Only "workspace-write" with "untrusted" exposes file changes while requiring non-read actions to wait for approval.',
    );
    this.name = "UngatedRuntimePolicyError";
  }
}

/**
 * Under any other combination some actions run without an approval request,
 * so evaluate() would never see them (turn-security-policy.ts). The middleware
 * chooses the policy; this only refuses one that would bypass it.
 */
export function assertGatedPolicy(policy: TurnSecurityPolicy): void {
  if (policy.sandboxMode !== "workspace-write" || policy.approvalPolicy !== "untrusted") {
    throw new UngatedRuntimePolicyError(policy);
  }
}

export async function runGatedTurn(options: GatedTurnOptions): Promise<GatedTurnOutcome> {
  assertGatedPolicy(options.policy);
  if (options.signal.aborted) throw new RunCancelledError();
  const { rpc, gate, policy } = options;

  const messages: string[] = [];
  let usage: ExecutionUsage | null = null;
  let turnFailure: string | null = null;
  /** A gate failure; reported once the turn has ended. */
  let failure: unknown = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let stopped = false;
  let interruptSent = false;

  // Commands and file changes started but not completed. Pinned app-server
  // 0.111.0 can accept a steer sent while a command runs and then fail to
  // resume the turn (run-turn.ts), so observed steers wait until none is running.
  const running = new Set<string>();
  const pendingSteers: string[] = [];
  const approvedFileChanges = new Set<string>();

  // Observations and decisions run one at a time, in trace order, so an action
  // is decided only after every record before it has been observed.
  let queue: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };

  const sendSteer = (text: string): void => {
    if (threadId === null || turnId === null) {
      pendingSteers.push(text);
      return;
    }
    void rpc
      .request("turn/steer", { threadId, input: [{ type: "text", text }], expectedTurnId: turnId })
      .catch(() => undefined);
  };
  const deliverSteer = (text: string): void => {
    if (running.size === 0) sendSteer(text);
    else pendingSteers.push(text);
  };
  const flushSteers = (): void => {
    if (running.size > 0 || turnId === null) return;
    for (const text of pendingSteers.splice(0)) sendSteer(text);
  };
  const interrupt = (): void => {
    if (interruptSent || threadId === null || turnId === null) return;
    interruptSent = true;
    void rpc.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
  };
  const stop = (): void => {
    stopped = true;
    interrupt();
  };
  const failClosed = (error: unknown): void => {
    failure ??= error;
    stop();
  };

  options.onRecord((record) => {
    trackRunning(record, running);
    if (record.dir === "in" && record.method === "item/completed") {
      const item = (record.payload as { params?: { item?: { id?: unknown; type?: unknown; status?: unknown } } } | null)?.params?.item;
      if (
        item?.type === "fileChange" &&
        item.status === "completed" &&
        typeof item.id === "string" &&
        !approvedFileChanges.has(item.id)
      ) {
        failClosed(new Error("Codex completed a file change without a middleware approval request"));
      }
    }
    flushSteers();
    void inOrder(async () => {
      const decision = await gate.observe(record);
      if (decision !== null) applyObserved(decision);
    }).catch(failClosed);
  });

  function applyObserved(decision: SecurityDecision): void {
    if (decision.outcome === "steer") deliverSteer(decision.steer);
    if (decision.outcome !== "block") return;
    if (decision.stop === "execution") stop();
    else if (decision.steer !== null) deliverSteer(decision.steer);
  }

  const onApproval = (kind: "command" | "file_change") => async (params: Record<string, unknown>, id: number | string) => {
    const action = proposedActionOf(kind, params, options.records, id);
    if (action === null) {
      // Nothing the middleware could judge; refusing is the only safe answer.
      rpc.reply(id, { decision: "decline" });
      return;
    }
    let decision: SecurityDecision;
    try {
      decision = await inOrder(() => gate.decide(action));
    } catch (error) {
      rpc.reply(id, { decision: "decline" });
      failClosed(error);
      return;
    }
    switch (decision.outcome) {
      case "allow":
        if (kind === "file_change") approvedFileChanges.add(action.actionId);
        rpc.reply(id, { decision: "accept" });
        return;
      case "steer":
        if (kind === "file_change") approvedFileChanges.add(action.actionId);
        sendSteer(decision.steer);
        rpc.reply(id, { decision: "accept" });
        return;
      case "block":
        rpc.reply(id, { decision: "decline" });
        if (decision.stop === "execution") stop();
        else if (decision.steer !== null) sendSteer(decision.steer);
        return;
      case "require_approval":
        // The gate resolves approvals before returning; this would be a bug there.
        rpc.reply(id, { decision: "decline" });
        failClosed(new Error("The action gate returned an unresolved require_approval decision"));
    }
  };
  rpc.onRequest("item/commandExecution/requestApproval", onApproval("command"));
  rpc.onRequest("item/fileChange/requestApproval", onApproval("file_change"));

  rpc.on("item/completed", (params) => {
    const item = params.item as Record<string, unknown> | undefined;
    if (item?.type === "agentMessage" && typeof item.text === "string") messages.push(item.text);
  });
  rpc.on("thread/tokenUsage/updated", (params) => {
    usage = readUsage(params);
  });
  rpc.on("error", (params) => {
    const detail = params.error as { message?: string } | undefined;
    if (detail?.message !== undefined) turnFailure = detail.message;
  });
  const turnFinished = new Promise<Record<string, unknown>>((resolve) => rpc.on("turn/completed", resolve));

  const onAbort = (): void => interrupt();
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "agents_on_a_leash", title: "Agents on a Leash", version: "0.1.0" },
    });
    rpc.notify("initialized", {});

    // Every execution starts a fresh thread: context moves between agents only
    // through results the middleware has seen, never through a shared conversation.
    // assertGatedPolicy pins these; writes remain in the isolated run workspace
    // and untrusted approval keeps proposed changes behind the ActionGate.
    threadId = await openThread(rpc, { threadId: null, sandboxMode: "workspace-write", approvalPolicy: "untrusted" });
    const started = (await rpc.request("turn/start", {
      threadId,
      input: [{ type: "text", text: options.prompt }],
      sandboxPolicy: buildSandboxPolicy("workspace-write", policy.denyNetwork),
      approvalPolicy: "untrusted",
    })) as { turn?: { id?: string } };
    turnId = started?.turn?.id ?? null;
    // Decisions that arrived before the turn had an id.
    if (stopped || options.signal.aborted) interrupt();
    flushSteers();

    const finalTurn = await Promise.race([turnFinished, options.exited]);
    // Report only once every observation has been recorded.
    await queue;

    if (options.signal.aborted) throw new RunCancelledError();
    if (failure !== null) throw failure;
    const error = readTurnError(finalTurn) ?? turnFailure;
    // An interrupt we sent ends the turn with an error too. That is the
    // middleware working, not a runtime failure.
    if (error !== null && !interruptSent) throw new Error("Codex turn failed: " + error);

    return { output: messages.at(-1)?.trim() ?? "", threadId, usage, stopped };
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
}

function trackRunning(record: TraceRecord, running: Set<string>): void {
  if (record.dir !== "in" || (record.method !== "item/started" && record.method !== "item/completed")) return;
  const params = (record.payload as { params?: { item?: { id?: unknown; type?: unknown } } } | null)?.params;
  const item = params?.item;
  if (typeof item?.id !== "string") return;
  if (item.type !== "commandExecution" && item.type !== "fileChange") return;
  if (record.method === "item/started") running.add(item.id);
  else running.delete(item.id);
}

/**
 * The approval request as a contract action. A command approval carries the
 * command; a file-change approval carries only ids, so the changes come from
 * the item/started notification that announced them (codex-protocol.ts).
 */
export function proposedActionOf(
  kind: "command" | "file_change",
  params: Record<string, unknown>,
  records: TraceRecord[],
  requestId: number | string,
): ProposedAction | null {
  const itemId = typeof params.itemId === "string" && params.itemId !== "" ? params.itemId : null;
  const actionId = itemId ?? `approval-${String(requestId)}`;

  if (kind === "command") {
    const announced = itemId === null ? undefined : commandsOf(records).filter((entry) => entry.itemId === itemId).at(-1);
    const command = typeof params.command === "string" && params.command.trim() !== "" ? params.command : announced?.command;
    if (command === undefined || command.trim() === "") return null;
    const cwd = typeof params.cwd === "string" ? params.cwd : (announced?.cwd ?? null);
    return { type: "command", actionId, command, cwd };
  }

  if (itemId === null) return null;
  const announced = fileChangesOf(records).filter((entry) => entry.itemId === itemId);
  const latest = announced.at(-1)?.seq;
  const changes: FileChange[] = announced
    .filter((entry) => entry.seq === latest && entry.path.trim() !== "")
    .map((entry) => ({ path: entry.path, kind: changeKind(entry.kind), movePath: null, diff: entry.diff === "" ? null : entry.diff }));
  if (changes.length === 0) return null;
  return { type: "file_change", actionId, changes };
}

function changeKind(kind: string): FileChange["kind"] {
  return kind === "add" || kind === "delete" ? kind : "update";
}
