import { describe, expect, it } from "vitest";
import { sharedSeverityOf } from "../../src/security-middleware.js";

describe("sharedSeverityOf", () => {
  it("maps the guards' three levels onto the shared scale", () => {
    expect(sharedSeverityOf({ severity: "info", code: "learned-watch" })).toBe("info");
    expect(sharedSeverityOf({ severity: "warn", code: "learned-watch" })).toBe("medium");
    expect(sharedSeverityOf({ severity: "violation", code: "read-then-egress" })).toBe("high");
  });

  it("treats an effect that skipped the approval gate as critical", () => {
    expect(sharedSeverityOf({ severity: "violation", code: "ungated-command" })).toBe("critical");
    expect(sharedSeverityOf({ severity: "violation", code: "ungated-file-change" })).toBe("critical");
  });
});
