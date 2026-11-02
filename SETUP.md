# Setup from a fresh GitHub clone

This guide gets AgentGuard running from a clean checkout. The agent is Claude.

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- An Anthropic API key
- Docker Desktop, Colima, or Podman
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
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in `.env`. The repository's `.env` is ignored by Git:
never commit it or paste the key into source files.

## 2. Run it

Follow [Run on Claude](README.md#run-on-claude): it starts PostgreSQL, adds your
first user and workspace, and starts the app with `npm run poc`, which builds the
tool image and serves the UI at <http://localhost:3000>.

## 3. Development mode with hot reload

For frontend or API development, with a simulated runtime and no key:

```bash
npm run dev:demo
```

Open <http://localhost:5173>. The API runs at <http://localhost:3000>.

## 4. Verify a clone before sharing it

```bash
npm run check
```

## Troubleshooting

### The server refuses to start, asking for ANTHROPIC_API_KEY

Confirm that `.env` exists and contains a real key, then restart the server.

### `npm run poc` cannot find a container engine

Start Docker Desktop, run `colima start`, or start the Podman machine, then
run `npm run poc` again. You can select an engine explicitly with
`CONTAINER_ENGINE=docker` or `CONTAINER_ENGINE=podman`.

### Port 3000 is already in use

Stop the process using the port or set `PORT`. For the web development server,
use Vite's normal port override separately.
