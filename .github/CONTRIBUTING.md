# Contributing to Kin

Thank you for your interest in contributing to Kin! This document provides guidelines and instructions for contributing.

## Code of Conduct

Please be respectful and considerate of others when contributing to this project. We aim to foster an inclusive and welcoming community. Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Getting Started

### Prerequisites

- **Node.js** >= 22.12 (see `package.json` `engines.node`)
- **pnpm** (recommended package manager)
- **Docker** (optional, for local database and services)
- **PostgreSQL** (or use Docker Compose)

### Running with Docker (recommended for first-time setup)

The fastest way to get the app running is with the one-command installer, which pulls the
prebuilt multi-arch GHCR images. See the [README Quick Start](README.md#quick-start) for the
full set of paths (VPS installer, Cloudflare Tunnel, local development).

```bash
git clone https://github.com/deeptoai-com/kin.git
cd kin
sudo bash scripts/install-vps.sh            # interactive; generates secrets, pulls images
```

When it finishes, open `https://<your-domain>` and register the first account. For a Mac /
workstation behind NAT, use the Cloudflare Tunnel path (`docker-compose.tunnel.yml`) — see
[docs/deployment/tunnel.md](docs/deployment/tunnel.md).

### Development Setup (local, without Docker)

1. **Clone the repository:**
   ```bash
   git clone https://github.com/deeptoai-com/kin.git
   cd kin
   ```

2. **Install dependencies:**
   ```bash
   pnpm install
   ```

3. **Set up environment variables:**
   ```bash
   cp .env.example .env
   ```
   
   **Minimum required environment variables** (for basic development):
   ```bash
   # Database
   DATABASE_URL="postgresql://user:password@localhost:5432/kin"
   
   # Claude Agent SDK (required for main chat feature)
   ANTHROPIC_API_KEY="sk-ant-..."
   
   # Better Auth (required for authentication)
   BETTER_AUTH_SECRET="your-secret-key-here"
   BETTER_AUTH_URL="http://localhost:3000"
   ```
   
   See `.env.example` for all available configuration options.

4. **Set up the database:**
   ```bash
   # Run migrations
   pnpm db:migrate
   ```

5. **Start the development server:**
   ```bash
   # Terminal 1: Start the main app
   pnpm dev
   
   # Terminal 2: Start the WebSocket server (required for Claude Chat)
   node ws-server.mjs
   ```
   
   The app will be available at `http://localhost:3000`.

## Development Commands

| Command | Description | Required |
|---------|-------------|----------|
| `pnpm dev` | Start the development server (Vite + TanStack Start) | ✅ Yes |
| `node ws-server.mjs` | Start WebSocket server for Claude Agent Chat | ✅ Yes (for Claude Chat) |
| `pnpm worker` | Start background worker (for jobs, search sync) | ⚠️ Optional |
| `pnpm db:migrate` | Run database migrations | ✅ Yes (first time) |
| `pnpm db:studio` | Open Drizzle Studio (database GUI) | ⚠️ Optional |
| `pnpm build` | Build for production | ⚠️ Optional |
| `pnpm test` | Run unit tests | ⚠️ Optional |
| `pnpm test:e2e` | Run end-to-end tests | ⚠️ Optional |
| `pnpm lint` | Run linter | ⚠️ Optional |
| `pnpm typecheck` | Run TypeScript type checking | ⚠️ Optional |
| `pnpm validate-routes` | Validate routes against TanStack Start best practices | ⚠️ Optional |

## Project Structure

```
kin/
├── src/
│   ├── claude/              # Claude Agent SDK integration
│   │   ├── adapters/        # WebSocket adapter for Assistant UI
│   │   ├── skills/          # Skills management and loading
│   │   └── mcp/             # MCP (Model Context Protocol) integration
│   ├── components/          # React UI components
│   │   ├── claude-chat/     # Claude Chat UI components
│   │   └── ui/              # shadcn/ui components
│   ├── routes/              # TanStack Router routes
│   │   ├── agents/          # Agent-related pages
│   │   └── api/             # REST API endpoints (whitelisted only)
│   ├── server/              # Server-side logic
│   │   ├── function/        # Server Functions (preferred)
│   │   ├── auth.ts          # Better Auth configuration
│   │   └── s3/              # File storage (S3/MinIO)
│   ├── db/                  # Database layer
│   │   ├── schema/          # Drizzle ORM schemas
│   │   └── repositories/   # Data access layer
│   └── lib/                 # Shared utilities and stores
├── ws-server.mjs            # WebSocket server entry point
├── ws-query-worker.mjs      # Worker process for Claude Agent SDK
└── docker-compose.yml       # Docker Compose configuration
```

### Key Components

- **`ws-server.mjs`**: Main WebSocket server that handles authentication, session management, and process lifecycle for Claude Agent Chat.
- **`ws-query-worker.mjs`**: Worker process that calls Claude Agent SDK's `query()` function in isolated subprocesses.
- **`src/claude/`**: Core Claude Agent SDK integration (WebSocket adapter, skills, MCP).
- **`src/routes/`**: TanStack Router file-based routes (pages and API endpoints).
- **`src/server/function/`**: Server Functions (preferred over REST API).

## Code Style and Conventions

### Server Functions First

**✅ Preferred**: Use Server Functions for all new server-side operations.

```typescript
// src/server/function/example.server.ts
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

export const getExampleData = createServerFn({ method: 'GET' })
  .handler(async () => {
    return await fetchData();
  });

export const updateExample = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ id: z.string(), data: z.object({ ... }) }))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return await updateData(user.id, data);
  });
```

**❌ Avoid**: Creating new REST API routes.

```typescript
// ❌ Don't do this
export const Route = createFileRoute('/api/example')({
  server: {
    handlers: {
      GET: async () => Response.json(data),
    },
  },
});
```

### REST API Whitelist

Only the following REST API endpoints are allowed (for third-party integrations and system endpoints):

- `/api/agent-sessions` - WebSocket server dependency
- `/api/auth` - Better Auth integration
- `/api/auth/polar` - Polar webhook
- `/api/billing`, `/api/subscription`, `/api/invoices` - Billing (Polar)
- `/api/health` - Health check
- `/api/jobs` - Background jobs
- `/api/search` - Search service
- `/api/workflow` - Workflow API

See `scripts/validate-routes.mjs` for the complete whitelist.

### Before Submitting a PR

Run these checks to ensure code quality:

```bash
# 1. Type checking
pnpm typecheck

# 2. Linting
pnpm lint

# 3. Route validation (TanStack Start best practices)
pnpm validate-routes

# 4. Tests
pnpm test
```

All checks should pass before submitting a PR.

## Testing

### Unit Tests

```bash
pnpm test
```

### End-to-End Tests

```bash
pnpm test:e2e
```

**Note**: E2E tests require:
- Local development server running (`pnpm dev`)
- Database configured (`.env` with `DATABASE_URL`)
- WebSocket server running (optional, depending on test)

## Submitting Changes

### Branch Naming

Use descriptive branch names:
- `feature/add-new-skill` - New features
- `fix/resolve-websocket-issue` - Bug fixes
- `refactor/simplify-auth` - Code refactoring
- `docs/update-readme` - Documentation updates

### Pull Request Process

1. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** and ensure all checks pass:
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm validate-routes
   pnpm test
   ```

3. **Commit your changes** with clear, descriptive messages:
   ```bash
   git commit -m "feat: add new skill management feature"
   ```

4. **Push to your fork** and create a pull request:
   ```bash
   git push origin feature/your-feature-name
   ```

5. **PR Requirements**:
   - Clear, descriptive title
   - Description explaining what the PR does and why
   - All CI checks must pass
   - Link to related issues (if any)

### PR Template

```markdown
## Summary
Brief description of changes

## Changes
- Change 1
- Change 2

## Testing
How you tested these changes

## Screenshots (if applicable)
```

## Key Areas

- **Claude Agent Integration**: `src/claude/` - WebSocket adapter, skills, MCP
- **Server Functions**: `src/server/function/` - Preferred server-side API
- **Database**: `src/db/` - Schemas and repositories
- **UI Components**: `src/components/` - React components

## Questions?

- Open an issue for bugs or feature requests
- Check [README.md](README.md) for general information
- See [SECURITY.md](SECURITY.md) for security-related questions

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](../LICENSE).
