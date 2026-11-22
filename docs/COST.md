# Resource and token budget

The local submission needs Node.js 22+, PostgreSQL 16 and a container engine. Tools default to two CPUs, 2 GiB memory and 256 processes per execution; two executions may run concurrently. These are limits, not a guarantee that a 4 GiB host can sustain both plus the control plane and database.

Model calls use an operator-supplied Anthropic account and incur its current API charges. No fixed monetary estimate is claimed. The configured model, effort, context length, caching and repeated review calls affect cost.

`RUN_TOKEN_BUDGET` defaults to 2,000,000 shared tokens across the planner, agent calls, reasoning/action monitors and final diff review. Before a call the server reserves its input's UTF-8 byte count plus a 16,000-token protocol allowance and maximum output. Concurrent reservations share one ledger. Reported usage, including cache tokens, replaces a reservation; unknown or failed usage retains its conservative charge. Final review has a reserve of 20%, capped at 128,000 tokens. This is an admission estimate, not a provider billing guarantee.

Per-execution usage remains on `AgentExecution.usage`; the final receipt records the broader model budget separately. Summing only agent execution usage omits planning and review. A failed model call can still consume provider credits.

Code defaults allow 40 model turns and 200,000 output tokens per execution. The submission `.env.example` selects smaller limits (20 turns and 50,000 output tokens); explicit environment settings take precedence. Model/tool time defaults to 15 minutes per execution, excluding time spent waiting for human approval. A retry creates another execution, subject to the shared Run budget.

See the root README for setup and the evaluation records for measured durations. Deployment and cloud pricing are outside the local submission scope.
