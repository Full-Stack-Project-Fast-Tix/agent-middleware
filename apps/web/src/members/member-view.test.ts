import { describe, expect, it } from "vitest";
import type { WorkspaceMemberSummary, WorkspaceRole } from "@launchpad/shared";
import { ApiError } from "../api";
import { changeErrorMessage, isOnlyAdmin, listErrorMessage, removeWarning, roleChangeWarning } from "./member-view";

function member(userId: string, role: WorkspaceRole): WorkspaceMemberSummary {
  return { userId, role, joinedAt: "2026-10-31T00:00:00.000Z", email: `${userId}@example.test`, name: userId };
}

describe("isOnlyAdmin", () => {
  it("is true only for the one security admin", () => {
    const ada = member("ada", "security_admin");
    const lin = member("lin", "developer");
    expect(isOnlyAdmin([ada, lin], ada)).toBe(true);
    expect(isOnlyAdmin([ada, lin], lin)).toBe(false);
    expect(isOnlyAdmin([ada, member("sam", "security_admin")], ada)).toBe(false);
  });
});

describe("roleChangeWarning", () => {
  it("warns before someone stops being able to manage the list", () => {
    expect(roleChangeWarning(member("ada", "security_admin"), "auditor", "ada")).toMatch(/your own role/);
    expect(roleChangeWarning(member("sam", "security_admin"), "developer", "ada")).toMatch(/sam/);
  });

  it("lets other changes happen straight away", () => {
    expect(roleChangeWarning(member("lin", "developer"), "auditor", "ada")).toBeNull();
    expect(roleChangeWarning(member("lin", "auditor"), "security_admin", "ada")).toBeNull();
  });
});

describe("removeWarning", () => {
  it("says what removing yourself means", () => {
    expect(removeWarning(member("ada", "developer"), "ada")).toMatch(/lose access/);
    expect(removeWarning(member("lin", "developer"), "ada")).toMatch(/Remove lin/);
  });
});

describe("error messages", () => {
  it("tells apart the same status on adding and on changing", () => {
    const conflict = new ApiError("x", 409);
    expect(changeErrorMessage("add", conflict)).toMatch(/already a member/);
    expect(changeErrorMessage("change", conflict)).toMatch(/at least one security admin.*first/);
    const missing = new ApiError("x", 404);
    expect(changeErrorMessage("add", missing)).toMatch(/No account uses that email.*command line/);
    expect(changeErrorMessage("change", missing)).toMatch(/no longer a member/);
  });

  it("explains a role lost since the page loaded", () => {
    expect(changeErrorMessage("change", new ApiError("x", 403))).toMatch(/role may have changed/);
  });

  it("does not blame the person when the server did not answer", () => {
    expect(changeErrorMessage("add", new TypeError("Failed to fetch"))).toMatch(/did not answer/);
  });

  it("explains a workspace the viewer is not in", () => {
    expect(listErrorMessage(new ApiError("Workspace not found", 404))).toMatch(/not a member of this workspace/);
  });
});
