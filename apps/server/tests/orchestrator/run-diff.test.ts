import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isRunDiffComplete, SNAPSHOT_LIMITS, type Run, type RunDiffChange, type RunDiffResponse } from "@launchpad/shared";
import { DirectoryWorkingCopies, runDiffPaths } from "../../src/orchestrator/working-copies.js";
import { diffLines, splitLines } from "../../src/line-diff.js";
import { loadOrComputeRunDiff } from "../../src/run-diff.js";
import { captureSnapshot } from "../../src/workspace-snapshot.js";

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const run = (id = RUN_ID) => ({ id, workspaceId: "00000000-0000-4000-8000-000000000001", parentRunId: null }) as Run;

/** A source folder with these files, copied into a Run copy whose baseline is taken; returns the copy. */
async function prepared(files: Record<string, string | Buffer>) {
  const base = await mkdtemp(path.join(tmpdir(), "run-diff-"));
  temporary.push(base);
  const source = path.join(base, "project");
  await mkdir(source);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), content);
  }
  const copies = new DirectoryWorkingCopies({ root: path.join(base, "runs"), sources: { sourcePath: async () => source } });
  const workspace = await copies.prepare(run());
  return {
    base,
    copies,
    workspace,
    write: async (file: string, content: string | Buffer) => {
      await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
      await writeFile(path.join(workspace, file), content);
    },
    remove: (file: string) => rm(path.join(workspace, file), { recursive: true, force: true }),
    diff: () => copies.diff(RUN_ID),
  };
}

const lines = (count: number, label = "line") => Array.from({ length: count }, (_, index) => `${label} ${index + 1}`).join("\n") + "\n";
const only = (diff: RunDiffResponse, file: string): RunDiffChange => {
  const change = diff.changes.find((candidate) => candidate.path === file);
  if (change === undefined) throw new Error(`${file} is not in the diff: ${diff.changes.map((c) => c.path).join(", ")}`);
  return change;
};
const hunkText = (change: RunDiffChange) => change.hunks.map((hunk) => hunk.text).join("\n");

/** Apply unified hunks to old lines, to prove a diff reconstructs the new text exactly. */
function apply(oldLines: string[], hunks: ReturnType<typeof diffLines>["hunks"]): string[] {
  const result: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    while (cursor < start) result.push(oldLines[cursor++]!);
    for (const line of hunk.text.split("\n")) {
      const body = line.slice(1);
      if (line.startsWith(" ")) {
        expect(oldLines[cursor]).toBe(body);
        result.push(body);
        cursor += 1;
      } else if (line.startsWith("-")) {
        expect(oldLines[cursor]).toBe(body);
        cursor += 1;
      } else {
        result.push(body);
      }
    }
  }
  while (cursor < oldLines.length) result.push(oldLines[cursor++]!);
  return result;
}

describe("line diff", () => {
  it("shows reorders and duplicate-line count changes that a set comparison would miss", () => {
    const reordered = diffLines(["a", "b", "c"], ["c", "a", "b"], { context: 1 });
    expect(reordered.hunks.map((hunk) => hunk.text).join("\n")).toMatch(/[-+]c/);
    const duplicated = diffLines(["x", "y"], ["x", "y", "y"], { context: 0 });
    expect(duplicated.hunks).toEqual([{ oldStart: 2, oldLines: 0, newStart: 3, newLines: 1, text: "+y" }]);
  });

  it("reconstructs the new text exactly for random edits, including when the edit budget forces a coarse replacement", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let trial = 0; trial < 200; trial += 1) {
      const oldLines = Array.from({ length: Math.floor(random() * 40) }, () => String.fromCharCode(97 + Math.floor(random() * 5)));
      const newLines = [...oldLines];
      for (let edit = 0; edit < Math.floor(random() * 8); edit += 1) {
        const at = Math.floor(random() * (newLines.length + 1));
        if (random() < 0.5 && newLines.length > 0) newLines.splice(Math.min(at, newLines.length - 1), 1);
        else newLines.splice(at, 0, String.fromCharCode(97 + Math.floor(random() * 5)));
      }
      for (const maxEdits of [1_500, 2]) {
        const diff = diffLines(oldLines, newLines, { context: 2, maxEdits });
        expect(apply(oldLines, diff.hunks)).toEqual(newLines);
      }
    }
  });
});

describe("Run diff", () => {
  it("shows an edit after line 200 with its real position", async () => {
    const copy = await prepared({ "src/long.ts": lines(400) });
    await copy.write("src/long.ts", lines(400).replace("line 350\n", "line 350 changed\n"));
    const diff = await copy.diff();
    const change = only(diff, "src/long.ts");
    expect(change).toMatchObject({ kind: "modified", content: "complete" });
    expect(change.hunks).toHaveLength(1);
    expect(change.hunks[0]).toMatchObject({ oldStart: 348, newStart: 348 });
    expect(hunkText(change)).toContain("-line 350\n+line 350 changed");
    expect(isRunDiffComplete(diff)).toBe(true);
  });

  it("shows a reorder and a duplicated line in a modified file", async () => {
    const copy = await prepared({ "a.txt": "one\ntwo\nthree\n", "b.txt": "x\ny\n" });
    await copy.write("a.txt", "three\none\ntwo\n");
    await copy.write("b.txt", "x\ny\ny\n");
    const diff = await copy.diff();
    expect(hunkText(only(diff, "a.txt"))).toMatch(/\+three|-three/);
    expect(hunkText(only(diff, "b.txt"))).toContain("+y");
    expect(diff.changedFileCount).toBe(2);
  });

  it("reports deletions with their removed lines, and additions including dotfiles", async () => {
    const copy = await prepared({ "old.js": "export const old = 1;\n", ".eslintrc": "{}\n" });
    await copy.remove("old.js");
    await copy.write(".eslintrc", '{"rules":{}}\n');
    await copy.write("docs/new.md", "# New\n");
    const diff = await copy.diff();
    expect(only(diff, "old.js")).toMatchObject({ kind: "deleted", content: "complete" });
    expect(hunkText(only(diff, "old.js"))).toBe("-export const old = 1;\n-");
    expect(only(diff, ".eslintrc")).toMatchObject({ kind: "modified", content: "complete" });
    expect(only(diff, "docs/new.md")).toMatchObject({ kind: "added", content: "complete" });
  });

  it("marks an added binary file as changed with unavailable contents", async () => {
    const copy = await prepared({ "readme.md": "hi\n" });
    await copy.write("logo.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const change = only(await copy.diff(), "logo.png");
    expect(change).toMatchObject({ kind: "added", content: "unavailable", reasons: ["binary"] });
  });

  it("never shows a present oversized file as deleted: a size change is a change, an equal size is uncertain", async () => {
    const big = Buffer.alloc(SNAPSHOT_LIMITS.maxHashFileBytes + 10, 97);
    const copy = await prepared({ "data/big.bin": big, "data/same.bin": big });
    await copy.write("data/big.bin", Buffer.alloc(SNAPSHOT_LIMITS.maxHashFileBytes + 20, 98));
    const diff = await copy.diff();
    expect(only(diff, "data/big.bin")).toMatchObject({ kind: "modified", content: "unavailable", reasons: ["oversized"] });
    expect(only(diff, "data/same.bin")).toMatchObject({ kind: "uncertain", reasons: ["size_only_comparison"] });
    expect(diff.uncertainCount).toBe(1);
    expect(isRunDiffComplete(diff)).toBe(false);
    expect(diff.changes.some((change) => change.kind === "deleted")).toBe(false);
  });

  it("keeps excluded directories out of both scans and stops visibly at the depth limit", async () => {
    const deep = Array.from({ length: SNAPSHOT_LIMITS.maxDepth + 1 }, (_, index) => `d${index}`).join("/");
    const copy = await prepared({ "node_modules/pkg/index.js": "1\n", "dist/out.js": "1\n", [`${deep}/deep.txt`]: "deep\n" });
    await copy.write("node_modules/pkg/index.js", "2\n");
    await copy.write("build/new.js", "1\n");
    const diff = await copy.diff();
    expect(diff.changes).toEqual([]);
    expect(diff.coverage.inventory.status).toBe("incomplete");
    expect(diff.coverage.inventory.baseline?.stopReasons).toEqual(["depth_limit"]);
    expect(diff.scope.excludedDirectories).toEqual(expect.arrayContaining(["node_modules", ".git", "dist", "build"]));
  });

  it.skipIf(process.platform === "win32")("records links by target without following them, and keeps their content partial", async () => {
    const copy = await prepared({ "src/a.ts": "a\n" });
    const outside = path.join(copy.base, "outside-secret.txt");
    await writeFile(outside, "PRIVATE=1\n");
    await symlink(outside, path.join(copy.workspace, "leak"));
    const change = only(await copy.diff(), "leak");
    expect(change).toMatchObject({ kind: "added", entryType: "symlink", content: "partial", reasons: ["link_not_followed"] });
    // The target is shown (redacted, so a long path segment may be fingerprinted), never read.
    expect(hunkText(change)).toMatch(/^\+symlink -> .*outside-secret\.txt$/);
    expect(JSON.stringify(await readFile(runDiffPaths(copy.workspace).artifactPath, "utf8"))).not.toContain("PRIVATE=1");
  });

  it.skipIf(process.platform === "win32")("treats a directory replaced by a link as a deletion, without reading through it", async () => {
    const copy = await prepared({ "src/a.ts": "a\n" });
    const outside = path.join(copy.base, "elsewhere");
    await mkdir(outside);
    await writeFile(path.join(outside, "a.ts"), "outside\n");
    await copy.remove("src");
    await symlink(outside, path.join(copy.workspace, "src"));
    const diff = await copy.diff();
    expect(only(diff, "src/a.ts")).toMatchObject({ kind: "deleted" });
    expect(only(diff, "src")).toMatchObject({ kind: "added", entryType: "symlink" });
  });

  it("distinguishes exactly 500 files (complete) from 501 (stopped)", async () => {
    const files = Object.fromEntries(Array.from({ length: SNAPSHOT_LIMITS.maxFiles }, (_, index) => [`f/${String(index).padStart(3, "0")}.txt`, "x\n"]));
    const full = await prepared(files);
    const fullDiff = await full.diff();
    expect(fullDiff.coverage.inventory.status).toBe("complete");
    expect(fullDiff.coverage.inventory.baseline?.entriesRecorded).toBe(500);

    const over = await prepared({ ...files, "f/zzz.txt": "x\n" });
    await over.write("f/000.txt", "changed\n");
    const overDiff = await over.diff();
    expect(overDiff.coverage.inventory.reasons).toEqual(["baseline_scan_incomplete", "final_scan_incomplete"]);
    expect(overDiff.coverage.inventory.baseline?.stopReasons).toEqual(["file_limit"]);
    expect(only(overDiff, "f/000.txt")).toMatchObject({ kind: "modified" });
    expect(isRunDiffComplete(overDiff)).toBe(false);
  });

  it("keeps a large baseline bounded: files past the text budget are changed with unavailable contents", async () => {
    const chunk = "y".repeat(SNAPSHOT_LIMITS.maxTextFileBytes - 10) + "\n";
    const files = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`big/${index}.txt`, chunk]));
    const copy = await prepared(files);
    await copy.write("big/8.txt", chunk + "more\n");
    const change = only(await copy.diff(), "big/8.txt");
    expect(change).toMatchObject({ kind: "modified", content: "unavailable", reasons: ["baseline_text_not_retained"] });
    const baseline = await readFile(runDiffPaths(copy.workspace).baselinePath, "utf8");
    expect(baseline.length).toBeLessThan(SNAPSHOT_LIMITS.maxBaselineTextBytes + 200_000);
  });

  it("withholds a credential-named file's contents and redacts secrets in hunks", async () => {
    const copy = await prepared({ "config.js": "export const key = 'none';\n" });
    await copy.write(".env", "API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789\n");
    await copy.write("config.js", "export const key = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';\n");
    const diff = await copy.diff();
    expect(only(diff, ".env")).toMatchObject({ kind: "added", content: "unavailable", reasons: ["credential_withheld"] });
    const saved = await readFile(runDiffPaths(copy.workspace).artifactPath, "utf8");
    expect(saved).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(hunkText(only(diff, "config.js"))).toContain("+export const key = 'sk-");
  });

  it("reports a change hidden by text decoding as a partial change, never an empty complete diff", async () => {
    const copy = await prepared({ "bytes.txt": Buffer.from([0x61, 0xff, 0x0a]) });
    await copy.write("bytes.txt", Buffer.from([0x61, 0xfe, 0x0a]));
    expect(only(await copy.diff(), "bytes.txt")).toMatchObject({
      kind: "modified",
      content: "partial",
      reasons: ["redacted_or_encoding_change"],
      hunks: [],
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("marks a file that became unreadable as uncertain, not deleted or unchanged", async () => {
    const copy = await prepared({ "locked.txt": "a\n" });
    await chmod(path.join(copy.workspace, "locked.txt"), 0o000);
    try {
      expect(only(await copy.diff(), "locked.txt")).toMatchObject({ kind: "uncertain", reasons: ["unreadable"] });
    } finally {
      await chmod(path.join(copy.workspace, "locked.txt"), 0o600);
    }
  });

  it("saves the artifact once and serves the saved copy after the files change", async () => {
    const copy = await prepared({ "a.txt": "a\n" });
    await copy.write("a.txt", "b\n");
    const first = await copy.diff();
    await copy.write("a.txt", "c\n");
    expect(await copy.diff()).toEqual(first);
  });

  it("never captures a replacement baseline: a missing baseline stays unavailable with an unknown count", async () => {
    const copy = await prepared({ "a.txt": "a\n" });
    const paths = runDiffPaths(copy.workspace);
    await rm(paths.baselinePath);
    await copy.write("a.txt", "edited\n");
    // Preparing again (as after an interrupted start) must not take a new baseline.
    await copy.copies.prepare(run());
    const diff = await copy.diff();
    expect(diff).toMatchObject({ baseline: "missing", changedFileCount: null, changes: [] });
    expect(diff.coverage.inventory.status).toBe("unavailable");
    await expect(readFile(paths.baselinePath)).rejects.toThrow();
  });

  it("treats an older-format baseline or cached artifact as legacy and claims no coverage", async () => {
    const copy = await prepared({ "a.txt": "a\n" });
    const paths = runDiffPaths(copy.workspace);
    await writeFile(paths.baselinePath, JSON.stringify({ files: {}, truncated: false }));
    expect(await copy.diff()).toMatchObject({ baseline: "legacy", changedFileCount: null });

    await writeFile(paths.artifactPath, JSON.stringify({
      changes: [{ path: "a.txt", kind: "modified", diff: "+ b", display: "text" }],
      changedFileCount: 1,
      truncated: false,
      baselineAvailable: true,
    }));
    const legacy = await loadOrComputeRunDiff(paths);
    expect(legacy).toMatchObject({ version: 1, baseline: "legacy", changedFileCount: 1 });
    expect(legacy.changes[0]).toMatchObject({ content: "partial" });
    expect(legacy.coverage.inventory.reasons).toEqual(["legacy_artifact"]);
    expect(isRunDiffComplete(legacy)).toBe(false);
  });

  it("reports an unreadable directory as incomplete coverage rather than empty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "snapshot-"));
    temporary.push(root);
    await mkdir(path.join(root, "a", "b"), { recursive: true });
    await writeFile(path.join(root, "a", "b", "c.txt"), "c\n");
    const limited = await captureSnapshot(root, { retainText: false, limits: { maxDirectoryEntries: 2 } });
    expect(limited.coverage).toMatchObject({ complete: false, stopReasons: ["traversal_limit"] });
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await chmod(path.join(root, "a", "b"), 0o000);
      try {
        const snapshot = await captureSnapshot(root, { retainText: false });
        expect(snapshot.coverage).toMatchObject({ complete: false, stopReasons: ["directory_unreadable"], unreadableDirectories: 1 });
      } finally {
        await chmod(path.join(root, "a", "b"), 0o700);
      }
    }
  });
});
