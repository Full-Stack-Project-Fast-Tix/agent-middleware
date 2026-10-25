import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// End-to-end check of the pinned Codex app-server approval boundary. The mock
// Responses API returns one deterministic apply_patch call; no model account or
// API key is used, and the container can write only to this disposable folder.
const image = process.env.CODEX_RUNTIME_IMAGE ?? "volc-agent-runtime:local";
const runtimeVersion = execFileSync("docker", ["run", "--rm", "--env", "CODEX_HOME=/workspace", image, "codex", "--version"], { encoding: "utf8" }).trim();
if (!runtimeVersion.includes("0.111.0")) {
  throw new Error(`Expected pinned Codex 0.111.0, got: ${runtimeVersion}`);
}
const root = mkdtempSync(path.join(tmpdir(), "agentguard-codex-approval-"));
const workspace = path.join(root, "workspace");
const codexHome = path.join(root, "codex-home");
const targetPath = path.join(workspace, "approval-probe.txt");
mkdirSync(workspace);
mkdirSync(codexHome);

let apiRequests = 0;
let applyPatchAvailable = false;
let webSearchAvailable = false;
let fileChangeApproval = false;
let declined = false;
const lifecycle = [];
let finished = false;
let timer;

const mockApi = createServer((request, response) => {
  if (request.method === "GET" && request.url?.endsWith("/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model", created: 0, owned_by: "openai" }] }));
    return;
  }
  if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
    response.writeHead(404).end();
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    apiRequests += 1;
    const apiRequest = JSON.parse(body);
    if (apiRequests === 1) {
      applyPatchAvailable = (apiRequest.tools ?? []).some(
        (tool) => tool.type === "custom" && tool.name === "apply_patch",
      );
      webSearchAvailable = (apiRequest.tools ?? []).some(
        (tool) => tool.type === "web_search" || tool.name === "web_search",
      );
    }

    const output = apiRequests === 1
      ? [{
          id: "patch_probe",
          type: "custom_tool_call",
          call_id: "call_probe",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Add File: approval-probe.txt\n+created by mock\n*** End Patch",
        }]
      : [{
          id: "message_probe",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Probe finished." }],
        }];
    const codexResponse = {
      id: `response_probe_${apiRequests}`,
      object: "response",
      created_at: 0,
      status: "completed",
      model: "mock-model",
      output,
    };
    const events = [
      { type: "response.created", response: { ...codexResponse, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...output[0], status: "in_progress" } },
      { type: "response.output_item.done", output_index: 0, item: output[0] },
      { type: "response.completed", response: codexResponse },
    ];
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
});

await new Promise((resolve, reject) => {
  mockApi.once("error", reject);
  mockApi.listen(0, "0.0.0.0", resolve);
});
const { port } = mockApi.address();
writeFileSync(
  path.join(codexHome, "config.toml"),
  `model = "gpt-5.1-codex"\napproval_policy = "untrusted"\nsandbox_mode = "workspace-write"\nmodel_provider = "mock_provider"\n[model_providers.mock_provider]\nname = "AgentGuard local mock"\nbase_url = "http://host.docker.internal:${port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nsupports_websockets = false\n`,
);

const runtime = spawn("docker", [
  "run", "--rm", "-i",
  "--mount", `type=bind,src=${workspace},dst=/workspace`,
  "--mount", `type=bind,src=${codexHome},dst=/codex-home`,
  "--env", "CODEX_HOME=/codex-home",
  "--env", "HOME=/tmp",
  "--workdir", "/workspace",
  image, "codex", "app-server", "--config", 'web_search="disabled"', "--listen", "stdio://",
], { stdio: ["pipe", "pipe", "pipe"] });
const appServerLines = createInterface({ input: runtime.stdout });
const pending = new Map();
let nextId = 1;

function finish(kind, turn = null, error = null) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  const fileExists = existsSync(targetPath);
  const passed = kind === "turn-completed" && applyPatchAvailable && !webSearchAvailable && fileChangeApproval && declined && !fileExists;
  console.log(JSON.stringify({
    passed,
    runtimeImage: image,
    runtimeVersion,
    outcome: kind,
    turnStatus: turn?.status ?? null,
    error,
    applyPatchAvailable,
    webSearchAvailable,
    fileChangeApproval,
    declined,
    fileExists,
    apiRequests,
    lifecycle,
  }));
  process.exitCode = passed ? 0 : 1;
  runtime.kill();
  mockApi.close();
  runtime.once("exit", () => rmSync(root, { recursive: true, force: true }));
}

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    runtime.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

appServerLines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }

  if (message.id !== undefined && message.method) {
    if (message.method === "item/fileChange/requestApproval") {
      fileChangeApproval = true;
      lifecycle.push("file-change-approval-requested");
    }
    if (message.method.endsWith("/requestApproval")) {
      declined = true;
      lifecycle.push("approval-declined");
      runtime.stdin.write(JSON.stringify({ id: message.id, result: { decision: "decline" } }) + "\n");
    } else {
      runtime.stdin.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
    }
    return;
  }

  if (message.id !== undefined) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
    return;
  }

  const item = message.params?.item;
  if ((message.method === "item/started" || message.method === "item/completed") && item?.type === "fileChange") {
    lifecycle.push(`${message.method}:${item.status ?? "started"}`);
  }
  if (message.method === "turn/completed") finish("turn-completed", message.params?.turn);
  if (message.method === "error") finish("app-server-error", null, message.params?.error?.message ?? "unknown app-server error");
});

runtime.once("error", (error) => finish("runtime-start-error", null, error.message));
runtime.once("exit", (code) => { if (!finished) finish("runtime-exited", null, `container exited with ${code}`); });
timer = setTimeout(() => finish("timeout", null, "Timed out waiting for the Codex turn"), 45_000);

try {
  await rpc("initialize", { clientInfo: { name: "agentguard-approval-probe", title: "AgentGuard approval probe", version: "1.0.0" } });
  runtime.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const thread = await rpc("thread/start", {
    cwd: "/workspace",
    sandbox: "workspace-write",
    approvalPolicy: "untrusted",
  });
  await rpc("turn/start", {
    threadId: thread.thread.id,
    input: [{ type: "text", text: "Create approval-probe.txt using apply_patch with the content: created by mock" }],
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/workspace"],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    approvalPolicy: "untrusted",
  });
} catch (error) {
  finish("rpc-error", null, String(error?.message ?? error));
}
