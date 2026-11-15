import { readFile, writeFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { runDiffResponseSchema, type RunDiffResponse } from "@launchpad/shared";
import { listWorkspaceFiles, readWorkspaceFile, resolveInside, MAX_READ_BYTES } from "./workspace-files.js";
import { redactSensitiveText } from "./redaction/index.js";

type Baseline = {
  files: Record<string, { hash: string; text: string | null; size: number; display: "text" | "binary" | "large" }>;
  truncated: boolean;
};

/** Builds and persists the same bounded, redacted Run diff used by Run Detail. */
export async function buildRunDiff(
  workspaceRoot: string,
  baselinePath: string,
  artifactPath: string,
): Promise<RunDiffResponse> {
  const saved = await readFile(artifactPath, "utf8").then((text) => JSON.parse(text) as unknown).catch(() => null);
  if (saved !== null) return runDiffResponseSchema.parse(saved);
  const baseline = await readFile(baselinePath, "utf8")
    .then((text) => JSON.parse(text) as Baseline)
    .catch(() => null);
  if (baseline === null) {
    return runDiffResponseSchema.parse({ changes: [], changedFileCount: 0, truncated: false, baselineAvailable: false });
  }

  const current = await listWorkspaceFiles(workspaceRoot);
  const currentMap = new Map<string, string>();
  let oversizedFiles = false;
  const realRoot = await realpath(workspaceRoot).catch(() => workspaceRoot);
  for (const file of current) {
    const absolute = resolveInside(workspaceRoot, file.path);
    const realFile = await realpath(absolute).catch(() => null);
    if (realFile === null || !realFile.startsWith(realRoot + path.sep)) continue;
    const info = await stat(realFile).catch(() => null);
    if (info === null) continue;
    if (info.size > 2 * 1024 * 1024) { oversizedFiles = true; continue; }
    const bytes = await readFile(realFile).catch(() => null);
    if (bytes !== null) currentMap.set(file.path, createHash("sha256").update(bytes).digest("hex"));
  }

  const paths = new Set([...Object.keys(baseline.files), ...currentMap.keys()]);
  const changes: RunDiffResponse["changes"][number][] = [];
  let changedFileCount = 0;
  for (const filePath of [...paths].sort()) {
    const before = baseline.files[filePath];
    const after = currentMap.get(filePath);
    if (before?.hash === after || (before === undefined && after === undefined)) continue;
    const kind = before === undefined ? "added" : after === undefined ? "deleted" : "modified";
    let diff: string | null = null;
    let display: RunDiffResponse["changes"][number]["display"] = "unavailable";
    if (kind !== "deleted") {
      const file = await readWorkspaceFile(workspaceRoot, filePath).catch(() => null);
      if (file === null) display = "unavailable";
      else if (file.size > MAX_READ_BYTES || file.truncated) display = "large";
      else if (file.content.includes("\0")) display = "binary";
      else {
        display = "text";
        const oldLines = (before?.text ?? "").split("\n").slice(0, 200);
        const newLines = file.content.split("\n").slice(0, 200);
        diff = redactSensitiveText([
          ...oldLines.filter((line) => !newLines.includes(line)).map((line) => "- " + line),
          ...newLines.filter((line) => !oldLines.includes(line)).map((line) => "+ " + line),
        ].join("\n")).slice(0, 20_000);
      }
    } else if (before?.display === "text") {
      display = "text";
      diff = redactSensitiveText((before.text ?? "").split("\n").slice(0, 200).map((line) => "- " + line).join("\n")).slice(0, 20_000);
    } else if (before !== undefined) {
      display = before.display;
    }
    changedFileCount += 1;
    if (changes.length < 500) changes.push({ path: filePath, kind, diff, display });
  }
  const artifact = runDiffResponseSchema.parse({
    changes,
    changedFileCount,
    truncated: baseline.truncated || current.length >= 500 || oversizedFiles || changedFileCount > changes.length,
    baselineAvailable: true,
  });
  await writeFile(artifactPath, JSON.stringify(artifact), { mode: 0o600 });
  return artifact;
}
