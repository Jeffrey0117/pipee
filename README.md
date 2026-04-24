<p align="center">
  <h1 align="center">Pipee</h1>
  <p align="center">Zero-config self-hosted deployment tool for full-stack apps</p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> &bull;
    <a href="#features">Features</a> &bull;
    <a href="#how-it-works">How It Works</a> &bull;
    <a href="#cli">CLI</a> &bull;
    <a href="#ai-integration">AI Integration</a>
  </p>
</p>

---

Deploy any app to your own server in 30 seconds. No Docker. No Kubernetes. No YAML hell.

```bash
npx pipee setup     # one-time setup
pipee deploy ./app  # deploy any project
```

Pipee handles **git clone, dependency install, build, PM2 process management, Cloudflare Tunnel routing, health monitoring, auto-restart, and rollback** - all from a single command.

## Why Pipee?

| Problem | Pipee Solution |
|---------|---------------|
| Vercel/Netlify bills pile up | Self-host on any $5/mo VPS |
| Docker is overkill for small apps | Direct PM2 process management |
| Manual deploys are error-prone | Git push &rarr; auto-deploy via webhook |
| No monitoring after deploy | Built-in health watchdog + auto-restart |
| Services crash at 3am | Self-healing with Telegram alerts |

## Quick Start

### Prerequisites

- Node.js 18+
- Git
- PM2 (`npm i -g pm2`)
- A server (VPS, home server, or even your laptop)

### Install

```bash
git clone https://github.com/Jeffrey0117/pipee.git
cd pipee
npm install
npx pipee setup  # interactive wizard
```

### Deploy Your First App

```bash
# From your project directory
pipee init                    # auto-detect framework
pipee deploy ./my-app         # deploy it

# Or from a git repo
pipee deploy https://github.com/user/repo.git
```

### Start the Server

```bash
pm2 start ecosystem.config.js
```

## Features

### Zero-Config Deploy

Pipee auto-detects your framework and configures everything:

- **Node.js** - Express, Fastify, Koa, Hapi
- **Next.js** - App Router, Pages Router
- **Python** - FastAPI, Flask (via uvicorn)
- **Static sites** - HTML/CSS/JS

### Self-Healing

Built-in watchdogs keep your services alive:

- **Service Health Watchdog** - HTTP probes every 2 min, auto-restart after 3 failures
- **Memory Watchdog** - Detects memory leaks, preemptive restart before OOM
- **Post-Deploy Observer** - Watches new deploys for 5 min, auto-rollback on crash
- **Tunnel Watchdog** - 3-tier escalation for Cloudflare Tunnel recovery

### Domain Routing

Route multiple apps through a single server:

```
app1.yourdomain.com  -->  :3000 (Next.js)
app2.yourdomain.com  -->  :4000 (Express API)
api.yourdomain.com   -->  :5000 (FastAPI)
```

Built-in **circuit breaker** prevents cascading failures when a service goes down.

### Git Webhook Deploy

Push to GitHub &rarr; Pipee auto-deploys:

```
GitHub Push --> Webhook --> Pull --> Build --> PM2 Restart
```

Auto-rollback if the new version crashes within 5 minutes.

### Admin API

Full REST API for managing deployments:

```bash
# List all projects
curl localhost:8787/api/_admin/projects

# Deploy a project
curl -X POST localhost:8787/api/_admin/deploy/my-app

# View health status
curl localhost:8787/api/_admin/health-detail

# Rollback
curl -X POST localhost:8787/api/_admin/rollback/my-app
```

### Telegram Bot (Optional)

Control your server from Telegram:

- `/status` - Check all services
- `/deploy <project>` - Trigger deploy
- `/logs <project>` - View recent logs
- Automatic alerts for crashes, restarts, and deploy failures

### Multi-Machine HA (Optional)

Run Pipee on multiple machines with automatic leader election:

- Redis-based distributed locks
- Heartbeat monitoring
- Automatic tunnel failover between machines

## How It Works

```
Your Code (GitHub)
    |
    v
[Webhook] -----> Pipee Server (:8787)
                     |
                     v
              [Deploy Engine]
              git pull -> npm install -> build
                     |
                     v
              [PM2 Process Manager]
              Start/restart app on assigned port
                     |
                     v
              [Router + Cloudflare Tunnel]
              Route domain.com -> localhost:port
                     |
                     v
              [Health Watchdog]
              Monitor -> Auto-restart -> Alert
```

## CLI

```
Usage: pipee [command] [options]

Commands:
  setup              Interactive setup wizard
  start              Start Pipee server
  init               Scan project and generate deploy config
  deploy [path]      Deploy a project
  list               List all deployed projects
  stop <name>        Stop a project
  remove <name>      Remove a project
  logs <name>        View project logs
  env set|list|rm    Manage environment variables
  history            View deployment history

Options:
  -V, --version      Output version
  -h, --help         Display help
```

## AI Integration

### MCP Server

Pipee includes a [Model Context Protocol](https://modelcontextprotocol.io) server, letting AI assistants (Claude, GPT, etc.) manage your deployments:

```json
{
  "mcpServers": {
    "pipee": {
      "command": "node",
      "args": ["./mcp/index.js"],
      "cwd": "/path/to/pipee"
    }
  }
}
```

Available MCP tools: `list_projects`, `deploy`, `restart`, `get_logs`, `rollback`, and more.

### SDK

```javascript
const Pipee = require('./sdk');
const client = new Pipee('http://localhost:8787', 'your-jwt-token');

await client.listProjects();
await client.deploy('my-app');
await client.getLogs('my-app');
```

## Configuration

Copy `config.example.json` to `config.json` and customize:

```json
{
  "domain": "yourdomain.com",
  "port": 8787,
  "adminPassword": "your-secure-password",
  "jwtSecret": "random-secret-here",
  "cloudflared": {
    "path": "cloudflared",
    "tunnelId": "your-tunnel-id"
  },
  "telegram": {
    "enabled": false,
    "botToken": "",
    "chatId": ""
  }
}
```

Or run `pipee setup` for an interactive wizard.

## Project Structure

```
pipee/
  bin/pipee.js          CLI entry point
  index.js              Server entry point
  ecosystem.config.js   PM2 configuration
  config.example.json   Config template

  src/core/             Platform engine
    server.js           HTTP server
    router.js           Domain routing + circuit breaker
    deploy.js           Git/ZIP deployment engine
    admin.js            Admin API
    telegram.js         Telegram bot (optional)
    *.watchdog.js       Self-healing modules

  src/cli/              CLI tool
    commands/           CLI commands
    utils/              Helpers

  sdk/                  Admin API client
  mcp/                  MCP server for AI
  services/             Custom services (user-defined)
  data/                 SQLite + runtime data
```

## Compared to Alternatives

| Feature | Pipee | Coolify | Dokku | Vercel |
|---------|-------|---------|-------|--------|
| Self-hosted | Yes | Yes | Yes | No |
| No Docker required | Yes | No | No | N/A |
| Zero config | Yes | Partial | No | Yes |
| Self-healing | Yes | Partial | No | Yes |
| Telegram alerts | Yes | No | No | No |
| AI (MCP) integration | Yes | No | No | No |
| Multi-machine HA | Yes | Yes | No | Yes |
| Price | Free | Free | Free | $20/mo+ |

## Requirements

- **OS**: Windows, macOS, Linux
- **Node.js**: 18+
- **RAM**: 512MB minimum (for Pipee itself)
- **Optional**: Redis (for multi-machine), Cloudflare Tunnel (for public access)

## License

MIT
