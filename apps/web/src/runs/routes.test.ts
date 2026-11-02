import { describe, expect, it } from "vitest";
import { legacyHashTarget, parseRoute, paths } from "../router";

const RUN_ID = "0d3e0000-0000-4000-8000-000000000001";

describe("parseRoute", () => {
  it("routes each main view", () => {
    expect(parseRoute("/")).toEqual({ page: "dashboard" });
    expect(parseRoute("/runs")).toEqual({ page: "runs" });
    expect(parseRoute("/runs/new")).toEqual({ page: "new-run" });
    expect(parseRoute(`/runs/${RUN_ID}`)).toEqual({ page: "run", runId: RUN_ID });
    expect(parseRoute("/members")).toEqual({ page: "members" });
  });

  it("ignores a trailing slash", () => {
    expect(parseRoute("/runs/")).toEqual({ page: "runs" });
    expect(parseRoute(`/runs/${RUN_ID}/`)).toEqual({ page: "run", runId: RUN_ID });
  });

  it("rejects anything that is not a run id, so it never reaches an API path", () => {
    expect(parseRoute("/runs/..%2F..%2Fadmin")).toEqual({ page: "not-found" });
    expect(parseRoute("/runs/not-a-run")).toEqual({ page: "not-found" });
    expect(parseRoute(`/runs/${RUN_ID}/extra`)).toEqual({ page: "not-found" });
    expect(parseRoute("/not-a-page")).toEqual({ page: "not-found" });
  });

  it("round-trips the paths it hands out", () => {
    expect(parseRoute(paths.run(RUN_ID))).toEqual({ page: "run", runId: RUN_ID });
    expect(parseRoute(paths.newRun)).toEqual({ page: "new-run" });
    for (const page of ["agents", "policies", "approvals", "security", "benchmarks"] as const) {
      expect(parseRoute(paths[page])).toEqual({ page });
    }
  });
});

describe("legacyHashTarget", () => {
  it("keeps old shared links working", () => {
    expect(legacyHashTarget(`#/runs/${RUN_ID}`)).toBe(`/runs/${RUN_ID}`);
    expect(legacyHashTarget("#/runs/new")).toBe("/runs/new");
    expect(legacyHashTarget("#/runs")).toBe("/runs/new");
  });

  it("sends a malformed run id to the list, not to an API path", () => {
    expect(legacyHashTarget("#/runs/not-a-run")).toBe("/runs");
    expect(legacyHashTarget("#/runs/..%2F..%2Fadmin")).toBe("/runs");
    expect(legacyHashTarget(`#/runs/${RUN_ID}/extra`)).toBe("/runs");
  });

  it("leaves every other hash alone", () => {
    expect(legacyHashTarget("")).toBeNull();
    expect(legacyHashTarget("#section")).toBeNull();
    expect(legacyHashTarget("#/agents")).toBeNull();
    expect(legacyHashTarget("#/runsomething")).toBeNull();
  });
});
