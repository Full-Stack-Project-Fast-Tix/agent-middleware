export type HumanApprovalReason =
  | "high_consequence"
  | "semantic_uncertainty"
  | "semantic_unavailable";

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface RunTrace {
  /** Path to a JSON Lines file, one protocol message per line. */
  path: string;
  events: number;
  bytes: number;
  /** True when older events were evicted to retain the newest window. */
  truncated: boolean;
}
