# Fjord

Self-hosted deployment portal for Coolify. Paste a GitHub repo URL, Fjord detects the stack with Claude, generates a Dockerfile, and ships it — one click.

## How it works

1. User signs in with their email (validated against Coolify team members)
2. Pastes a GitHub repo URL
3. Claude analyzes the file tree and generates a production Dockerfile
4. Dockerfile is committed to a `coolify-deploy` branch and a PR is opened
5. A Coolify project + application is created, domain configured, env vars injected
6. Deployment starts and polls until healthy
7. Live URL is returned

## Setup

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- A running [Coolify](https://coolify.io) instance
- GitHub PAT with `repo` + `pull_request` write scope
- Coolify API token (Settings → Keys & Tokens) with read + write permissions
- Anthropic API key

### Install and run

```bash
git clone <this-repo> && cd Fjord
cp .env.example .env   # fill in your values
npm install
npm start              # runs on port 4000
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes | GitHub PAT with repo + PR write scope |
| `GITHUB_ORG` | No | GitHub org to deploy from (default: `CasewareProduct`) |
| `COOLIFY_URL` | No | Coolify instance URL (default: `http://coolify:8080`) |
| `COOLIFY_TOKEN` | Yes | Coolify API token with read + write permissions |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for stack detection |
| `BASE_DEPLOY_DOMAIN` | No | Domain for deployed apps (default: `caseware.steadypat.ch`) |
| `PORT` | No | Server port (default: `4000`) |
| `ADMIN_EMAILS` | No | Comma-separated emails with full control over all projects |
| `NODE_ENV` | No | Set to `production` for Secure cookie flag |

## Auth

Authentication uses your existing Coolify team as the single source of truth — no separate user database.

- **Login:** User enters their email → Fjord checks `GET /api/v1/teams/current/members` on Coolify → if found, session cookie is set
- **Sessions:** In-memory, HttpOnly cookie, 7-day expiry (enforced server-side)
- **Admins:** Emails in `ADMIN_EMAILS` see all projects with full Redeploy/Logs controls
- **Regular users:** See their own projects with full controls, team projects as visit-only
- **Adding/removing users:** Just add or remove them in Coolify — no second system

### Security

- 256-bit crypto-random session IDs
- HttpOnly + SameSite=Lax cookies (+ Secure in production)
- Rate limiting: 10 login attempts per IP per 15 minutes
- Server-side session invalidation on logout
- HTML escaping on all user-controlled output

## Project structure

```
Fjord/
├── backend/
│   └── server.js        # Express API + auth + Coolify/GitHub integration
├── frontend/
│   └── index.html       # Single-page app (login, registry, deploy views)
├── .env.example
├── package.json
└── README.md
```

## API routes

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/login` | No | Validate email against Coolify team |
| `POST` | `/api/logout` | No | Clear session |
| `GET` | `/api/me` | Yes | Current user info |
| `POST` | `/api/deploy` | Yes | Deploy a repo (SSE stream) |
| `GET` | `/api/projects` | Yes | List all projects |
| `POST` | `/api/projects/:id/redeploy` | Yes | Trigger redeploy |
| `GET` | `/api/projects/:id/logs` | Yes | Stream application logs (SSE) |
