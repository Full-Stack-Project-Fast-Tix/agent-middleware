import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { AppConfig } from "./config.js";

// The disposable container a Claude execution's tools run in. The agent loop and
// the API key stay on the host (orchestrator/claude-execution-runtime.ts); this
// file only starts a container, runs one tool call at a time inside it, and
// removes it. It decides nothing: by the time a call gets here the ActionGate has
// allowed it.
//
// What matters about it:
//
//   * Nothing in the container talks to the model, so a policy that denies
//     network gets `--network none` rather than a bridge.
//   * The API key is not in the container's environment or arguments, and not
//     even in the docker client's environment.
//   * The workspace is mounted read-only unless the execution may write.

const execFileAsync = promisify(execFile);

/** One container per execution, so one Agent can run several Tasks at once. */
export function containerName(executionId: string, instanceId = "default"): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeExecution = executionId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return "launchpad-" + safeInstance + "-" + safeExecution;
}

export type SandboxConfig = Pick<
  AppConfig,
  | "containerEngine"
  | "containerRuntimeImage"
  | "containerCpuLimit"
  | "containerMemoryLimit"
  | "containerPidsLimit"
  | "containerUser"
  | "runtimeInstanceId"
>;

export interface ToolSandboxRequest {
  agentId: string;
  /** Names the container. */
  executionId: string;
  /** Mounted at /workspace. */
  workspacePath: string;
  denyNetwork: boolean;
  /** False mounts /workspace read-only. */
  writable: boolean;
}

export interface CommandResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  /** True when part of the output was dropped to stay within the byte limit. */
  truncated: boolean;
}

export type SandboxFile =
  | { kind: "absent" }
  | { kind: "directory"; entries: string[]; truncated: boolean }
  | { kind: "file"; content: Buffer; sha256: string };

/** A file operation the container refused or could not do. The model is told; the execution goes on. */
export class SandboxFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxFileError";
  }
}

export interface ToolSandbox {
  /** Rejects when the container exits. Race it, or a dead container hangs the turn. */
  readonly exited: Promise<never>;
  runCommand(command: string, options: { timeoutMs: number; maxOutputBytes: number; signal: AbortSignal }): Promise<CommandResult>;
  /** Forget the shell session's working directory and exports. */
  resetShell(): Promise<void>;
  /** Throws SandboxFileError on a path it will not follow. */
  readFile(path: string, options: { maxBytes: number }): Promise<SandboxFile>;
  /**
   * Replace a file whose content still hashes to `expectedSha256`, or create one
   * that must not exist yet (`null`), so what runs is what the gate saw.
   */
  writeFile(path: string, content: string, expectedSha256: string | null): Promise<void>;
  stop(): Promise<void>;
}

export interface ToolSandboxProvider {
  start(request: ToolSandboxRequest): Promise<ToolSandbox>;
}

const READY_LINE = "agentguard-sandbox-ready";

export function buildToolContainerRunArgs(request: ToolSandboxRequest, config: SandboxConfig): string[] {
  const name = containerName(request.executionId, config.runtimeInstanceId);
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  return [
    "run",
    "--rm",
    "--init",
    // PID 1 waits on stdin, so a server that dies closes it and the container goes too.
    "--interactive",
    // A missing image is a setup error, never a reason to pull a similar name.
    "--pull",
    "never",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=agent-runtime",
    "--label",
    "io.codejam.agent-id=" + request.agentId,
    "--label",
    "io.codejam.execution-id=" + request.executionId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    request.denyNetwork ? "none" : "bridge",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--mount",
    "type=bind,src=" + request.workspacePath + ",dst=/workspace" + (request.writable ? "" : ",readonly"),
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    "sh",
    "-c",
    `echo ${READY_LINE}; exec cat >/dev/null`,
  ];
}

/**
 * The docker client's environment. Listed name by name rather than inherited,
 * because the server's own environment holds the API key.
 */
export function sandboxClientEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_RUNTIME_DIR"] as const) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return environment;
}

export function isRootUser(user: string): boolean {
  return /^(?:0|root)(?::|$)/.test(user.trim());
}

/**
 * One command in the shell session. Commands arrive on stdin, so they never
 * appear in a process list and have no length limit from argv. Each call is its
 * own process; the bash tool's session (working directory and exported
 * variables) is carried in files inside the container.
 */
export const SHELL_SESSION_SCRIPT = String.raw`
AG_STATE=/tmp/.agentguard-shell
mkdir -p "$AG_STATE" 2>/dev/null
AG_COMMAND="$(cat)"
exec </dev/null 2>&1
[ -r "$AG_STATE/env" ] && . "$AG_STATE/env" 2>/dev/null
cd "$(cat "$AG_STATE/cwd" 2>/dev/null || echo /workspace)" 2>/dev/null || cd /workspace
trap 'ag_status=$?; pwd >"$AG_STATE/cwd" 2>/dev/null; export -p >"$AG_STATE/env" 2>/dev/null; exit $ag_status' EXIT
eval "$AG_COMMAND"
`;

/**
 * The file half of the editor tool, run inside the container with `node -e`, so
 * a path can only ever resolve against the container's own filesystem, never the
 * host's. The request arrives on stdin, one JSON object; one JSON object goes back.
 *
 * It never follows a symlink. Every parent directory is checked with lstat, the
 * final component is opened with O_NOFOLLOW, and the open descriptor is checked
 * against /proc/self/fd before a byte is read or written, which also catches a
 * path swapped between the check and the open.
 */
export const WORKSPACE_FILE_SCRIPT = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const ROOT = "/workspace";
const { O_RDONLY, O_RDWR, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
class Refused extends Error {
  constructor(code, message) { super(message); this.refusal = code; }
}
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
function segmentsOf(target) {
  if (typeof target !== "string" || target.includes("\0")) throw new Refused("invalid_path", "The path is not valid.");
  if (target === ROOT) return [];
  if (!target.startsWith(ROOT + "/")) throw new Refused("outside_workspace", "The path is outside /workspace.");
  const segments = target.slice(ROOT.length + 1).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") throw new Refused("invalid_path", "The path is not normalized.");
  }
  return segments;
}
function lstatOrNull(target) {
  try { return fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function walkParents(segments, create) {
  let current = ROOT;
  for (const segment of segments.slice(0, -1)) {
    current += "/" + segment;
    let stat = lstatOrNull(current);
    if (stat === null) {
      if (!create) return false;
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) throw new Refused("symlink", "The path passes through a symbolic link, which the editor does not follow.");
    if (!stat.isDirectory()) throw new Refused("not_directory", "Part of the path is not a directory.");
  }
  return true;
}
function assertOpenedAt(fd, target) {
  if (fs.readlinkSync("/proc/self/fd/" + fd) !== target) throw new Refused("outside_workspace", "The path resolved somewhere other than itself.");
}
function open(target, flags, mode) {
  try { return fs.openSync(target, flags, mode); } catch (error) {
    if (error.code === "ELOOP") throw new Refused("symlink", "The path is a symbolic link, which the editor does not follow.");
    if (error.code === "EEXIST") throw new Refused("changed", "The file was created after this edit was proposed.");
    if (error.code === "ENOENT") throw new Refused("changed", "The file was removed after this edit was proposed.");
    throw error;
  }
}
function openChecked(target, flags) {
  const fd = open(target, flags);
  assertOpenedAt(fd, target);
  if (!fs.fstatSync(fd).isFile()) throw new Refused("not_file", "The path is not a regular file.");
  return fd;
}
function list(directory, prefix, depth, entries) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entries.length >= 1000) return false;
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) { entries.push(name + "@"); continue; }
    if (!entry.isDirectory()) { entries.push(name); continue; }
    entries.push(name + "/");
    if (depth > 1 && !list(directory + "/" + entry.name, name + "/", depth - 1, entries)) return false;
  }
  return true;
}
function read(request) {
  const segments = segmentsOf(request.path);
  if (!walkParents(segments, false)) return { ok: true, kind: "absent" };
  const stat = lstatOrNull(request.path);
  if (stat === null) return { ok: true, kind: "absent" };
  if (stat.isSymbolicLink()) throw new Refused("symlink", "The path is a symbolic link, which the editor does not follow.");
  if (stat.isDirectory()) {
    const entries = [];
    const complete = list(request.path, "", 2, entries);
    return { ok: true, kind: "directory", entries, truncated: !complete };
  }
  const fd = openChecked(request.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (fs.fstatSync(fd).size > request.maxBytes) throw new Refused("too_large", "The file is larger than the editor's limit of " + request.maxBytes + " bytes. Use the bash tool to read part of it.");
  const content = fs.readFileSync(fd);
  return { ok: true, kind: "file", contentBase64: content.toString("base64"), sha256: sha256(content) };
}
function write(request) {
  const segments = segmentsOf(request.path);
  if (segments.length === 0) throw new Refused("not_file", "The path is a directory.");
  walkParents(segments, true);
  const expected = request.expectedSha256;
  // Created, closed and opened again before a byte is written: on Docker Desktop
  // a descriptor from O_CREAT reports its path in the VM, not in the container.
  if (expected === null) fs.closeSync(open(request.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644));
  const fd = openChecked(request.path, O_RDWR | O_NOFOLLOW | O_NONBLOCK);
  if (expected !== null && sha256(fs.readFileSync(fd)) !== expected) throw new Refused("changed", "The file changed after this edit was proposed. Read it again.");
  const body = Buffer.from(request.content, "utf8");
  fs.ftruncateSync(fd, 0);
  let written = 0;
  while (written < body.length) written += fs.writeSync(fd, body, written, body.length - written, written);
  return { ok: true, kind: "written" };
}
function reply(value) { process.stdout.write(JSON.stringify(value)); }
try {
  const request = JSON.parse(fs.readFileSync(0, "utf8"));
  reply(request.op === "read" ? read(request) : request.op === "write" ? write(request) : { ok: false, code: "invalid_request", message: "Unknown operation." });
} catch (error) {
  if (error.refusal !== undefined) reply({ ok: false, code: error.refusal, message: error.message });
  else reply({ ok: false, code: "io_error", message: "The file operation failed: " + (error.code || "unknown error") + "." });
}
`;

const fileResponseSchema = z.union([
  z.object({ ok: z.literal(true), kind: z.literal("absent") }),
  z.object({ ok: z.literal(true), kind: z.literal("written") }),
  z.object({ ok: z.literal(true), kind: z.literal("directory"), entries: z.array(z.string()), truncated: z.boolean() }),
  z.object({ ok: z.literal(true), kind: z.literal("file"), contentBase64: z.string(), sha256: z.string() }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);

/** Keeps the start and end of a stream within a byte limit, and how much was dropped. */
export class BoundedOutput {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  total = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    this.total += chunk.byteLength;
    const headRoom = Math.floor(this.maxBytes / 2) - this.headBytes;
    if (headRoom > 0) {
      const part = chunk.subarray(0, headRoom);
      this.head.push(part);
      this.headBytes += part.byteLength;
      chunk = chunk.subarray(part.byteLength);
    }
    if (chunk.byteLength === 0) return;
    this.tail.push(chunk);
    this.tailBytes += chunk.byteLength;
    const tailLimit = this.maxBytes - Math.floor(this.maxBytes / 2);
    while (this.tailBytes > tailLimit && this.tail.length > 0) {
      const first = this.tail[0]!;
      const excess = this.tailBytes - tailLimit;
      if (first.byteLength <= excess) {
        this.tail.shift();
        this.tailBytes -= first.byteLength;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
      }
    }
  }

  get truncated(): boolean {
    return this.total > this.headBytes + this.tailBytes;
  }

  toString(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    if (!this.truncated) return head + tail;
    return `${head}\n[... ${this.total - this.headBytes - this.tailBytes} bytes omitted by AgentGuard ...]\n${tail}`;
  }
}

/** Past this much output a command is killed rather than drained. */
const DRAIN_LIMIT_BYTES = 64 * 1024 * 1024;
/** On top of the in-container timeout, in case that never gets to run. */
const HOST_TIMEOUT_MARGIN_MS = 15_000;
const FILE_OPERATION_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 60_000;

class DockerToolSandbox implements ToolSandbox {
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly config: SandboxConfig,
    private readonly name: string,
    private readonly child: ChildProcess,
    private readonly closed: Promise<void>,
    readonly exited: Promise<never>,
  ) {}

  async runCommand(
    command: string,
    options: { timeoutMs: number; maxOutputBytes: number; signal: AbortSignal },
  ): Promise<CommandResult> {
    const seconds = Math.max(1, Math.ceil(options.timeoutMs / 1_000));
    const output = new BoundedOutput(options.maxOutputBytes);
    const { code, killedOnHost } = await this.exec(
      ["exec", "-i", "--workdir", "/workspace", this.name, "timeout", "--kill-after=5", `${seconds}s`, "bash", "--noprofile", "--norc", "-c", SHELL_SESSION_SCRIPT],
      command,
      output,
      { timeoutMs: options.timeoutMs + HOST_TIMEOUT_MARGIN_MS, signal: options.signal, includeStderr: true },
    );
    return {
      output: output.toString(),
      exitCode: code,
      timedOut: killedOnHost || code === 124 || code === 137,
      truncated: output.truncated,
    };
  }

  async resetShell(): Promise<void> {
    await execFileAsync(this.config.containerEngine, ["exec", this.name, "rm", "-rf", "/tmp/.agentguard-shell"], {
      timeout: FILE_OPERATION_TIMEOUT_MS,
      env: sandboxClientEnvironment(),
    });
  }

  async readFile(path: string, options: { maxBytes: number }): Promise<SandboxFile> {
    const response = await this.fileOperation({ op: "read", path, maxBytes: options.maxBytes }, options.maxBytes);
    if (response.kind === "absent") return { kind: "absent" };
    if (response.kind === "directory") return { kind: "directory", entries: response.entries, truncated: response.truncated };
    if (response.kind === "file") {
      return { kind: "file", content: Buffer.from(response.contentBase64, "base64"), sha256: response.sha256 };
    }
    throw new SandboxFileError("io_error", "The file operation returned an unexpected result.");
  }

  async writeFile(path: string, content: string, expectedSha256: string | null): Promise<void> {
    const response = await this.fileOperation({ op: "write", path, content, expectedSha256 }, 0);
    if (response.kind !== "written") throw new SandboxFileError("io_error", "The file operation returned an unexpected result.");
  }

  stop(): Promise<void> {
    this.stopping ??= execFileAsync(this.config.containerEngine, ["rm", "--force", this.name], {
      timeout: 8_000,
      env: sandboxClientEnvironment(),
    })
      .then(() => undefined)
      .catch(() => {
        // Already removed, or the engine is unreachable: drop our end of stdin too.
        this.child.kill("SIGKILL");
      })
      .then(() => Promise.race([this.closed, new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref())]));
    return this.stopping;
  }

  private async fileOperation(request: Record<string, unknown>, maxFileBytes: number) {
    // Base64 plus the JSON around it.
    const output = new BoundedOutput(Math.ceil(maxFileBytes * 1.4) + 1_048_576);
    const { code, killedOnHost } = await this.exec(
      ["exec", "-i", "--workdir", "/", this.name, "node", "-e", WORKSPACE_FILE_SCRIPT],
      JSON.stringify(request),
      output,
      // Stdout only: it is parsed, and a runtime warning on stderr must not break that.
      { timeoutMs: FILE_OPERATION_TIMEOUT_MS, signal: null, includeStderr: false },
    );
    if (killedOnHost || code !== 0 || output.truncated) {
      throw new SandboxFileError("io_error", "The file operation did not complete.");
    }
    // Container output is untrusted, even from a script the host supplied.
    let parsed: z.infer<typeof fileResponseSchema>;
    try {
      parsed = fileResponseSchema.parse(JSON.parse(output.toString()));
    } catch {
      throw new SandboxFileError("io_error", "The file operation returned an unexpected result.");
    }
    if (!parsed.ok) throw new SandboxFileError(parsed.code, parsed.message);
    return parsed;
  }

  private exec(
    args: string[],
    stdin: string,
    output: BoundedOutput,
    options: { timeoutMs: number; signal: AbortSignal | null; includeStderr: boolean },
  ): Promise<{ code: number | null; killedOnHost: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(this.config.containerEngine, args, {
        env: sandboxClientEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let killedOnHost = false;
      const kill = (): void => {
        killedOnHost = true;
        child.kill("SIGKILL");
      };
      const onData = (chunk: Buffer): void => {
        output.append(chunk);
        if (output.total > DRAIN_LIMIT_BYTES) kill();
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", options.includeStderr ? onData : () => undefined);
      // A command that exits without reading its stdin is not an error here.
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin);
      const timer = setTimeout(kill, options.timeoutMs);
      timer.unref();
      options.signal?.addEventListener("abort", kill, { once: true });
      const finish = (code: number | null): void => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", kill);
        resolve({ code, killedOnHost });
      };
      child.once("error", () => finish(null));
      child.once("close", (code) => finish(code));
    });
  }
}

export class DockerToolSandboxProvider implements ToolSandboxProvider {
  constructor(private readonly config: SandboxConfig) {}

  async start(request: ToolSandboxRequest): Promise<ToolSandbox> {
    if (isRootUser(this.config.containerUser)) {
      throw new Error("The Claude runtime will not run tools as root. Set CONTAINER_USER to a non-root uid:gid.");
    }
    const name = containerName(request.executionId, this.config.runtimeInstanceId);
    const child = spawn(this.config.containerEngine, buildToolContainerRunArgs(request, this.config), {
      env: sandboxClientEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const exited = closed.then<never>(() => {
      throw new Error("The tool container exited");
    });
    exited.catch(() => undefined);

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4_096);
    });
    child.stdin.on("error", () => undefined);

    const sandbox = new DockerToolSandbox(this.config, name, child, closed, exited);
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (stdout.includes(READY_LINE)) resolve();
        });
        const timer = setTimeout(() => reject(new Error("The tool container did not start in time")), START_TIMEOUT_MS);
        timer.unref();
        void closed.then(() => {
          clearTimeout(timer);
          reject(
            new Error(
              `The tool container could not start (${stderr.trim() || "no detail"}). ` +
                `Is the image ${this.config.containerRuntimeImage} built? Run: npm run build:claude-runtime`,
            ),
          );
        });
        child.once("error", (error) => reject(error));
      });
    } catch (error) {
      await sandbox.stop();
      throw error;
    }
    return sandbox;
  }
}
