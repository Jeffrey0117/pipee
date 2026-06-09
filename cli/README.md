# pipee

Deploy static sites to [pipee.tw](https://pipee.tw) from your terminal — with a built-in **Data API backend** (forms, comments, counters; no server needed).

Built for humans *and* AI agents: every command supports `--json`, and `PIPEE_TOKEN` skips interactive login. Tell Claude Code / Cursor "deploy with `pipee deploy`" and it ships your site itself.

## Quickstart

```bash
npm install -g pipee     # or use npx pipee

pipee login              # paste your deploy token (pipee.tw/console → CLI section)
pipee deploy . --site mysite
# ✓ Live at https://mysite.pipee.tw
```

The slug is remembered in `pipee.json`, so the next deploy is just `pipee deploy`.

## Give the site a backend

```bash
pipee data mysite --enable
# Endpoint: https://pipee.tw/api/db/mysite/{collection}
# Key:      pk_xxxxxxxx...
# SDK: <script src="https://pipee.tw/sdk.js" data-site="mysite" data-key="pk_..."></script>
```

Drop the SDK line into your HTML and any form just works:

```html
<form data-pipee="submissions" data-pipee-success="Thanks!">
  <input name="email" type="email" required>
  <button>Subscribe</button>
</form>
```

Read/write from JS: `pipee.create('comments', {...})`, `pipee.list('comments')`.
Full guide (including a copy-paste prompt for ChatGPT/Claude that generates wired-up sites): **https://pipee.tw/ai**

## Commands

| Command | What it does |
|---|---|
| `pipee login [--token <t>]` | Store your deploy token (`~/.pipee/config.json`) |
| `pipee deploy [dir] [--site <slug>]` | Zip + deploy a folder (must contain `index.html`) |
| `pipee sites` | List your sites with size and today's hits |
| `pipee data <slug> [--enable]` | Show / provision the site's Data API key |
| `pipee whoami` | Show current login and plan |
| `pipee logout` | Clear stored credentials |

## For AI agents / CI

```bash
PIPEE_TOKEN=<deploy-token> pipee deploy ./dist --site mysite --json
# {"url":"https://mysite.pipee.tw","slug":"mysite","size":12345}
```

- `--json` on any command → machine-readable output on stdout
- `PIPEE_TOKEN` env → no interactive login, nothing written to disk
- `PIPEE_API` env → point at a different Pipee server

## Notes

- Re-deploying your own slug updates it in place (atomic swap; your Data API key and records are kept).
- `node_modules`, `.git`, and `pipee.json` are excluded from the upload automatically.
- Data API is a Pro-plan feature — see [pipee.tw/pricing](https://pipee.tw/pricing).

MIT © [Jeffrey0117](https://github.com/Jeffrey0117/pipee)
