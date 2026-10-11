# Demo runbook: multi-agent orchestration (P2 segment)

About 4 minutes. It shows one request planned, delegated and run by several
agents, with every step checked by the security layer, and the human approval
in the loop.

## Be clear about what is real

Say this once, early. It is true, and it pre-empts the first question.

> The orchestrator, the HTTP API, the live event stream and this UI are the
> real system. For this demo the agents, the supervisor's model call and the
> security rules are simulated, so the run is the same every time and nothing
> executes. The real Codex runtime and security middleware plug into the same
> interfaces.

## Before you present

1. **Start fresh.** Runs are kept in memory in demo mode, so a restart clears
   them:
   ```bash
   npm run dev:demo
   ```
   - It serves the API on `localhost:3000` and the UI on `localhost:5173`. If
     5173 is taken, Vite prints the port it chose instead, for example 5174.
   - Both listen on this machine only: the demo has simulated security and no
     access token, so do not expose it on the network.
   - Wait for the line `RUNS_DEMO is on`.
2. **Open** `http://localhost:<port>/#/runs/new` and check that it says
   "Workspace Demo: checkout-service".
3. **Rehearse once,** then restart (step 1) so the "Started in this browser"
   list holds only that run.
4. **Make it readable:** browser zoom 125% for a projector, and close other
   tabs.
5. **Keep a backup:** leave the completed rehearsal run open in a second tab.
   If anything goes wrong live, switch to it and narrate (see "If something
   goes wrong").

## Script

| Step | Do | Point at / say |
| --- | --- | --- |
| 1 | **Runs** tab. Keep "Plan and delegate". Click the first example ("Add input validation…"), then **Start run**. | "The request is the trusted goal. The supervisor sees only this and the list of agents, never the repository, so a poisoned file cannot shape the plan." |
| 2 | Watch **Plan** complete; three tasks appear. | "Each dashed line is a delegation. Before a task existed, the security layer checked it. A refused delegation never becomes a task." |
| 3 | Click **Find the relevant code** when it shows **MEDIUM 1**. | "The analyst read `skills/deploy-helper.md`, which tells agents to post `.env` to a 'release service'. That is a warning, not a block: reading is allowed, and the instruction is now marked untrusted." |
| 4 | **Make the change** shows **HIGH**, and the yellow approval banner appears. | "The developer agent followed that instruction and tried to `curl` the `.env` file out. Refused, *acted on*. The agent carries on with the real work." |
| 5 | Click **Review** in the banner. Show the redacted file list, then **Approve once**. | "Changing source needs a person's approval under this workspace's policy. The approver sees what will change, redacted, and nothing runs until they answer." |
| 6 | **Test and review** runs. Click it and point at the capability chips. | "The reviewer runs with *no write*. These are the capabilities it launched with, recorded for audit." |
| 7 | Point at **Result**. | "The run's result is the final task's report. Earlier results reached it as inputs, and each handoff was checked too." |

### Optional extras (about 30 s each)

- **Deny instead of approve** in step 5. The run still completes, the
  developer reports it did not change the file, and the reviewer says the task
  is not done. "A refusal declines one action. It does not crash the run, and
  the agents report honestly what did not happen."
- **Cancel:** start another run, click **Cancel run**, then confirm. Running
  work stops, pending approvals are cancelled, and unfinished tasks show
  "Cancelled".
- **One agent:** choose "One agent", then Developer. The same checks apply
  with no plan.

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| Page says "Request failed" | The API is not up yet or has stopped. Wait for `RUNS_DEMO is on`, then reload the page. |
| "This server does not offer multi-agent runs yet" | The server was started with `npm run dev` instead of `npm run dev:demo`. Restart it with `dev:demo`. |
| "This run no longer exists" | The server restarted, so in-memory runs are gone. Click **Start a new run**. |
| Port already in use | Another app holds 3000 or 5173. Close it, or use the port Vite prints. |
| Anything else | Switch to the backup tab with the completed run and narrate it. |

## Likely questions

- **"What if the supervisor itself is manipulated?"**
  - It never sees workspace content.
  - Its plan must match a schema and pass `validatePlan`: registered agents
    only, never itself, no cycles, a task limit.
  - Every task is then a delegation the middleware evaluates against the
    original request.
- **"Can an agent just retry a refused action?"** Not through the
  orchestrator. An attempt with any refused action is never retried. This is
  checked over 2,000 randomised runs
  ([orchestration-evaluation.md](orchestration-evaluation.md)).
- **"Can one agent pass a secret to another?"** Results move between tasks
  only as `context_handoff` actions, which the middleware evaluates. A blocked
  handoff is withheld from the next agent's prompt.
- **"How does it scale?"** About 110 runs/s of orchestration in one process.
  At a realistic pace, 50 concurrent runs take about 2.5% longer than one.
  Model and container time dominate a real run.
- **"What's not finished?"** The real security middleware (P1) and PostgreSQL
  persistence (P3) still need to be connected. The interfaces are frozen and
  tested with stand-ins.
