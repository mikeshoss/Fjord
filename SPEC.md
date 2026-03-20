# Fjord — Technical Spec v1.0

**Tagline:** Ship it.
**Repo:** mikeshoss/fjord
**Instance:** caseware.steadypat.ch

## What Is Fjord

Fjord is a self-hosted deployment portal that sits in front of a Coolify instance. Users paste a GitHub repo URL and get a live URL back. They never touch Docker, servers, or Coolify directly.

Coolify remains the deployment engine but is invisible to end users. It is an admin-only tool. Fjord is the only interface team members ever need.

## URL Structure

| Route | Who | What |
|-------|-----|------|
| `{BASE_DEPLOY_DOMAIN}/` | Everyone (logged in) | Registry — all deployed projects |
| `{BASE_DEPLOY_DOMAIN}/deploy` | Logged-in users | Deploy a new project |
| `{BASE_DEPLOY_DOMAIN}/{user}-{repo}` | Anyone with link | The deployed app itself |

## File Structure

```
fjord/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── SPEC.md
├── backend/
│   └── server.js        ← Node.js + Express, all API orchestration
└── frontend/
    └── index.html       ← Vanilla HTML/CSS/JS, registry + deploy form
```

## System Flow

When someone clicks Deploy:

1. **GitHub API** → verify repo exists, derive project name: `{username}-{reponame}`
2. **GitHub API** → fetch file tree (recursive), read key config files
3. **Claude API** → analyze stack → return Dockerfile only (or UNKNOWN)
4. **GitHub API** → commit Dockerfile to branch `coolify-deploy`, open PR
5. **Coolify API** → create project
6. **Coolify API** → create application from private GitHub repo
7. **Coolify API** → set domain, inject env vars
8. **Coolify API** → trigger deploy
9. **SSE stream** → pipe build logs to browser
10. **Coolify API** → poll for healthy status → return live URL

## API Routes

| Method | Route | What it does |
|--------|-------|-------------|
| GET | `/` | Serve frontend |
| GET | `/deploy` | Serve frontend |
| POST | `/api/deploy` | Orchestrate full deploy flow, stream logs via SSE |
| GET | `/api/projects` | Return all Coolify projects, filter by `?username=` |
| POST | `/api/projects/:id/redeploy` | Trigger redeploy via Coolify API |
| GET | `/api/projects/:id/logs` | Stream logs via SSE |

## Environment Variables

See `.env.example` for required configuration.

## Dependencies

- `express` — server
- `@anthropic-ai/sdk` — Claude API

No database. No auth. No framework beyond Express.

## Claude Code Instructions

Read this file and `frontend/index.html` before writing any code.
The HTML file is the final UI — do not restyle or restructure it. Wire the backend up to it.
