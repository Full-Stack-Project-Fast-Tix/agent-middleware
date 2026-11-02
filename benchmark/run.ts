#!/usr/bin/env -S npx tsx
// The leash benchmark.
//
//   npx tsx benchmark/run.ts --from benchmark-results/<run> --configs off,egress,egress+reflection
//
// Re-scores recorded traces under other guard configs, for free. To record new
// ones on Claude, use benchmark/run-multi-agent-live.ts. See docs/BENCHMARK.md.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseGuardConfigs } from "./guard-configs.js";
import { runReplay } from "./replay.js";
import { writeReport } from "./report.js";
import { SCENARIOS, SCENARIOS_BY_ID } from "./scenarios/index.js";
import type { Scenario } from "./types.js";

interface Args {
  scenarios: string;
  only: string | null;
  configs: string;
  from: string | null;
  out: string | null;
  faithful: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    scenarios: "all",
    only: null,
    configs: "off,egress",
    from: null,
    out: null,
    faithful: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[(i += 1)];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--scenarios": a.scenarios = next(); break;
      case "--only": a.only = next(); break;
      case "--configs": a.configs = next(); break;
      case "--from": a.from = next(); break;
      case "--faithful": a.faithful = true; break;
      case "--out": a.out = next(); break;
      case "--help": case "-h": printHelp(); process.exit(0); break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  if (a.from === null) throw new Error("--from <results dir> is required");
  return a;
}

function printHelp(): void {
  console.log(
    [
      "leash benchmark",
      "",
      "  --configs off,egress,...    guard configs (default: off,egress)",
      "                              known: off egress egress+intent egress+reflection semantic all",
      "  --scenarios all|<family|id,...>   default: all",
      "  --only <id,...>             restrict to these scenario ids",
      "  --from <dir>                a prior --out directory (required)",
      "  --out <dir>                 default: benchmark-results/<timestamp>",
    ].join("\n"),
  );
}

function selectScenarios(args: Args): Scenario[] {
  let picked = SCENARIOS;
  if (args.scenarios !== "all") {
    const wanted = new Set(args.scenarios.split(",").map((s) => s.trim()));
    picked = picked.filter((s) => wanted.has(s.family) || wanted.has(s.id));
  }
  if (args.only) {
    const ids = new Set(args.only.split(",").map((s) => s.trim()));
    picked = picked.filter((s) => ids.has(s.id));
  }
  if (picked.length === 0) throw new Error("no scenarios matched the selection");
  return picked;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const guardConfigs = parseGuardConfigs(args.configs);
  const scenarios = selectScenarios(args);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(args.out ?? path.join("benchmark-results", stamp));
  mkdirSync(outDir, { recursive: true });

  console.error(
    `scenarios=${scenarios.length} configs=${guardConfigs
      .map((g) => g.name)
      .join(",")} out=${outDir}`,
  );

  if (!existsSync(path.join(args.from!, "manifest.jsonl"))) {
    throw new Error(`${args.from}/manifest.jsonl not found — is that a benchmark --out dir?`);
  }
  const results = runReplay({
    from: path.resolve(args.from!),
    guardConfigs,
    scenariosById: SCENARIOS_BY_ID,
    faithful: args.faithful,
  });

  const md = writeReport({
    mode: "replay",
    guardConfigs: guardConfigs.map((g) => g.name),
    results,
    scenariosById: SCENARIOS_BY_ID,
    outDir,
  });
  console.log("\n" + md);
  console.error(`\nwrote ${outDir}/report.md and ${outDir}/results.json`);
}

main().catch((err) => {
  console.error(`\nbenchmark failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
