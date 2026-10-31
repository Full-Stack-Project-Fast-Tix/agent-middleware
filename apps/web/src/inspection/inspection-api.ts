import {
  workspaceAuditResponseSchema,
  workspaceConfigurationSchema,
  apiPaths,
  type WorkspaceAuditResponse,
  type WorkspaceConfiguration,
} from "@launchpad/shared";
import { request } from "../api";

export const inspectionApi = {
  configuration: async (workspaceId: string): Promise<WorkspaceConfiguration> =>
    workspaceConfigurationSchema.parse(await request(apiPaths.workspaceConfiguration(workspaceId))),
  audit: async (workspaceId: string, cursor?: string): Promise<WorkspaceAuditResponse> => {
    const query = new URLSearchParams({ limit: "50", ...(cursor ? { cursor } : {}) });
    return workspaceAuditResponseSchema.parse(await request(`${apiPaths.workspaceAudit(workspaceId)}?${query}`));
  },
};
