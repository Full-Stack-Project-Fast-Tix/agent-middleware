# Setup from a fresh GitHub clone

This guide gets the Agent Launchpad running from a clean checkout. The project
uses Codex with the native OpenAI provider.

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- An OpenAI API key
- Docker Desktop, Colima, or Podman for the recommended runtime
- Git

## Platform support

The documented and tested local-runtime paths are macOS and Linux. On Windows,
use WSL2 with Docker Desktop and run the commands inside the WSL2 shell; the
native Windows path is not currently verified.

## 1. Clone and install

```bash
git clone <your-github-repository-url>
cd agent-middleware
npm ci
```

The repository's `.env` file is intentionally ignored by Git. Create your
local copy from the checked-in template:

```bash
cp .env.example .env
```

Edit `.env` and set:

```dotenv
APP_AUTH_MODE=token
MODEL_PROVIDER=openai
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-5.1
```

The template documents Claude as its default choice, but this guide is for the
single-agent Playground, which needs Codex. To run multi-agent Runs on Claude
instead, follow [Run on Claude](README.md#run-on-claude).

Never commit `.env` or paste the API key into source files. Use a long random
`APP_AUTH_TOKEN` when the app will be reachable beyond your own machine.

## 2. Recommended: run the isolated container runtime

Start Docker, Colima, or Podman, then run:

```bash
npm run poc
```

This builds the disposable Agent Runtime image, starts the API, and serves the
UI at <http://localhost:3000>. Open the page, create an Agent, and send it a
task from the Playground.

The container path is the recommended demo path because it records the Agent
trajectory and enables the runtime safety checks. Agent workspaces and local
state remain in the project directories and are not committed.

## 3. Development mode with hot reload

For frontend or API development, use the host-process runner:

```bash
npm run dev
```

Open <http://localhost:5173>. The API runs at <http://localhost:3000>.

This mode requires `RUNTIME_PROVIDER=local-process` in `.env`, and the Codex CLI on
the host:

```bash
npm install --global @openai/codex@0.111.0
```

The host-process runner is convenient for development but does not provide the
same container trace and runtime isolation as `npm run poc`.

## 4. Docker Compose

To run the production-shaped image locally, set this in `.env`, because the image
runs Codex:

```dotenv
MODEL_PROVIDER=openai
RUNTIME_PROVIDER=local-process
CONTAINER_RUNTIME_IMAGE=volc-agent-runtime:local
```

Then:

```bash
docker compose up --build
```

Open <http://localhost:3000>. Stop it with:

```bash
docker compose down
```

The bind-mounted `data/`, `workspaces/`, and `codex-home/` directories are
kept between runs.

## 5. Verify a clone before sharing it

Run the checks used by the repository:

```bash
npm run check
```

For a quick build-only check:

```bash
npm run build
```

## Troubleshooting

### The UI says the runtime is not configured

Confirm that `.env` exists and contains `MODEL_PROVIDER=openai` and a real
`OPENAI_API_KEY`, then restart the server.

### `npm run poc` cannot find a container engine

Start Docker Desktop, run `colima start`, or start the Podman machine, then
run `npm run poc` again. You can select an engine explicitly with
`CONTAINER_ENGINE=docker` or `CONTAINER_ENGINE=podman`.

### Port 3000 is already in use

Stop the process using the port or choose another port for the API. For the
web development server, use Vite's normal port override separately.

### The Agent cannot write files

Use `npm run poc` and confirm that the repository's `workspaces/` directory is
writable. The host-process runner also needs the Codex CLI to be installed and
available on `PATH`.
