# Pipee

Simple self-hosted static site hosting. Clone, install, start — anyone can deploy static websites.

## Quick Start

```bash
git clone https://github.com/Jeffrey0117/pipee.git
cd pipee
npm install
npm start
```

Server starts at `http://localhost:3939`. Open `http://localhost:3939/console` to manage your sites.

## Configuration

Edit `config.json` (auto-created from `config.example.json` on first run):

| Field | Default | Description |
|-------|---------|-------------|
| `port` | `3939` | Server port |
| `domain` | `localhost` | Your domain (e.g. `pipee.example.com`) |
| `jwtSecret` | `change-this...` | JWT signing secret — **change this!** |
| `maxSites` | `10` | Max sites per user |
| `maxSiteSize` | `52428800` | Max site size in bytes (50 MB) |

## API

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register `{ username, password }` |
| POST | `/api/auth/login` | Login `{ username, password }` |

### User

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/user/me` | Get current user info |
| GET | `/api/user/sites` | List your sites |
| POST | `/api/user/sites` | Create site `{ slug }` |
| POST | `/api/user/sites/:slug/deploy` | Upload ZIP to deploy |
| PUT | `/api/user/sites/:slug/settings` | Update site settings |
| DELETE | `/api/user/sites/:slug` | Delete a site |

All user endpoints require `Authorization: Bearer <token>` header.

## How It Works

1. Register an account at `/console`
2. Create a site with a unique slug (e.g. `my-blog`)
3. Upload a ZIP file containing your static site (must include `index.html`)
4. Your site is live at `http://localhost:3939/_sites/my-blog/`

With a custom domain configured, sites are served at `https://my-blog.yourdomain.com`.

## Stack

- **Node.js** — zero external runtime dependencies
- **SQLite** (better-sqlite3) — embedded database, no PostgreSQL/MySQL needed
- **JWT** (jsonwebtoken) — stateless authentication
- **adm-zip** — ZIP extraction for deployments

## Project Structure

```
pipee/
  index.js              Entry point
  config.example.json   Config template
  package.json          3 dependencies

  src/core/
    server.js           HTTP server + routing
    static.js           Static file serving (core)
    db.js               SQLite (users + sites)
    user-auth.js        Local JWT auth
    user-api.js         Site management API

  public/
    index.html          Landing page
    console.html        Management UI
    style.css           Styles
    i18n.js             Internationalization

  data/
    static/             Deployed site files
    PIPEE.db            SQLite database
```

## License

MIT
