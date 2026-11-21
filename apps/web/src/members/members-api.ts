import {
  apiPaths,
  meResponseSchema,
  workspaceMemberResponseSchema,
  workspaceMembersResponseSchema,
  type AddWorkspaceMemberRequest,
  type CreateMemberAccountRequest,
  type User,
  type WorkspaceMemberSummary,
  type WorkspaceMembersResponse,
  type WorkspaceRole,
} from "@launchpad/shared";
import { request } from "../api";

// Workspace members, from packages/shared/src/api.ts. These routes exist only in
// password mode. The server decides who may do what on every request.

export const membersApi = {
  me: async (): Promise<User> => meResponseSchema.parse(await request(apiPaths.me())).user,

  list: async (workspaceId: string): Promise<WorkspaceMembersResponse> =>
    workspaceMembersResponseSchema.parse(await request(apiPaths.workspaceMembers(workspaceId))),

  add: async (workspaceId: string, body: AddWorkspaceMemberRequest): Promise<WorkspaceMemberSummary> =>
    workspaceMemberResponseSchema.parse(
      await request(apiPaths.workspaceMembers(workspaceId), { method: "POST", body: JSON.stringify(body) }),
    ).member,

  createAccount: async (workspaceId: string, body: CreateMemberAccountRequest): Promise<WorkspaceMemberSummary> =>
    workspaceMemberResponseSchema.parse(
      await request(apiPaths.workspaceAccounts(workspaceId), { method: "POST", body: JSON.stringify(body) }),
    ).member,

  changeRole: async (workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMemberSummary> =>
    workspaceMemberResponseSchema.parse(
      await request(apiPaths.workspaceMember(workspaceId, userId), { method: "PATCH", body: JSON.stringify({ role }) }),
    ).member,

  remove: async (workspaceId: string, userId: string): Promise<void> => {
    await request(apiPaths.workspaceMember(workspaceId, userId), { method: "DELETE" });
  },
};
