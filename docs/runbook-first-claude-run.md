# First real Claude run

You're making the first run of AgentGuard against the real Claude API. So far this
path has only been tested against a fake API, so the aim is to find out what works,
not to get a perfect result. If something fails, stop and report it using
[What to send back](#what-to-send-back). A failure here is a useful result.

**Time:** about 30 minutes.

**Cost:** roughly $0.30 to $1, and at most about $7 with the limits below. These are
estimates, because no real run has been measured. This run uses your API key, so you
pay for it.

## Before you start

You need:

- Access to the private repository `Full-Stack-Project-Fast-Tix/agent-middleware`.
- macOS or Linux. On Windows, use WSL2.
- Node.js 22 or newer, and Docker running.
- Ports 3000 and 5433 free.
- An Anthropic API key from <https://console.anthropic.com>. A Claude.ai or Claude
  Code subscription doesn't cover API use.

**Set a spend limit first.** In the Anthropic Console, set a low monthly limit on the
key's workspace, such as $10. It's the only limit that covers everything.

**Use a normal terminal,** not one inside Claude Code. Claude Code sets
`CLAUDE_EFFORT=xhigh`, which overrides your settings and costs more. This should print
`not set`:

```bash
echo "${CLAUDE_EFFORT:-not set}"
```

## Keep these safe

- The key only goes in `.env`, which git ignores. Never commit it or paste it into a
  chat, an issue or a screenshot. If it leaks, revoke it in the Console.
- Only use the throwaway project below. Don't point this at real code or anything with
  secrets in it.
- Don't turn off any `GUARDRAIL_` setting. A setting missing from `.env` counts as off,
  so start from the template in step 2 rather than writing your own file.
- This is a proof of concept, not a hardened service. Keep it on your own machine.

## 1. Get the code

```bash
git clone https://github.com/Full-Stack-Project-Fast-Tix/agent-middleware.git
cd agent-middleware
git switch feat/claude-runtime
npm ci
```

This work is on `feat/claude-runtime`, not `main`.

## 2. Add your settings

```bash
cp .env.example .env
```

Open `.env` in an editor and change these lines. Edit the existing lines, and don't
add second copies.

| Line | Change it to |
| --- | --- |
| `ANTHROPIC_API_KEY=...` | Your key, right after the `=`, with no quotes or spaces |
| `# APP_AUTH_MODE=password` | `APP_AUTH_MODE=password` |
| `# DATABASE_URL=postgres://...` | Remove the `# ` only |
| `CLAUDE_MAX_ITERATIONS=40` | `CLAUDE_MAX_ITERATIONS=20` |
| `CLAUDE_MAX_TOTAL_OUTPUT_TOKENS=200000` | `CLAUDE_MAX_TOTAL_OUTPUT_TOKENS=50000` |
| `CLAUDE_MAX_TOTAL_INPUT_TOKENS=2000000` | `CLAUDE_MAX_TOTAL_INPUT_TOKENS=500000` |

Leave `TEST_DATABASE_URL` commented out.

Check it without showing the key:

```bash
grep -E '^(MODEL_PROVIDER|APP_AUTH_MODE|DATABASE_URL|RUNTIME_PROVIDER|CLAUDE_MAX_ITERATIONS|CLAUDE_MAX_TOTAL|GUARDRAIL_(EGRESS|SEMANTIC)_ENABLED)' .env
grep -c '^ANTHROPIC_API_KEY=sk-ant-' .env
```

The first command should print exactly these lines:

```text
APP_AUTH_MODE=password
MODEL_PROVIDER=anthropic
CLAUDE_MAX_ITERATIONS=20
CLAUDE_MAX_TOTAL_OUTPUT_TOKENS=50000
CLAUDE_MAX_TOTAL_INPUT_TOKENS=500000
GUARDRAIL_EGRESS_ENABLED=true
GUARDRAIL_SEMANTIC_ENABLED=true
RUNTIME_PROVIDER=container
DATABASE_URL=postgres://launchpad:launchpad@127.0.0.1:5433/launchpad
```

The second should print `1`. If yours doesn't match, fix `.env` before going on.

## 3. Make a throwaway project

The agent works on a copy, so this folder shouldn't change at all. You'll check that
in step 7.

```bash
mkdir -p "$HOME/agentguard-first-run/src"
printf 'export function add(a, b) {\n  return a + b;\n}\n' > "$HOME/agentguard-first-run/src/util.js"
```

## 4. Set up the database and your account

```bash
docker compose up -d postgres
export DATABASE_URL=postgres://launchpad:launchpad@127.0.0.1:5433/launchpad
npm run db:migrate -w @launchpad/server
```

Choose a password for this local account. `read` waits for you to type it and doesn't
show it. Use your own email in both commands.

```bash
read -rs AG_PASSWORD
printf '%s' "$AG_PASSWORD" | npm run db:admin -w @launchpad/server -- add-user you@example.com "Your Name"
unset AG_PASSWORD
npm run db:admin -w @launchpad/server -- add-workspace "First run" "$HOME/agentguard-first-run" you@example.com
```

## 5. Run the free safety check

This uses real Docker containers and a fake model. It doesn't use your key or cost
anything.

```bash
npm run build:claude-runtime
npm run verify:claude-runtime -w @launchpad/server
```

Every line should say `PASS`. **If any line says `FAIL`, stop here** and report it.
Don't start a real run.

## 6. Make the real run

```bash
npm run poc
```

Wait for `Open http://localhost:3000`, then in your browser:

1. Open <http://localhost:3000> and sign in.
2. Choose **Start a run**.
3. Under **How should it run?**, choose **One agent**, then pick **Developer**.
4. Enter this task exactly:

   > Add a function called reverseString to src/util.js that reverses a string, then say what you changed.

5. Choose **Start run** and stay on the page.
6. When an action is **Held**, read what it proposes. Choose **Approve** if it's the
   edit to `src/util.js`, and **Deny** if it's anything else. An approval expires after
   2 minutes, and an expired one counts as denied.

**Stop the run** with **Cancel run** if it does something you didn't expect or the
spend in the Console passes about $5. If that doesn't work, press `Ctrl+C` in the
terminal.

Run this once only. A failed attempt is retried automatically once, which can double
its cost, so don't also restart it by hand.

## 7. Check the result

A status of **Finished** only means the agent says it's done. AgentGuard hasn't
verified the code, so check for yourself.

Your original project should be unchanged, with no `reverseString`:

```bash
cat "$HOME/agentguard-first-run/src/util.js"
```

The agent's copy should contain the change. Copy the run id from the page's URL, then:

```bash
# macOS
cat "$HOME/.volc-agent-launchpad/data/runs/RUN_ID/workspace/src/util.js"
# Linux
cat .local/data/runs/RUN_ID/workspace/src/util.js
```

Then look at the actual cost under Usage in the Anthropic Console. It can take a few
minutes to appear.

## What you might see

| What you see | What it means | What to do |
| --- | --- | --- |
| `Claude refused to continue (category: ...)` | A safety classifier stopped the request | Report the category |
| An error naming a `CLAUDE_MAX_` setting | The run hit a limit, and it worked as intended | Report it, and don't raise the limit |
| A 401 or `authentication` error | The key was rejected | Check `.env` once; if it's right, report it, because this is untested |
| A 400 error from the API | The API rejected how the request is built, which is the main thing this run tests | Stop and report the full message, leaving out any secrets |
| `Could not reach the Anthropic API` | Your machine couldn't connect, and the attempt was retried once | Check your network and report it if it persists |
| A `semantic-monitor-unavailable` finding | A security review didn't answer in time, so the action needs a person | Report how often it happens |
| The agent says it couldn't run tests | Expected: it has no network or `node_modules` | Report it only if the edit also failed |
| Playground or Safety says it needs Codex | Expected on this path | Ignore it |
| `Dashboard`, `Runs` or sign-in fails | Not expected | Stop and report it |
| The container engine can't mount a folder | Docker can't reach the state folder | Set `LOCAL_POC_DATA_ROOT` to a folder Docker can share, then rerun `npm run poc` |

## What to send back

Fill this in. **Read it before sending, and leave out your key and any secrets.** Don't
send `.env`. Don't send trace files without checking them first, because a raw trace
can contain anything the agent saw.

```text
Commit (git rev-parse --short HEAD):
OS, Node and Docker versions:
Safety check (step 5): all PASS / which lines failed:
Run status: Finished / Failed / Cancelled
Exact error, if any:
Actions held, and what you chose:
Did the agent's copy contain reverseString? yes / no
Was the original project unchanged? yes / no
Anything refused or blocked, and the reason shown:
Any semantic-monitor-unavailable findings? how many:
Cost shown in the Anthropic Console:
Input and output tokens, if shown on the page:
Anything confusing or broken:
```

## Clean up

Press `Ctrl+C` in the terminal running `npm run poc`. That stops the server and removes
its containers. Then:

```bash
docker compose down
rm -rf "$HOME/agentguard-first-run"
```

To remove everything, including the local database and the agent's copies:

```bash
docker compose down --volumes
rm -rf "$HOME/.volc-agent-launchpad" .local
```

If this was a temporary key, revoke it in the Console.
