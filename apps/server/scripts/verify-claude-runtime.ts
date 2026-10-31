// End-to-end check of the Claude runtime's security boundary, in a real container.
//
//   npm run build:claude-runtime
//   npm run verify:claude-runtime -w @launchpad/server
//
// Everything real except the model: real Docker, the real ClaudeExecutionRuntime,
// the real SDK, and a mock Messages API on this host that plays scripted turns.
// No model account or API key is used; the "key" below is a sentinel, used to
// prove it never reaches a container. Outside the workspace it creates and removes
// nothing but its own temp folder and containers.
//
// It stays out of `npm test` because it needs Docker and a built image.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Agent, AgentExecution, ProposedAction, Run, SecurityDecision, Task } from "@launchpad/shared";
import { DockerToolSandboxProvider } from "../src/claude-tool-sandbox.js";
import { loadConfig } from "../src/config.js";
import { containerName } from "../src/container-codex-runner.js";
import { RunCancelledError } from "../src/errors.js";
import { ClaudeExecutionRuntime } from "../src/orchestrator/claude-execution-runtime.js";

const SENTINEL_KEY = "sk-ant-probe-sentinel-not-a-real-key-7f3a9c";
const IMAGE = process.env.CONTAINER_RUNTIME_IMAGE ?? "agentguard-claude-runtime:local";

const ALLOW: SecurityDecision = { outcome: "allow", reason: "probe", severity: "info", findings: [], appliedPolicies: [] };
const DECLINE: SecurityDecision = { outcome: "block", stop: "action", steer: null, reason: "probe", severity: "high", findings: [], appliedPolicies: [] };

type Block = Record<string, unknown>;
interface Turn {
  content: Block[];
  stop_reason: string;
}
const bash = (id: string, command: string): Block => ({ type: "tool_use", id, name: "bash", input: { command } });
const editor = (id: string, input: Block): Block => ({ type: "tool_use", id, name: "str_replace_based_edit_tool", input });
const tools = (...content: Block[]): Turn => ({ content, stop_reason: "tool_use" });
const done: Turn = { content: [{ type: "text", text: "Probe finished." }], stop_reason: "end_turn" };

// -- The mock Messages API, on the host. A no-network container cannot reach it. --

const script: Turn[] = [];
const toolResults: Array<{ tool_use_id: string; is_error?: boolean; content: string }> = [];
let authorizedRequests = 0;
let unauthorizedRequests = 0;

const mockApi = createServer((request, response) => {
  let raw = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", () => {
    if (!request.url?.includes("/v1/messages")) {
      response.writeHead(200, { "content-type": "text/plain" }).end("mock api reachable");
      return;
    }
    if (request.headers.authorization === `Bearer ${SENTINEL_KEY}`) authorizedRequests += 1;
    else unauthorizedRequests += 1;
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }> };
    const last = body.messages.at(-1);
    if (Array.isArray(last?.content)) {
      for (const block of last.content as Array<Record<string, any>>) {
        if (block.type === "tool_result") toolResults.push(block as never);
      }
    }
    const turn = script.shift() ?? done;
    const message = {
      id: "msg_probe",
      type: "message",
      role: "assistant",
      model: "mock-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
    const events: Array<Record<string, unknown>> = [{ type: "message_start", message }];
    turn.content.forEach((block, index) => {
      if (block.type === "tool_use") {
        events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
        events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      } else {
        events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
        events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      }
      events.push({ type: "content_block_stop", index });
    });
    events.push({ type: "message_delta", delta: { stop_reason: turn.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
    events.push({ type: "message_stop" });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
});
await new Promise<void>((resolve, reject) => {
  mockApi.once("error", reject);
  mockApi.listen(0, "0.0.0.0", () => resolve());
});
const mockPort = (mockApi.address() as AddressInfo).port;

// -- The runtime under test -----------------------------------------------------

// On macOS the temp folder is a symlink; docker wants the real path.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentguard-claude-probe-")));
const dataDirectory = path.join(root, "data");
mkdirSync(dataDirectory);

const config = loadConfig({
  NODE_ENV: "test",
  MODEL_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: SENTINEL_KEY,
  CONTAINER_RUNTIME_IMAGE: IMAGE,
  CONTAINER_ENGINE: process.env.CONTAINER_ENGINE ?? "docker",
  CLAUDE_COMMAND_TIMEOUT_MS: "20000",
  APP_DATA_DIR: dataDirectory,
} as NodeJS.ProcessEnv);

const runtime = new ClaudeExecutionRuntime({
  client: new Anthropic({ apiKey: SENTINEL_KEY, baseURL: `http://127.0.0.1:${mockPort}`, maxRetries: 0 }),
  model: "mock-model",
  apiKey: SENTINEL_KEY,
  limits: config.claude,
  dataDirectory,
  sandboxes: new DockerToolSandboxProvider(config),
});

let scenarioNumber = 0;

interface Scenario {
  workspace: string;
  executionId: string;
  decisions: ProposedAction[];
  tracePath: string | null;
  results: Map<string, { is_error?: boolean; content: string }>;
}

async function run(
  turns: Turn[],
  options: {
    decide?: (action: ProposedAction) => SecurityDecision;
    denyNetwork?: boolean;
    writable?: boolean;
    prepare?: (workspace: string) => void;
    signal?: AbortSignal;
    onActive?: () => void;
  } = {},
): Promise<Scenario & { error: unknown }> {
  scenarioNumber += 1;
  const workspace = path.join(root, `scenario-${scenarioNumber}`, "workspace");
  mkdirSync(workspace, { recursive: true });
  options.prepare?.(workspace);
  const executionId = `probe-${process.pid}-${scenarioNumber}`;
  const decisions: ProposedAction[] = [];
  script.length = 0;
  script.push(...turns);
  toolResults.length = 0;
  let tracePath: string | null = null;
  let error: unknown = null;
  try {
    const outcome = await runtime.execute({
      run: { id: "probe-run" } as Run,
      task: { id: "probe-task" } as Task,
      execution: { id: executionId, capabilities: { write: options.writable ?? true, shell: true, network: !(options.denyNetwork ?? true), delegate: false, maxDelegationDepth: 0 } } as AgentExecution,
      agent: { id: "probe-agent" } as Agent,
      workingDirectory: workspace,
      prompt: "Probe task.",
      runtimePolicy: { sandboxMode: "workspace-write", denyNetwork: options.denyNetwork ?? true, approvalPolicy: "untrusted", semanticEnforcement: false, effectGating: true },
      gate: {
        decide: async (action) => {
          decisions.push(action);
          return options.decide?.(action) ?? ALLOW;
        },
        observe: async () => null,
      },
      signal: options.signal ?? new AbortController().signal,
    });
    tracePath = outcome.tracePath;
  } catch (caught) {
    error = caught;
  }
  const results = new Map(toolResults.map((result) => [result.tool_use_id, result]));
  return { workspace, executionId, decisions, tracePath, results, error };
}

const report: Array<Record<string, unknown>> = [];
function record(name: string, passed: boolean, evidence: Record<string, unknown>): void {
  report.push({ name, passed, ...evidence });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}`);
}

const containerExists = (executionId: string): boolean =>
  execFileSync(config.containerEngine, ["ps", "--all", "--quiet", "--filter", `name=^${containerName(executionId, config.runtimeInstanceId)}$`], { encoding: "utf8" }).trim() !== "";

function fileOwner(file: string): number {
  return lstatSync(file).uid;
}

function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n")[0]!.slice(0, 160);
}

// -- The scenarios --------------------------------------------------------------

try {
  const imageHasCodex = spawnSync(config.containerEngine, ["run", "--rm", "--pull", "never", "--entrypoint", "sh", IMAGE, "-c", "command -v codex || echo absent"], { encoding: "utf8" }).stdout.trim();
  record("the runtime image contains no Codex", imageHasCodex === "absent", { image: IMAGE, whichCodex: imageHasCodex });

  // 1. Declining an edit leaves the file absent.
  {
    const scenario = await run([tools(editor("edit", { command: "create", path: "/workspace/declined.txt", file_text: "must not exist\n" })), done], {
      decide: () => DECLINE,
    });
    const result = scenario.results.get("edit");
    record("a declined edit leaves the file absent", !existsSync(path.join(scenario.workspace, "declined.txt")) && result?.is_error === true && scenario.decisions.length === 1, {
      fileExists: existsSync(path.join(scenario.workspace, "declined.txt")),
      gateSaw: scenario.decisions[0],
      toolResultIsError: result?.is_error,
      toolResult: result?.content,
    });
  }

  // 2. Approving applies it, as the unprivileged user, and the command sees it.
  {
    const scenario = await run([
      tools(editor("edit", { command: "create", path: "/workspace/nested/approved.txt", file_text: "created by the probe\n" })),
      tools(editor("replace", { command: "str_replace", path: "/workspace/nested/approved.txt", old_str: "by the probe", new_str: "and edited by the probe" })),
      tools(bash("show", "cat nested/approved.txt && id -u && pwd")),
      done,
    ]);
    const onHost = path.join(scenario.workspace, "nested", "approved.txt");
    const content = existsSync(onHost) ? readFileSync(onHost, "utf8") : null;
    const output = scenario.results.get("show")?.content ?? "";
    const uid = output.split("\n")[1];
    record("an approved edit applies, and a command runs in the container as non-root", content === "created and edited by the probe\n" && uid !== "0" && output.includes("/workspace"), {
      contentOnHost: content,
      commandOutput: output,
      ownerUidOnHost: existsSync(onHost) ? fileOwner(onHost) : null,
      gateSawKinds: scenario.decisions.map((action) => (action.type === "file_change" ? action.changes.map((change) => change.kind) : action.type)),
    });
  }

  // 3. A refused command does not run.
  {
    const scenario = await run([tools(bash("refused", "touch refused.txt")), done], { decide: () => DECLINE });
    record("a refused command does not run", !existsSync(path.join(scenario.workspace, "refused.txt")) && scenario.results.get("refused")?.is_error === true, {
      fileExists: existsSync(path.join(scenario.workspace, "refused.txt")),
    });
  }

  // 4. A policy that denies network gets no network at all.
  {
    const probeUrl = `http://host.docker.internal:${mockPort}/probe`;
    const scenario = await run([
      tools(
        // The kernel lists unconfigured tunnel devices in every namespace; a route is what would matter.
        bash("routes", "grep -c . /proc/net/route; ls /sys/class/net | tr '\\n' ' '; for f in /sys/class/net/*/operstate; do cat $f; done | sort -u | tr '\\n' ' '"),
        bash("internet", "curl -sS --max-time 8 https://example.com -o /dev/null; echo curl_exit=$?"),
        bash("dns", "getent hosts example.com; echo getent_exit=$?"),
        bash("host", `curl -sS --max-time 8 ${probeUrl}; echo curl_exit=$?`),
        bash("ip", "bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' ; echo tcp_exit=$?"),
      ),
      done,
    ]);
    const outputOf = (id: string) => scenario.results.get(id)?.content ?? "";
    const networkMode = "none";
    // /proc/net/route's header is its only line when nothing can be routed.
    const passed =
      outputOf("routes").split("\n")[0]!.trim() === "1" &&
      !outputOf("internet").includes("curl_exit=0") &&
      !outputOf("dns").includes("getent_exit=0") &&
      !outputOf("host").includes("curl_exit=0") &&
      !outputOf("ip").includes("tcp_exit=0") &&
      !outputOf("host").includes("mock api reachable");
    record("a no-network container cannot reach the internet, DNS or the host", passed, {
      requestedNetwork: networkMode,
      routeTableLinesThenInterfacesThenStates: outputOf("routes"),
      internet: outputOf("internet"),
      dns: outputOf("dns"),
      hostMockApi: outputOf("host"),
      rawTcp: outputOf("ip"),
      modelCallsStillWorked: authorizedRequests > 0,
    });
  }

  // 5. The control: a policy that allows network keeps today's bridge.
  {
    const scenario = await run([tools(bash("host", `curl -sS --max-time 8 http://host.docker.internal:${mockPort}/probe; echo; echo curl_exit=$?`)), done], { denyNetwork: false });
    const output = scenario.results.get("host")?.content ?? "";
    record("control: with network allowed the same request reaches the host", output.includes("mock api reachable"), { output });
  }

  // 6. The key is nowhere in the container.
  {
    let inspected = "";
    let executionForInspect = "";
    const decide = (action: ProposedAction): SecurityDecision => {
      if (action.type === "command" && action.command.startsWith("env") && executionForInspect !== "") {
        inspected = execFileSync(config.containerEngine, ["inspect", containerName(executionForInspect, config.runtimeInstanceId)], { encoding: "utf8" });
      }
      return ALLOW;
    };
    executionForInspect = `probe-${process.pid}-${scenarioNumber + 1}`;
    const scenario = await run(
      [
        tools(
          bash("env", "env"),
          bash("proc", "cat /proc/1/environ | tr '\\0' '\\n'; cat /proc/self/cmdline | tr '\\0' ' '"),
          bash("search", "grep -rIl 'sk-ant-probe' /workspace /tmp /proc/1/cmdline 2>/dev/null; echo search_done"),
        ),
        done,
      ],
      { decide },
    );
    const everything = ["env", "proc", "search"].map((id) => scenario.results.get(id)?.content ?? "").join("\n");
    const traceFile = scenario.tracePath === null ? "" : readFileSync(scenario.tracePath, "utf8");
    const passed =
      !everything.includes(SENTINEL_KEY) &&
      !everything.includes("ANTHROPIC") &&
      inspected !== "" &&
      !inspected.includes(SENTINEL_KEY) &&
      !inspected.includes("ANTHROPIC") &&
      !traceFile.includes(SENTINEL_KEY) &&
      authorizedRequests > 0 &&
      unauthorizedRequests === 0;
    const parsed = inspected === "" ? null : (JSON.parse(inspected) as Array<{ Config: { Env: string[]; User: string }; HostConfig: Record<string, unknown> }>)[0]!;
    record("the API key is not in the container's environment, arguments, or the trace", passed, {
      containerEnv: scenario.results.get("env")?.content,
      inspectEnv: parsed?.Config.Env,
      inspectUser: parsed?.Config.User,
      inspectNetworkMode: parsed?.HostConfig.NetworkMode,
      inspectCapDrop: parsed?.HostConfig.CapDrop,
      inspectSecurityOpt: parsed?.HostConfig.SecurityOpt,
      inspectPidsLimit: parsed?.HostConfig.PidsLimit,
      inspectMemory: parsed?.HostConfig.Memory,
      inspectNanoCpus: parsed?.HostConfig.NanoCpus,
      inspectMounts: parsed?.HostConfig.Mounts,
      keyMissedByTheModelApi: unauthorizedRequests,
      requestsWithTheKey: authorizedRequests,
    });
  }

  // 7. Neither `..` nor a symlink gets an edit out of /workspace.
  {
    let outsideFolder = "";
    const scenario = await run(
      [
        tools(
          editor("dotdot", { command: "create", path: "/workspace/../escaped-dotdot.txt", file_text: "x" }),
          editor("dotdot-relative", { command: "create", path: "../escaped-relative.txt", file_text: "x" }),
          editor("absolute", { command: "create", path: "/tmp/escaped-absolute.txt", file_text: "x" }),
          editor("through-link", { command: "create", path: "/workspace/link-to-tmp/escaped-through-link.txt", file_text: "x" }),
          editor("through-host-link", { command: "create", path: "/workspace/link-to-host/escaped-host.txt", file_text: "x" }),
          editor("final-link", { command: "create", path: "/workspace/link-to-file.txt", file_text: "overwritten" }),
          editor("final-link-replace", { command: "str_replace", path: "/workspace/link-to-file.txt", old_str: "target", new_str: "overwritten" }),
          editor("view-link", { command: "view", path: "/workspace/link-to-passwd" }),
          editor("view-through-link", { command: "view", path: "/workspace/link-to-etc/hostname" }),
        ),
        tools(bash("after", "ls -la /tmp; cat /tmp/target-outside.txt; cat /workspace/link-to-file.txt")),
        done,
      ],
      {
        prepare: (workspace) => {
          outsideFolder = path.join(path.dirname(workspace), "outside");
          mkdirSync(outsideFolder);
          writeFileSync(path.join(outsideFolder, "keep.txt"), "untouched\n");
          symlinkSync("/tmp", path.join(workspace, "link-to-tmp"));
          symlinkSync(outsideFolder, path.join(workspace, "link-to-host"));
          symlinkSync("/tmp/target-outside.txt", path.join(workspace, "link-to-file.txt"));
          symlinkSync("/etc/passwd", path.join(workspace, "link-to-passwd"));
          symlinkSync("/etc", path.join(workspace, "link-to-etc"));
        },
      },
    );
    const refusedIds = ["dotdot", "dotdot-relative", "absolute", "through-link", "through-host-link", "final-link", "final-link-replace", "view-link", "view-through-link"];
    const refusals = Object.fromEntries(refusedIds.map((id) => [id, { isError: scenario.results.get(id)?.is_error, message: firstLine(scenario.results.get(id)?.content) }]));
    const after = scenario.results.get("after")?.content ?? "";
    const hostUntouched =
      readFileSync(path.join(outsideFolder, "keep.txt"), "utf8") === "untouched\n" &&
      !existsSync(path.join(outsideFolder, "escaped-host.txt")) &&
      !existsSync(path.join(path.dirname(scenario.workspace), "escaped-dotdot.txt")) &&
      !existsSync(path.join(path.dirname(scenario.workspace), "escaped-relative.txt"));
    const passed =
      refusedIds.every((id) => scenario.results.get(id)?.is_error === true) &&
      hostUntouched &&
      !after.includes("escaped") &&
      !after.includes("overwritten") &&
      !(scenario.results.get("view-link")?.content ?? "").includes("root:") &&
      // No escape attempt reached the gate as an approved write.
      scenario.decisions.filter((action) => action.type === "file_change").length === 0;
    record("a symlink or .. edit cannot escape /workspace", passed, {
      refusals,
      containerAfter: after,
      hostFolderOutsideWorkspaceUntouched: hostUntouched,
      fileChangesThatReachedTheGate: scenario.decisions.filter((action) => action.type === "file_change").length,
    });
  }

  // 8. A race: swapping a directory for a symlink after the check still cannot land outside.
  {
    const scenario = await run(
      [
        tools(bash("swap", "mkdir -p racedir; (for i in $(seq 1 4000); do mv racedir racedir.real 2>/dev/null; ln -sfn /tmp racedir; rm -f racedir; mv racedir.real racedir 2>/dev/null; done) >/dev/null 2>&1 & echo started")),
        ...Array.from({ length: 6 }, (_value, index) => tools(editor(`race-${index}`, { command: "create", path: `/workspace/racedir/race-${index}.txt`, file_text: "x" }))),
        tools(bash("look", "ls /tmp | grep -c '^race-' || true")),
        done,
      ],
    );
    const inTmp = (scenario.results.get("look")?.content ?? "").split("\n")[0]!.trim();
    record("a directory swapped for a symlink mid-edit does not land outside (best effort: a timing race)", inTmp === "0", { filesWrittenOutsideWorkspace: inTmp });
  }

  // 9. A read-only execution cannot change the workspace, even from a command.
  {
    const scenario = await run([tools(bash("write", "touch nope.txt; echo touch_exit=$?")), done], { writable: false });
    const output = scenario.results.get("write")?.content ?? "";
    record("a read-only execution's workspace is mounted read-only", !existsSync(path.join(scenario.workspace, "nope.txt")) && output.includes("Read-only") , { output });
  }

  // 10. The shell session carries the working directory and exports, and output and time are bounded.
  {
    const scenario = await run([
      tools(bash("first", "mkdir -p sub && cd sub && export PROBE_VALUE=carried && pwd")),
      tools(bash("second", 'pwd; echo "$PROBE_VALUE"')),
      tools(bash("noisy", "head -c 500000 /dev/zero | tr '\\0' 'x'; echo; echo END")),
      tools({ type: "tool_use", id: "restart", name: "bash", input: { restart: true } }),
      tools(bash("third", "pwd")),
      done,
    ]);
    const second = scenario.results.get("second")?.content ?? "";
    const noisy = scenario.results.get("noisy")?.content ?? "";
    const third = scenario.results.get("third")?.content ?? "";
    const passed =
      second.includes("/workspace/sub") &&
      second.includes("carried") &&
      Buffer.byteLength(noisy) < config.claude.toolOutputMaxBytes + 200 &&
      noisy.includes("bytes omitted by AgentGuard") &&
      noisy.includes("END") &&
      third.trim() === "/workspace";
    record("the shell session persists across calls, restart resets it, and output is bounded", passed, { second, noisyBytes: Buffer.byteLength(noisy), third });
  }

  // 11. A command that overruns is stopped inside the container.
  {
    const scenario = await run([tools(bash("slow", "sleep 300")), done], {});
    const output = scenario.results.get("slow")?.content ?? "";
    record("a command past its limit is stopped", output.includes("stopped after its limit"), { output });
  }

  // 12. Cancelling stops the command and removes the container.
  {
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 2_500).unref();
    const scenario = await run([tools(bash("sleep", "sleep 300")), done], { signal: controller.signal });
    const elapsed = Date.now() - startedAt;
    const gone = !containerExists(scenario.executionId);
    record("cancelling mid-command raises RunCancelledError and removes the container", scenario.error instanceof RunCancelledError && gone && elapsed < 15_000, {
      error: String(scenario.error),
      containerGone: gone,
      elapsedMs: elapsed,
    });
  }

  // 13. Nothing is left behind by a normal run either.
  {
    const left = execFileSync(config.containerEngine, ["ps", "--all", "--quiet", "--filter", `label=io.codejam.instance-id=${config.runtimeInstanceId}`, "--filter", "label=io.codejam.agent-id=probe-agent"], { encoding: "utf8" }).trim();
    record("no probe container is left running", left === "", { left });
  }
} finally {
  mockApi.closeAllConnections();
  mockApi.close();
  rmSync(root, { recursive: true, force: true });
}

const passed = report.every((entry) => entry.passed === true);
console.log(JSON.stringify({ passed, image: IMAGE, scenarios: report }, null, 2));
process.exitCode = passed ? 0 : 1;
