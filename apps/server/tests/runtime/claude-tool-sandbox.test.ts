import { describe, expect, it } from "vitest";
import {
  BoundedOutput,
  buildToolContainerRunArgs,
  DockerToolSandboxProvider,
  isRootUser,
  sandboxClientEnvironment,
  SHELL_SESSION_SCRIPT,
  WORKSPACE_FILE_SCRIPT,
  type SandboxConfig,
} from "../../src/claude-tool-sandbox.js";
import {
  bashInputSchema,
  boundToolText,
  decodeText,
  editorInputSchema,
  formatFileView,
  planInsert,
  planOverwrite,
  planStrReplace,
  resolveWorkspacePath,
  viewCommandText,
} from "../../src/claude-editor.js";
import { TEST_API_KEY } from "./claude-fakes.js";

const CONFIG: SandboxConfig = {
  containerEngine: "docker",
  containerRuntimeImage: "agentguard-claude-runtime:local",
  containerCpuLimit: 2,
  containerMemoryLimit: "2g",
  containerPidsLimit: 256,
  containerUser: "1000:1000",
  runtimeInstanceId: "test",
};
const REQUEST = { agentId: "agent-1", executionId: "execution-1", workspacePath: "/data/workspace", denyNetwork: true, writable: true };

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

describe("the tool container's arguments", () => {
  it("has no network at all when the policy denies it", () => {
    expect(flag(buildToolContainerRunArgs(REQUEST, CONFIG), "--network")).toBe("none");
  });

  it("keeps today's bridge when the policy allows network", () => {
    expect(flag(buildToolContainerRunArgs({ ...REQUEST, denyNetwork: false }, CONFIG), "--network")).toBe("bridge");
  });

  it("is disposable, unprivileged and limited", () => {
    const args = buildToolContainerRunArgs(REQUEST, CONFIG);
    expect(args).toContain("--rm");
    expect(args).toContain("--init");
    expect(flag(args, "--security-opt")).toBe("no-new-privileges");
    expect(flag(args, "--cap-drop")).toBe("ALL");
    expect(flag(args, "--cpus")).toBe("2");
    expect(flag(args, "--memory")).toBe("2g");
    expect(flag(args, "--pids-limit")).toBe("256");
    expect(flag(args, "--user")).toBe("1000:1000");
    expect(flag(args, "--workdir")).toBe("/workspace");
    expect(flag(args, "--pull")).toBe("never");
    expect(flag(args, "--name")).toBe("launchpad-test-execution-1");
  });

  it("mounts only the working copy, read-only unless the execution may write", () => {
    const mounts = (writable: boolean) => {
      const args = buildToolContainerRunArgs({ ...REQUEST, writable }, CONFIG);
      return args.filter((_value, index) => args[index - 1] === "--mount");
    };
    expect(mounts(true)).toEqual(["type=bind,src=/data/workspace,dst=/workspace"]);
    expect(mounts(false)).toEqual(["type=bind,src=/data/workspace,dst=/workspace,readonly"]);
  });

  it("uses keep-id under podman", () => {
    expect(flag(buildToolContainerRunArgs(REQUEST, { ...CONFIG, containerEngine: "/usr/bin/podman" }), "--userns")).toBe("keep-id");
  });

  it("names no credential: nothing about the key in the arguments", () => {
    const args = buildToolContainerRunArgs(REQUEST, CONFIG).join(" ");
    expect(args).not.toMatch(/ANTHROPIC|API_KEY/);
    const env = buildToolContainerRunArgs(REQUEST, CONFIG).filter((_value, index, all) => all[index - 1] === "--env");
    expect(env).toEqual(["HOME=/tmp", "NO_COLOR=1"]);
  });
});

describe("the docker client's environment", () => {
  it("lists what it passes, so the server's key cannot come along", () => {
    const environment = sandboxClientEnvironment({ PATH: "/bin", HOME: "/home/x", ANTHROPIC_API_KEY: TEST_API_KEY, ANTHROPIC_AUTH_TOKEN: "t", OTHER: "y" });
    expect(environment).toEqual({ NO_COLOR: "1", PATH: "/bin", HOME: "/home/x" });
  });
});

describe("running as root", () => {
  it("recognizes root however it is written", () => {
    for (const user of ["0", "0:0", "root", "root:root", " 0:1000"]) expect(isRootUser(user)).toBe(true);
    for (const user of ["1000:1000", "501:20", "node", "100"]) expect(isRootUser(user)).toBe(false);
  });

  it("refuses to start a container as root", async () => {
    await expect(new DockerToolSandboxProvider({ ...CONFIG, containerUser: "0:0" }).start(REQUEST)).rejects.toThrow("non-root");
  });
});

describe("scripts that run inside the container", () => {
  it("take no parameters from the host's process, only stdin", () => {
    expect(SHELL_SESSION_SCRIPT).toContain('AG_COMMAND="$(cat)"');
    expect(WORKSPACE_FILE_SCRIPT).toContain('fs.readFileSync(0, "utf8")');
  });

  it("are syntactically valid", () => {
    expect(() => new Function("require", "process", WORKSPACE_FILE_SCRIPT)).not.toThrow();
  });
});

describe("BoundedOutput", () => {
  it("keeps everything under the limit", () => {
    const output = new BoundedOutput(100);
    output.append(Buffer.from("hello "));
    output.append(Buffer.from("world"));
    expect(output.toString()).toBe("hello world");
    expect(output.truncated).toBe(false);
  });

  it("keeps the start and the end of what is over it, and says how much went", () => {
    const output = new BoundedOutput(10);
    output.append(Buffer.from("AAAAA"));
    for (let index = 0; index < 100; index += 1) output.append(Buffer.from("xxxx"));
    output.append(Buffer.from("ZZZZZ"));
    expect(output.truncated).toBe(true);
    expect(output.toString()).toBe("AAAAA\n[... 400 bytes omitted by AgentGuard ...]\nZZZZZ");
  });
});

describe("resolveWorkspacePath", () => {
  it("accepts paths inside /workspace and makes them absolute", () => {
    expect(resolveWorkspacePath("/workspace")).toBe("/workspace");
    expect(resolveWorkspacePath("/workspace/")).toBe("/workspace");
    expect(resolveWorkspacePath("/workspace/src/a.ts")).toBe("/workspace/src/a.ts");
    expect(resolveWorkspacePath("src/a.ts")).toBe("/workspace/src/a.ts");
    expect(resolveWorkspacePath("./src//a.ts")).toBe("/workspace/src/a.ts");
    // Literal, never decoded.
    expect(resolveWorkspacePath("%2e%2e/a")).toBe("/workspace/%2e%2e/a");
  });

  it.each([
    "/workspace/../etc/passwd",
    "../a",
    "a/../../b",
    "a/../b",
    "/etc/passwd",
    "/workspace-other/a",
    "/",
    "",
    "   ",
    "a\0b",
  ])("refuses %j", (raw) => {
    expect(resolveWorkspacePath(raw)).toBeNull();
  });
});

describe("tool input validation", () => {
  it("accepts the documented shapes", () => {
    expect(bashInputSchema.safeParse({ command: "ls" }).success).toBe(true);
    expect(bashInputSchema.safeParse({ restart: true }).success).toBe(true);
    expect(editorInputSchema.safeParse({ command: "view", path: "a", view_range: [1, -1] }).success).toBe(true);
    expect(editorInputSchema.safeParse({ command: "create", path: "a", file_text: "" }).success).toBe(true);
    expect(editorInputSchema.safeParse({ command: "str_replace", path: "a", old_str: "x" }).success).toBe(true);
    expect(editorInputSchema.safeParse({ command: "insert", path: "a", insert_line: 0, insert_text: "x" }).success).toBe(true);
  });

  it("refuses anything else, so restart cannot smuggle a command", () => {
    expect(bashInputSchema.safeParse({ command: "ls", restart: true }).success).toBe(false);
    expect(bashInputSchema.safeParse({ restart: false }).success).toBe(false);
    expect(bashInputSchema.safeParse({ command: "" }).success).toBe(false);
    expect(editorInputSchema.safeParse({ command: "delete", path: "a" }).success).toBe(false);
    expect(editorInputSchema.safeParse({ command: "create", path: "a" }).success).toBe(false);
    expect(editorInputSchema.safeParse({ command: "str_replace", path: "a", old_str: "" }).success).toBe(false);
    expect(editorInputSchema.safeParse({ command: "view", path: "a", extra: 1 }).success).toBe(false);
  });
});

describe("planning an edit", () => {
  it("replaces exactly one match, as whole-line hunks", () => {
    expect(planStrReplace("one\ntwo\nthree\n", "wo", "OO")).toEqual({ next: "one\ntOO\nthree\n", diff: "@@ -2,1 +2,1 @@\n-two\n+tOO\n" });
    expect(planStrReplace("a\nb\nc", "a\nb", "x")).toEqual({ next: "x\nc", diff: "@@ -1,2 +1,1 @@\n-a\n-b\n+x\n" });
  });

  it("refuses no match and several matches", () => {
    expect(planStrReplace("abc", "z", "y")).toHaveProperty("error");
    expect(planStrReplace("aa bb aa", "aa", "y")).toHaveProperty("error");
  });

  it("inserts after a line, and refuses past the end", () => {
    expect(planInsert("a\nb\n", 0, "x")).toEqual({ next: "x\na\nb\n", diff: "@@ -1,0 +1,1 @@\n+x\n" });
    expect(planInsert("a\nb\n", 2, "x\n")).toEqual({ next: "a\nb\nx\n", diff: "@@ -3,0 +3,1 @@\n+x\n" });
    expect(planInsert("", 0, "x")).toMatchObject({ next: "x\n" });
    expect(planInsert("a\nb\n", 3, "x")).toHaveProperty("error");
  });

  it("describes an overwrite in full", () => {
    expect(planOverwrite("a\n", "b\n").diff).toBe("@@ -1,2 +1,2 @@\n-a\n-\n+b\n+\n");
  });

  it("numbers viewed lines, and refuses a range past the end", () => {
    expect(formatFileView("a\nb\nc\n")).toBe("1\ta\n2\tb\n3\tc");
    expect(formatFileView("a\nb\nc\n", [2, -1])).toBe("2\tb\n3\tc");
    expect(formatFileView("a\nb\nc\n", [1, 2])).toBe("1\ta\n2\tb");
    expect(formatFileView("a\n", [5, 6])).toHaveProperty("error");
    expect(formatFileView("")).toBe("");
  });

  it("expresses a view as a read command the middleware recognizes", () => {
    expect(viewCommandText("/workspace/a.ts")).toBe("cat /workspace/a.ts");
    expect(viewCommandText("/workspace/a.ts", [2, 5])).toBe("sed -n '2,5p' /workspace/a.ts");
    expect(viewCommandText("/workspace/a.ts", [2, -1])).toBe("tail -n +2 /workspace/a.ts");
    expect(viewCommandText("/workspace/a b's")).toBe(`cat '/workspace/a b'\\''s'`);
  });

  it("will not treat binary as text", () => {
    expect(decodeText(Buffer.from("héllo"))).toBe("héllo");
    expect(decodeText(Buffer.from([0x61, 0x00, 0x62]))).toBeNull();
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x41]))).toBeNull();
  });

  it("bounds text by bytes", () => {
    expect(boundToolText("short", 100)).toBe("short");
    const bounded = boundToolText("a".repeat(100) + "b".repeat(100), 20);
    expect(bounded).toBe("a".repeat(10) + "\n[... 180 bytes omitted by AgentGuard ...]\n" + "b".repeat(10));
  });
});
