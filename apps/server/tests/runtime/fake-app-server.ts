import { PassThrough } from "node:stream";
import { JsonRpcConnection } from "../../src/codex-app-server-client.js";
import type { RuntimeSession } from "../../src/container-codex-runner.js";
import type { TraceRecord } from "../../src/trace.js";

type Message = Record<string, unknown>;

/**
 * Plays the app-server side of the JSON-RPC protocol over in-memory streams:
 * answers initialize, thread/start, turn/start, turn/steer and turn/interrupt,
 * and lets a test send notifications and approval requests.
 */
export class FakeAppServer {
  /** Everything the client wrote, in order. */
  readonly received: Message[] = [];
  private readonly toClient = new PassThrough();
  private readonly fromClient = new PassThrough();
  private readonly waiters: Array<{ match: (message: Message) => boolean; resolve: (message: Message) => void }> = [];
  private nextRequestId = 1_000;
  private rejectExit!: (error: Error) => void;

  /** The client side, shaped like ContainerCodexRunner's RuntimeSession. */
  readonly session: RuntimeSession;

  constructor() {
    let buffer = "";
    this.fromClient.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") this.handle(JSON.parse(line) as Message);
    });

    const records: TraceRecord[] = [];
    const listeners: Array<(record: TraceRecord) => void> = [];
    const rpc = new JsonRpcConnection({ stdin: this.fromClient, stdout: this.toClient }, (dir, message) => {
      const record: TraceRecord = {
        seq: records.length + 1,
        at: new Date().toISOString(),
        dir,
        method: typeof (message as Message).method === "string" ? ((message as Message).method as string) : null,
        payload: message,
      };
      records.push(record);
      for (const listener of listeners) listener(record);
    });
    const exited = new Promise<never>((_resolve, reject) => {
      this.rejectExit = reject;
    });
    exited.catch(() => undefined);
    this.session = { rpc, records, onRecord: (listener) => listeners.push(listener), exited };
  }

  notify(method: string, params: Message): void {
    this.send({ method, params });
  }

  /** Send an approval request; resolves with the client's reply. */
  async requestApproval(method: string, params: Message): Promise<Message> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    this.send({ id, method, params });
    const reply = await this.waitFor((message) => message.id === id && "result" in message);
    return reply.result as Message;
  }

  startCommand(itemId: string, command: string): void {
    this.notify("item/started", { item: { id: itemId, type: "commandExecution", command, cwd: "/workspace" } });
  }

  completeCommand(itemId: string): void {
    this.notify("item/completed", { item: { id: itemId, type: "commandExecution", exitCode: 0 } });
  }

  /** The agent's final message, then the end of the turn. */
  finish(text: string): void {
    this.notify("item/completed", { item: { id: "msg-1", type: "agentMessage", text } });
    this.notify("turn/completed", { turn: { id: "turn-1" } });
  }

  /** The container dies. */
  exit(): void {
    this.rejectExit(new Error("Runtime container exited"));
  }

  methodsReceived(): string[] {
    return this.received.flatMap((message) => (typeof message.method === "string" ? [message.method] : []));
  }

  waitFor(match: (message: Message) => boolean): Promise<Message> {
    const seen = this.received.find(match);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  /** Resolves once the turn has started and its id has reached the client. */
  async turnStarted(): Promise<void> {
    await this.waitFor((message) => message.method === "turn/start");
    await new Promise((resolve) => setImmediate(resolve));
  }

  private handle(message: Message): void {
    this.received.push(message);
    for (const waiter of [...this.waiters]) {
      if (waiter.match(message)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
    if (typeof message.method !== "string" || message.id === undefined) return;
    const results: Record<string, Message> = {
      initialize: {},
      "thread/start": { thread: { id: "thread-1" } },
      "turn/start": { turn: { id: "turn-1" } },
      "turn/steer": {},
      "turn/interrupt": {},
    };
    const result = results[message.method];
    if (result !== undefined) this.send({ id: message.id, result });
    if (message.method === "turn/interrupt") {
      this.notify("turn/completed", { turn: { id: "turn-1", error: { message: "Turn interrupted" } } });
    }
  }

  private send(message: Message): void {
    this.toClient.write(JSON.stringify(message) + "\n");
  }
}
