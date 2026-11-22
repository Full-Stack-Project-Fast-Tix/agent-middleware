// Reproducible controlled evaluation of every guard family and its integration.
// Test-contract passes are not live-model detection rates. Known-gap assertions
// are reported separately from the adversarial cases the egress matcher catches.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(root, process.env.GUARD_EVAL_OUT ?? ".data/evaluations/guard-suite");
mkdirSync(out, { recursive: true });
const jsonPath = path.join(out, "vitest.json");
const logPath = path.join(out, "console.log");
const selectors = ["tests/checks", "tests/reflections", "tests/policy", "tests/semantic", "tests/runtime/claude-checks.test.ts", "tests/integration/secure-run.test.ts", "tests/vault.test.ts", "tests/vault-broker.test.ts", "tests/redaction", "tests/server/auth-routes.test.ts", "tests/server/run-routes.test.ts"];
// --summarize regenerates the report from the saved test run without rerunning it.
let status: number | null = 0;
if (!process.argv.includes("--summarize")) {
  rmSync(jsonPath, { force: true });
  const log = openSync(logPath, "w");
  try {
    const run = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1", "--reporter=json", `--outputFile=${jsonPath}`, ...selectors], { cwd: path.join(root, "apps/server"), stdio: ["ignore", log, log] });
    if (run.error) throw run.error;
    status = run.status;
  } finally { closeSync(log); }
}

interface Assertion { fullName: string; status: string }
interface Suite { name: string; status: string; startTime: number; endTime: number; assertionResults: Assertion[] }
interface Results { success: boolean; numTotalTests: number; numPassedTests: number; numFailedTests: number; testResults: Suite[] }
const results = JSON.parse(readFileSync(jsonPath, "utf8")) as Results;
const familyOf = (name: string) => {
  const file = name.replaceAll("\\", "/");
  if (file.endsWith("check-sensitive-egress.bypass.test.ts")) return "egress-adversarial";
  if (file.endsWith("check-sensitive-egress.test.ts")) return "sensitive-egress";
  if (file.endsWith("check-outbound-blob.test.ts")) return "outbound-blob";
  if (file.endsWith("check-agent-intent.test.ts")) return "agent-intent";
  if (file.endsWith("/checks/checks.test.ts")) return "trace-adapters";
  if (file.includes("/reflections/")) return "learned-watch-and-memory";
  if (file.endsWith("semantic-run-diff.test.ts")) return "final-diff-review";
  if (file.includes("/semantic/")) return "semantic-monitor-and-controller";
  if (file.includes("/policy/")) return "capabilities-taint-and-approvals";
  if (file.includes("/runtime/") || file.includes("/integration/")) return "runtime-and-multi-agent-integration";
  if (file.endsWith("vault.test.ts") || file.endsWith("vault-broker.test.ts") || file.endsWith("run-routes.test.ts")) return "vault-and-workspace-api";
  if (file.includes("/redaction/")) return "redaction";
  if (file.endsWith("auth-routes.test.ts")) return "authentication-and-throttling";
  throw new Error(`Unclassified evaluation file: ${file}`);
};
const groups: Record<string, { files: number; passed: number; failed: number; other: number }> = {};
const tests: Array<{ file: string; family: string; name: string; status: string }> = [];
for (const suite of results.testResults) {
  const family = familyOf(suite.name);
  const group = groups[family] ??= { files: 0, passed: 0, failed: 0, other: 0 };
  group.files++;
  for (const assertion of suite.assertionResults) {
    group[assertion.status === "passed" ? "passed" : assertion.status === "failed" ? "failed" : "other"]++;
    tests.push({ file: path.relative(root, suite.name).replaceAll("\\", "/"), family, name: assertion.fullName, status: assertion.status });
  }
}
if (Object.keys(groups).length !== 13) throw new Error("Evaluation did not discover every expected family.");
const bypass = tests.filter((t) => t.family === "egress-adversarial");
const ended = Math.max(...results.testResults.map((s) => s.endTime));
const started = Math.min(...results.testResults.map((s) => s.startTime));
const summary = { kind: "controlled-guard-contract-evaluation", liveModelAccuracy: false, command: "npm run eval:guards", maxWorkers: 1, testTimeoutMs: 5000, recordedAt: new Date(ended).toISOString(), seconds: (ended - started) / 1000, success: results.success && status === 0, total: results.numTotalTests, passed: results.numPassedTests, failed: results.numFailedTests, groups,
  adversarialEgress: { caughtCases: bypass.filter((t) => t.name.includes("corpus ") && t.name.includes("caught")), knownGapCases: bypass.filter((t) => t.name.includes("known gaps")) }, tests };
writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
for (const [family, group] of Object.entries(groups)) console.log(`${family}: ${group.passed} passed, ${group.failed} failed, ${group.other} other`);
console.log(`Total ${summary.passed}/${summary.total}; report: ${path.join(out, "summary.json")}`);
process.exitCode = summary.success ? 0 : 1;
