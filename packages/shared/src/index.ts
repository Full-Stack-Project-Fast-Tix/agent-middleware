import { z } from "zod";
export const runStatusSchema=z.enum(["pending","running","completed","failed","cancelled"]); export type RunStatus=z.infer<typeof runStatusSchema>;
export const taskStatusSchema=z.enum(["pending","ready","running","completed","failed","cancelled"]); export type TaskStatus=z.infer<typeof taskStatusSchema>;
export const securityDecisionOutcomeSchema=z.enum(["allow","warn","block","require_approval"]); export type SecurityDecisionOutcome=z.infer<typeof securityDecisionOutcomeSchema>;
export const workspaceRoleSchema=z.enum(["developer","security_admin","auditor"]); export type WorkspaceRole=z.infer<typeof workspaceRoleSchema>;
export const agentStatusSchema=z.enum(["ready","busy","stopped","error"]); export type AgentStatus=z.infer<typeof agentStatusSchema>;
export interface Agent { id:string; name:string; description:string; instructions:string; status:AgentStatus; workspacePath:string; codexThreadId:string|null; lastError:string|null; createdAt:string; updatedAt:string; }
export const findingSeveritySchema=z.enum(["info","warn","violation"]); export type FindingSeverity=z.infer<typeof findingSeveritySchema>;
export interface Finding { check:string; code:string; severity:FindingSeverity; seq:number; evidence:number[]; message:string; steer?:string; requestSteer?:boolean; steerStrength?:"normal"|"firm"; requestSemanticReview?:boolean; metadata?:Record<string,unknown>; facts?:Record<string,string>; }
export type HumanApprovalReason="high_consequence"|"semantic_uncertainty"|"semantic_unavailable";
export type HumanApprovalActionType="command"|"file_change"; export type HumanApprovalDecision="approve"|"deny"; export type HumanApprovalOutcome="approved"|"denied"|"timed_out"|"cancelled";
export interface Approval { id:string; runId:string; reason:HumanApprovalReason; actionType:HumanApprovalActionType; actionId:string; summary:string; safeDetails?:string; createdAt:string; expiresAt:string; }
export interface ApiError { error:string; details?:unknown } export interface ApiResponse<T> { data:T; error?:never }
export type RunEventType="RUN_STARTED"|"TASK_CREATED"|"TASK_STARTED"|"TASK_COMPLETED"|"EXECUTION_STARTED"|"EXECUTION_COMPLETED"|"SECURITY_FINDING_CREATED"|"APPROVAL_REQUESTED"|"APPROVAL_RESOLVED"|"RUN_COMPLETED"|"RUN_FAILED";
export interface RunEvent { id:string; runId:string; taskId?:string; executionId?:string; type:RunEventType; timestamp:string; payload:Record<string,unknown>; }
export const runEventSchema=z.object({id:z.string().min(1),runId:z.string().min(1),taskId:z.string().min(1).optional(),executionId:z.string().min(1).optional(),type:z.enum(["RUN_STARTED","TASK_CREATED","TASK_STARTED","TASK_COMPLETED","EXECUTION_STARTED","EXECUTION_COMPLETED","SECURITY_FINDING_CREATED","APPROVAL_REQUESTED","APPROVAL_RESOLVED","RUN_COMPLETED","RUN_FAILED"]),timestamp:z.string().datetime(),payload:z.record(z.string(),z.unknown())});
export const apiErrorSchema=z.object({error:z.string(),details:z.unknown().optional()});
