# Cost note

One small host and pay-per-use model calls are enough for this proof of concept, so
there is no Kubernetes, managed database or message broker to pay for. Prices below
are left for you to fill from the Volcengine console on the day you deploy, because
they change and were not checked for this note.

| Item | What the project uses | Why this size | Monthly cost |
| --- | --- | --- | --- |
| ECS instance | 2 vCPU, 4 GiB, 40 GiB disk (`docs/DEPLOYMENT.md`) | One control plane, Postgres, and at most 2 parallel executions per Run | Fill in |
| Object storage for backups | One nightly dump, 14 kept locally | Dumps are small; only the bucket's retention drives this | Fill in |
| Model calls | Ark endpoint, by tokens | The real variable cost, and capped per Run | See below |

## Model spend

Every execution records its tokens in `agent_executions.usage`, so spend is measured
rather than estimated:

```sql
SELECT r.id, sum((e.usage->>'inputTokens')::bigint)  AS input_tokens,
             sum((e.usage->>'outputTokens')::bigint) AS output_tokens
  FROM runs r JOIN agent_executions e ON e.run_id = r.id
 GROUP BY r.id;
```

Limits that bound one Run:

- At most 6 tasks, 2 running at once and 2 attempts per task.
- `RUN_TOKEN_BUDGET`, 2,000,000 tokens by default. It is checked before each attempt,
  so a single attempt can overshoot it.
- The semantic monitor adds one small model call per reviewed action, at most 700
  output tokens each. Those calls are **not** counted in `usage`, so they sit outside
  the budget.

## What would change this

More concurrent users need a bigger host first, since executions are the main load.
Real tenant isolation would cost far more, because it means separate hosts or stronger
sandboxes. That is outside this proof of concept (`handover.md`, decision 5).
