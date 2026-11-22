# Structured reflection memory

The optional learned-watch layer retains structured facts from deterministic findings to improve warnings on later Runs by the same agent. It does not write natural-language instructions into agent prompts or create new permissions.

`reflections.ts` extracts bounded paths, destinations and incident codes from structured trace evidence, validates fact shapes, deduplicates sightings and evicts entries within per-code limits. `paramsFrom` folds these records into options for `check-learned-watch.ts`. Two observed sibling destinations can produce a derived host-family warning; recurrence strengthens the warning wording, not its enforcement severity.

In password mode `PostgresSecuritySource` loads reflection/sighting rows and folds new findings under a database transaction and agent row lock. `security-middleware-impl.ts` completes the fold after execution when `GUARDRAIL_REFLECTION_ENABLED` is enabled. The learned-watch check is always warning-only: it cannot block an action or weaken another guard. A persistence failure does not retry a completed task.

This implementation has automated tests. Its general effect on live attack resistance has not been established. Historical replay measurements are separate from current Claude Run efficacy; do not present memory as guaranteed attack prevention. An adversary can rotate destinations or cause noisy findings, so the records are bounded and per-agent rather than shared across all agents.
