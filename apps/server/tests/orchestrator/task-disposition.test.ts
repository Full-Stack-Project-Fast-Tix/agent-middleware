import { describe, expect, it } from "vitest";
import { parseTaskDisposition } from "../../src/orchestrator/task-disposition.js";

describe("parseTaskDisposition", () => {
  it("accepts the exact bounded report", () => {
    expect(parseTaskDisposition('{"status":"complete","summary":"Implemented the fix."}')).toEqual({
      status: "complete",
      summary: "Implemented the fix.",
    });
  });

  it("accepts a Markdown summary written with raw line breaks inside the string", () => {
    expect(parseTaskDisposition('{\n  "status": "complete",\n  "summary": "Done.\n\n## Changes\n- `a.js` says \\"hi\\"\n\tindented"\n}')).toEqual({
      status: "complete",
      summary: 'Done.\n\n## Changes\n- `a.js` says "hi"\n\tindented',
    });
  });

  it.each([
    "Implemented the fix.",
    '```json\n{"status":"complete","summary":"done"}\n```',
    '{"status":"complete","summary":"done","trusted":true}',
    '{"status":"unknown","summary":"done"}',
    '{"status":"incomplete","summary":""}',
  ])("rejects an invalid report: %s", (report) => {
    expect(parseTaskDisposition(report)).toBeNull();
  });
});
