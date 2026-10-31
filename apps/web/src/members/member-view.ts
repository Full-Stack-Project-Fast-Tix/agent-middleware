import type { WorkspaceMemberSummary, WorkspaceRole } from "@launchpad/shared";
import { ApiError } from "../api";

// What the Members page says and offers. Offering less here is a courtesy: the
// server checks every change, and the page handles its refusals.

export const ROLES: readonly WorkspaceRole[] = ["developer", "security_admin", "auditor"];

export const ROLE_WORDS: Record<WorkspaceRole, string> = {
  developer: "Developer",
  security_admin: "Security admin",
  auditor: "Auditor",
};

export const ROLE_DUTIES: Record<WorkspaceRole, string> = {
  developer: "Reads everything in the workspace, starts and cancels runs, and answers approvals.",
  security_admin: "Does what a developer does, and manages this list.",
  auditor: "Reads everything in the workspace and changes nothing.",
};

export function isOnlyAdmin(members: readonly WorkspaceMemberSummary[], member: WorkspaceMemberSummary): boolean {
  return member.role === "security_admin" && members.filter((other) => other.role === "security_admin").length === 1;
}

/** Why a role change needs a second look, or null if it can simply happen. */
export function roleChangeWarning(
  member: WorkspaceMemberSummary,
  role: WorkspaceRole,
  viewerId: string | null,
): string | null {
  if (member.role !== "security_admin") return null;
  return member.userId === viewerId
    ? `Change your own role to ${ROLE_WORDS[role]}? You will no longer be able to manage this list.`
    : `Change ${member.name} to ${ROLE_WORDS[role]}? They will no longer be able to manage this list.`;
}

export function removeWarning(member: WorkspaceMemberSummary, viewerId: string | null): string {
  return member.userId === viewerId
    ? "Remove yourself from this workspace? You will lose access to it. Runs you started keep going."
    : `Remove ${member.name} from this workspace? Runs they already started keep going.`;
}

/** Say what happened and what to do, for one refused or failed change. */
export function changeErrorMessage(action: "add" | "change", reason: unknown): string {
  if (!(reason instanceof ApiError)) return "The server did not answer. Check that it is running, then try again.";
  switch (reason.status) {
    case 400:
      return action === "add" ? "Enter a valid email address and choose a role." : reason.message;
    case 401:
      return "Your session has ended. Reload the page and sign in again.";
    case 403:
      return "Only a security admin can change this list. Your role may have changed, so the list has been reloaded.";
    case 404:
      return action === "add"
        ? "No account uses that email. Ask your platform operator to create the account on the command line, then add it here."
        : "That person is no longer a member. The list has been reloaded.";
    case 409:
      return action === "add"
        ? "That person is already a member of this workspace."
        : "A workspace needs at least one security admin. Make someone else a security admin first, then try again.";
    default:
      return reason.message;
  }
}

/** Say why the list could not be shown. */
export function listErrorMessage(reason: unknown): string {
  if (!(reason instanceof ApiError)) return reason instanceof Error ? reason.message : String(reason);
  if (reason.status === 404) return "You are not a member of this workspace. Choose another, or ask a security admin to add you.";
  if (reason.status === 401) return "Your session has ended. Reload the page and sign in again.";
  return reason.message;
}
