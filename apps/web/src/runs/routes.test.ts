import { describe, expect, it } from "vitest";
import { parseRunsHash } from "./routes";

const RUN_ID = "0d3e0000-0000-4000-8000-000000000001";

describe("parseRunsHash", () => {
  it("routes the new-run page and run detail links", () => {
    expect(parseRunsHash("#/runs")).toEqual({ page: "new" });
    expect(parseRunsHash("#/runs/new")).toEqual({ page: "new" });
    expect(parseRunsHash(`#/runs/${RUN_ID}`)).toEqual({ page: "run", runId: RUN_ID });
  });

  it("rejects anything that is not a run id, so it never reaches an API path", () => {
    expect(parseRunsHash("#/runs/..%2F..%2Fadmin")).toBeNull();
    expect(parseRunsHash("#/runs/not-a-run")).toBeNull();
    expect(parseRunsHash(`#/runs/${RUN_ID}/extra`)).toBeNull();
    expect(parseRunsHash("#/agents")).toBeNull();
    expect(parseRunsHash("")).toBeNull();
  });
});
