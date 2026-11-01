import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import type { SecurityDecision } from "@launchpad/shared";
import {
  SandboxFileError,
  type CommandResult,
  type SandboxFile,
  type ToolSandbox,
  type ToolSandboxProvider,
  type ToolSandboxRequest,
} from "../../src/claude-tool-sandbox.js";

// A local stand-in for the Messages API, reached through the real SDK's baseURL,
// so these tests exercise the SDK's streaming and error handling as well as ours.
// No request ever leaves this machine and no real key exists in any of them.

export const TEST_API_KEY = "sk-ant-test-sentinel-not-a-real-key-0123456789";

export type MockBlock = Record<string, unknown>;

export interface MockTurn {
  content?: MockBlock[];
  stop_reason?: string | null;
  stop_details?: Record<string, unknown> | null;
  usage?: Record<string, unknown>;
  /** Answer with this status and body instead of a message. */
  status?: number;
  errorBody?: unknown;
  /** Never answer, to test timeouts and cancellation. */
  hang?: boolean;
}

export interface MockRequest {
  headers: IncomingHttpHeaders;
  body: Record<string, any>;
}

export const tool = (id: string, name: string, input: unknown): MockBlock => ({ type: "tool_use", id, name, input });
export const bash = (id: string, command: string): MockBlock => tool(id, "bash", { command });
export const editor = (id: string, input: Record<string, unknown>): MockBlock => tool(id, "str_replace_based_edit_tool", input);
export const text = (value: string): MockBlock => ({ type: "text", text: value });
export const thinking = (value: string): MockBlock => ({ type: "thinking", thinking: value, signature: "sig-" + value.length });

export const toolTurn = (...content: MockBlock[]): MockTurn => ({ content, stop_reason: "tool_use" });
export const finalTurn = (value = "Done."): MockTurn => ({ content: [text(value)], stop_reason: "end_turn" });

export interface MockAnthropic {
  baseURL: string;
  requests: MockRequest[];
  client: Anthropic;
  close(): Promise<void>;
}

/** Plays `turns` in order. Asking past the end is a test failure the model call reports. */
export async function startMockAnthropic(turns: MockTurn[], apiKey = TEST_API_KEY): Promise<MockAnthropic> {
  const requests: MockRequest[] = [];
  const hung: ServerResponse[] = [];
  let next = 0;
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, any>;
      // A snapshot: the runtime appends to the same array for the next request.
      requests.push({ headers: request.headers, body: structuredClone(body) });
      const turn = turns[next];
      next += 1;
      if (turn === undefined) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "mock: no more scripted turns" } }));
        return;
      }
      if (turn.hang === true) {
        hung.push(response);
        return;
      }
      if (turn.status !== undefined) {
        response.writeHead(turn.status, { "content-type": "application/json" });
        response.end(JSON.stringify(turn.errorBody ?? { type: "error", error: { type: "api_error", message: "mock failure" } }));
        return;
      }
      const message = messageOf(turn, next, String(body.model));
      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.end(sseOf(message));
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(message));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseURL = `http://127.0.0.1:${port}`;
  return {
    baseURL,
    requests,
    client: new Anthropic({ apiKey, baseURL, maxRetries: 0 }),
    close: () =>
      new Promise((resolve) => {
        for (const response of hung) response.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function messageOf(turn: MockTurn, index: number, model: string): Record<string, unknown> {
  return {
    id: `msg_${index}`,
    type: "message",
    role: "assistant",
    model,
    content: turn.content ?? [],
    stop_reason: turn.stop_reason === undefined ? "end_turn" : turn.stop_reason,
    stop_sequence: null,
    stop_details: turn.stop_details ?? null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...turn.usage,
    },
  };
}

function sseOf(message: Record<string, any>): string {
  const events: Array<Record<string, unknown>> = [];
  events.push({ type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
  (message.content as MockBlock[]).forEach((block, index) => {
    if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      const json = JSON.stringify(block.input);
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } });
    } else if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else {
      events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null, stop_details: message.stop_details },
    usage: message.usage,
  });
  events.push({ type: "message_stop" });
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** Records every tool call, and keeps a file map in place of a container. */
export class FakeSandbox implements ToolSandbox {
  readonly commands: string[] = [];
  readonly writes: Array<{ path: string; content: string; expectedSha256: string | null }> = [];
  readonly reads: string[] = [];
  readonly files = new Map<string, string>();
  /** A path the "container" refuses, as a symlink would be. */
  readonly refusedPaths = new Map<string, string>();
  shellResets = 0;
  stopped = 0;
  respond: (command: string) => Partial<CommandResult> | Promise<Partial<CommandResult>> = () => ({});
  private rejectExit!: (error: Error) => void;
  readonly exited: Promise<never>;

  constructor() {
    this.exited = new Promise<never>((_resolve, reject) => {
      this.rejectExit = reject;
    });
    this.exited.catch(() => undefined);
  }

  async runCommand(command: string, options: { maxOutputBytes: number; signal: AbortSignal; timeoutMs: number }): Promise<CommandResult> {
    this.commands.push(command);
    const answer = await this.respond(command);
    return { output: answer.output ?? "", exitCode: answer.exitCode === undefined ? 0 : answer.exitCode, timedOut: answer.timedOut ?? false, truncated: answer.truncated ?? false };
  }

  async resetShell(): Promise<void> {
    this.shellResets += 1;
  }

  async readFile(path: string): Promise<SandboxFile> {
    this.reads.push(path);
    const refusal = this.refusedPaths.get(path);
    if (refusal !== undefined) throw new SandboxFileError("symlink", refusal);
    const content = this.files.get(path);
    if (content === undefined) return { kind: "absent" };
    return { kind: "file", content: Buffer.from(content), sha256: createHash("sha256").update(content).digest("hex") };
  }

  async writeFile(path: string, content: string, expectedSha256: string | null): Promise<void> {
    this.writes.push({ path, content, expectedSha256 });
    this.files.set(path, content);
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    this.rejectExit(new Error("The tool container exited"));
  }

  /** The container dying on its own. */
  die(): void {
    this.rejectExit(new Error("The tool container exited"));
  }
}

export class FakeSandboxProvider implements ToolSandboxProvider {
  readonly started: ToolSandboxRequest[] = [];
  readonly sandboxes: FakeSandbox[] = [];
  configure: (sandbox: FakeSandbox) => void = () => undefined;

  async start(request: ToolSandboxRequest): Promise<ToolSandbox> {
    this.started.push(request);
    const sandbox = new FakeSandbox();
    this.configure(sandbox);
    this.sandboxes.push(sandbox);
    return sandbox;
  }
}

export const allow: SecurityDecision = { outcome: "allow", reason: "ok", severity: "info", findings: [], appliedPolicies: [] };
export const blockAction = (steer: string | null = null): SecurityDecision => ({
  outcome: "block",
  stop: "action",
  steer,
  reason: "no",
  severity: "high",
  findings: [],
  appliedPolicies: [],
});
export const blockExecution: SecurityDecision = { outcome: "block", stop: "execution", steer: null, reason: "stop", severity: "high", findings: [], appliedPolicies: [] };
export const steerDecision = (steer: string): SecurityDecision => ({ outcome: "steer", steer, reason: "careful", severity: "medium", findings: [], appliedPolicies: [] });
