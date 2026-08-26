# Budget App frontend

This directory contains the Next.js frontend for the Budget App. The root
project README documents the complete application, including the FastAPI API,
local configuration, and deployment.

## Development

From this directory:

```bash
npm install
npm run dev
```

The frontend is available at <http://localhost:3000>. For the complete local
stack, use `./run.sh` from the repository root; it starts the API and frontend
together.

## Verification

```bash
npm run check
npm run format:check
npm run build
npm run test:e2e
```

`npm run test:e2e` requires the configured local backend and Playwright's
browsers. Frontend-only changes should be formatted with Prettier before
running the checks.
