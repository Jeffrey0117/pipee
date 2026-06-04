# Pipee

Simple self-hosted static site hosting. Register, create a slug, upload a ZIP (or push to git) — your static site goes live.

## Stack

- **Node.js** (>=18, CommonJS) — raw `http` server, no framework
- **better-sqlite3** — embedded DB (users + sites), WAL mode, lazy singleton
- **jsonwebtoken** — stateless JWT auth (local username/password)
- **adm-zip** — ZIP extraction for uploads
- Auth crypto: `crypto.scrypt` (password hashing) + JWT
- AI Editor: spawns local **Claude Code CLI** subprocess (no API key)
- Optional integrations: **Gitea** (auto-repos + git push deploy), **PayGate** (subscriptions via webhook), CloudPipe mailer

## Directory structure

```
index.js              Entry: ensures data dirs, seeds config.json, starts server
config.example.json   Config template (copied to config.json on first run)
config.json           Runtime config — gitignored, do not commit

src/core/
  server.js           HTTP server + routing (subdomain & path-based site serving)
  static.js           Static file serving, MIME, SPA fallback, path-traversal guard
  db.js               SQLite layer; schema + migrations + PLANS config
  user-auth.js        scrypt password hashing + JWT issue/verify
  user-api.js         All /api routes: auth, sites, deploy, AI chat, git, webhooks
  ai-editor.js        Claude CLI subprocess editing of a site's files (Pro+)
  ai-sessions.js      In-memory Claude session IDs per user+slug (4h TTL)
  git-deploy.js       Clone/pull a repo into data/git-cache, deploy as static
  git-proxy.js        Git Smart-HTTP proxy → Gitea (Pipee creds, never touch Gitea)
  gitea.js            Gitea client: auto-create/delete repos, commits, diffs

public/               Landing page, console.html (management UI), i18n.js, assets
data/                 Runtime (gitignored): static/{slug}/ sites, pipee-data.db, git-cache/
cli/, mcp/            Scaffolding only (node_modules + lockfile, not yet implemented)
docs/                 Design specs
```

## Key concepts

- **Site serving (two modes)**: production = `{slug}.{domain}` subdomain; localhost = `/_sites/{slug}/` path. `server.js` rewrites `req.url` then calls `handleSite`.
- **Slugs are the primary key**: `sites.slug` (TEXT PK). Validated `^[a-z0-9][a-z0-9-]*[a-z0-9]$`. Every route ownership-checks `site.user_id === user.id`.
- **Deploy methods** (`sites.deploy_method`): `upload` (ZIP), `git`/`github` (clone on push via webhook), Gitea (`/git/...` push). Deploys extract to temp dir then atomically swap via rename, keeping a `.old-*` backup.
- **Plans & quotas** (`db.PLANS`): `free` / `pro` / `creator`. Gate AI Editor + Git Dashboard. First registered user (id=1) is auto-promoted to `creator` (admin).
- **Effective plan**: entitlements follow `effectivePlan(user)` — a lapsed `sub_expires_at` reverts to `free` even if the `expired` webhook never arrived. Always use this, not raw `user.plan`.
- **Email verification → subscriptions**: PayGate maps a sub to a user *only by verified email* (`getVerifiedUserByEmail`), preventing pre-claim hijacking. Unique index on verified emails only.
- **Webhooks**: PayGate (`x-webhook-signature`, HMAC-SHA256), Gitea (`x-gitea-signature`), GitHub (`x-hub-signature-256`) — all `timingSafeEqual`. Webhook handlers respond 200 immediately, deploy in background.
- **AI Editor**: `ai-chat` spawns Claude CLI in the site dir; quota only increments when files actually change. Session IDs cached in-memory (`ai-sessions.js`) for conversation continuity.
- **Config loading**: `loadConfig()` in server.js; secrets (`PAYGATE_WEBHOOK_SECRET`, `MAILER_TOKEN`, `PORT`) prefer env vars over config.json.

## Commands

```bash
npm install      # install 3 deps
npm start        # start server (also: npm run dev) → http://localhost:3939
                 #   console at /console
```

No build step, no test suite, no linter configured. Node `http` only — no PM2/Redis/tunnel.

## Coding rules

- **No framework**: route by hand in `user-api.js` (regex match on method + pathname). New endpoints go in `handle()`.
- **Security is load-bearing**: keep path-traversal checks (`resolved.startsWith(normalizedDest)`), forbidden extensions, size/file-count caps, ownership checks, and timing-safe signature comparison.
- **Never commit** `config.json` or anything under `data/` (gitignored).
- **Don't leak internals**: API errors return safe messages (`{ error, code }`); log details server-side with `console.error`.
- **Migrations are additive**: add columns via `ALTER TABLE ... ADD COLUMN` guarded by a `PRAGMA table_info` check (see db.js).
- **Plan checks**: gate features on `effectivePlan(user)`, not `user.plan`.
