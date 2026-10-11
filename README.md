# Job Application Tracker

Tracks job and internship applications automatically from Gmail. Personal project. See [docs/plan/](docs/plan/README.md) for the full design.

## Layout

```
frontend/   Next.js app: pages and UI (http://localhost:3000)
backend/    Next.js app: API routes only (http://localhost:4000)
  src/app/api/      API route handlers
  src/server/       backend modules: config, logger, database, job queue
  src/worker/       background worker (Gmail sync will run here)
  migrations/       SQL migrations, applied in order
docs/       plan and setup guide
```

The browser only talks to the frontend. The frontend forwards `/api/*` to the backend.

## Run it locally

Needs Node 22+, pnpm and Docker Desktop.

```powershell
pnpm install
Copy-Item .env.example .env   # first time only, then fill in values as tasks need them
pnpm db:up                    # starts PostgreSQL in Docker on port 5433
pnpm db:migrate               # creates or updates the database tables
pnpm dev                      # starts frontend, backend and worker together
```

Open http://localhost:3000. The footer shows whether the backend and database are connected.

## Checks

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Rules that matter

- **Secrets live only in `.env`.** It is git-ignored. Never commit it.
- **Never use `console.log` in backend code.** Use the logger from `backend/src/server/lib/logger.ts`, which strips email addresses, tokens and unknown fields. Lint enforces this.
- **Database changes go in a new migration file.** Never edit one that has already been applied.
