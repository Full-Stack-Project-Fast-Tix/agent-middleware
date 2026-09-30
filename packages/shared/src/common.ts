import { z } from "zod";

/**
 * Conventions every contract in this package follows:
 *
 *   - Entity ids are UUIDs.
 *   - Timestamps are ISO-8601 strings in UTC with a trailing "Z".
 *   - A nullable database column is `T | null` and always present. Optional
 *     (`?`) fields are reserved for request payloads, where omission means
 *     "use the default" or "leave unchanged".
 *   - Flexible payloads (capabilities, policy rules, evidence) are JSON objects
 *     validated here, never free-form strings parsed later.
 */

/**
 * Any 8-4-4-4-12 hex id. Postgres' uuid type does the real validation; the
 * stricter z.uuid() would reject hand-written seed ids such as
 * 00000000-0000-0000-0000-000000000001, so a stored row would not parse back.
 */
export const idSchema = z.guid();
export type Id = z.infer<typeof idSchema>;

/**
 * UTC with a trailing "Z", millisecond precision. Postgres columns are
 * timestamptz(3) and one row mapper converts driver Dates with toISOString(),
 * so values compare exactly in keyset cursors and optimistic-concurrency checks.
 */
export const timestampSchema = z.iso.datetime();
export type Timestamp = z.infer<typeof timestampSchema>;

export const jsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof jsonObjectSchema>;

/** Verbatim structured values, as produced by `Finding.facts` in the guards. */
export const factsSchema = z.record(z.string(), z.string());
export type Facts = z.infer<typeof factsSchema>;

/** Not blank. Validation only: entity strings are never rewritten, so a parsed row equals the stored one. */
export const nonEmptyStringSchema = z.string().refine((value) => value.trim().length > 0, "Must not be blank");

/** Request input: surrounding whitespace is trimmed, then it must not be empty. */
export const requiredTextSchema = z.string().trim().min(1);

export const auditTimestampsShape = {
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

/** Lifecycle timestamps shared by Run, Task and AgentExecution. */
export const lifecycleTimestampsShape = {
  ...auditTimestampsShape,
  startedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
};
