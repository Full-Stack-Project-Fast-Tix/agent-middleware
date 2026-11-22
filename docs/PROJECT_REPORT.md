# AgentGuard: Capstone Project Report

**CS464 · Group 6 · November 2026**

*Secure, observable orchestration for autonomous coding agents*

## Project motivation

Giving a coding agent a task also gives it opportunities to interpret that task: which files to change, which commands to run, whose instructions to follow and when to declare the work finished. Repository guidance, command output and another agent's handoff can influence those choices. An unwanted action can arise from an injected instruction, an incorrect inference or a well-intentioned expansion of the task.

This makes supervision an engineering problem as well as a model-behavior problem. A user needs to delegate useful work while retaining control over consequential decisions. They also need evidence that connects the original request to the actions taken and the resulting files.

AgentGuard explores how to provide that control throughout a coding workflow. The capstone brings together agent orchestration, a security decision boundary and a browser console through which people can understand and direct the work. The central question is: **how can a developer delegate coding work while keeping its scope, permissions and outcome inspectable?**

## Stakeholder needs

The report identifies three complementary perspectives on a shared project:

| Stakeholder | Need addressed by the project |
| --- | --- |
| Developer | Delegate implementation, understand why an action needs attention, decide whether additional work is appropriate and obtain a usable project result. |
| Security administrator | Translate the project's access requirements into agent permissions and credential grants, while managing the people who can use the workspace. |
| Auditor | Reconstruct what happened from recorded decisions and execution evidence, independently of an agent's closing explanation. |

These needs give the console a purpose beyond displaying an agent conversation. It supports decisions at the point where a person needs to make them, and provides evidence to inspect afterward. The [README](../README.md) describes the resulting capabilities and local workflow.

## Technology selection

The implementation choices support a small team building a coherent application across the browser, API, agent runtime and persistence layers.

| Choice | Engineering rationale |
| --- | --- |
| TypeScript across the application | A common language makes cross-component changes easier to follow. Shared Zod contracts give the team one definition of the data exchanged between the server and console. |
| React and Vite | Components suit a console with several views of the same ongoing work. Vite supports rapid frontend iteration, while server-loaded snapshots and ordered events keep the displayed state grounded in recorded execution. |
| Fastify in a modular monolith | Authentication, orchestration and security decisions can compose within one process. This keeps the path from a proposed action to its decision direct and makes its ordering easier to inspect. |
| REST and Server-Sent Events | Request/response endpoints express user operations, while an event stream carries progress and decisions as they happen. The browser can present an ongoing workflow without treating every update as a new command. |
| PostgreSQL | Relationships and transactions support a workflow in which membership, task ownership, execution state and audit evidence must remain consistent. Structured evidence can be stored alongside those relationships. |
| Focused caching | Model prompt caching reduces repeated context work, and event replay supports reconnecting browsers. Keeping the application state centered on the server and database simplifies reasoning about current permissions and decisions. |

The current component design and execution sequence are documented in [Architecture](ARCHITECTURE.md). Interface and security decisions have their own maintained [decision record](contract-decisions.md).

## Development milestones

The project developed from individual guard checks into an integrated coding workflow. The periods below follow the capstone report's development account; the final row records the submission reconciliation and evaluation work.

| Period | Main milestone |
| --- | --- |
| 26 September–4 October | Initial agent guards and benchmark work; shared contracts for the Run, Task and AgentExecution model. |
| 5–18 October | Planning, scheduling, retries and cancellation; PostgreSQL foundations; middleware integration around execution and agent handoffs. |
| 19–31 October | Accounts and workspace roles, console and administration views, operational scripts, Claude runtime integration and sign-in throttling. |
| 1–12 November | End-to-end integration, workspace credentials and brokered requests, project ZIP import/export and live guard evaluation. |
| 13–19 November | More detailed semantic action review, final diff review, shared model budgeting and database/container verification. |
| 22 November | Repeatable per-guard evaluation, dedicated vault storage tests, consolidated results and submission documentation. |

The milestones reflect three connected work areas: establishing shared interfaces, composing the complete workflow and evaluating its behavior under both ordinary work and security-relevant conditions.

## Team contributions

The capstone report records the following workstream responsibilities. Integration and review crossed these boundaries throughout development.

| Member | Workstream | Main contributions |
| --- | --- | --- |
| Easan Saravan | P1 — Security | Security middleware and guards, semantic and final diff review, vault and broker, benchmarks, live evaluations and documentation. |
| Riyaz Choudry | P2 — Orchestration | Orchestrator and server implementation, orchestration tests, frontend fixes and the capstone report. |
| Wai Zin Lin | P3 — Platform | PostgreSQL stores and migrations, identity and sessions, deployment and backup tooling. |
| Christen Cheng | P4 — Contracts and Integration | Shared contracts, web console and design system, Claude runtime, sign-in throttling and review interfaces. |

## Success criteria

The report defines success through useful task completion, timely supervision and traceable outcomes. Its performance targets provide a reference for assessing the control plane:

| Criterion | Report target |
| --- | --- |
| Run creation latency | p95 at or below one second. |
| Approval round trip | p50 at or below 500 milliseconds. |
| Live event delivery | p95 lag at or below two seconds. |
| Orchestration throughput | At least ten Runs per second in the load harness. |
| Concurrent workload completion | Every Run settles in the measured load scenarios. |
| Benign task utility | At most one interruption per ten benign trials. |
| Enforcement correctness | A refused action does not execute. |

These criteria address different questions. Load measurements assess the orchestration machinery using simulated agent work. Guard tests assess decisions and enforcement, while live model cases examine behavior during delegated coding tasks. The [orchestration evaluation](orchestration-evaluation.md) and [guard evaluation results](GUARD_EVALUATION_RESULTS.md) contain the methods, measurements and case-level evidence.

## Engineering findings

The project showed why task completion and security decisions need to be evaluated together. A held action can be the appropriate response to an unrequested change, but the workflow must also let the user make a decision and resume useful work. The recorded human-approved release proposal demonstrates this interaction: the extra work was surfaced, the owner approved the saved proposal and the task then completed.

The evaluation also made the distinction between proposed work and resulting work concrete. A decision about a command describes what was permitted at that moment; reviewing the final files answers what the execution actually produced. Presenting these forms of evidence together helps a user assess the result without relying entirely on the agent's own account.

Finally, the shared contracts made security a responsibility spanning the whole application. The orchestrator must respect a refusal, persistence must preserve the decision and its ordering, and the console must present the right proposal to the right person. AgentGuard's capstone contribution is the integration of those responsibilities into one inspectable coding workflow.

---

Adapted from the team's November 2026 capstone report. This document retains its project context, rationale and development account; setup instructions, technical specifications and detailed measurements remain in their linked repository guides.
