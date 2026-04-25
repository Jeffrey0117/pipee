/**
 * Admin Deploy Handlers
 *
 * Project CRUD, deploy, rollback, init-repo, webhook setup.
 * Extracted from admin.js for maintainability.
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const deploy = require('../deploy')

const ROOT = path.join(__dirname, '../../..')

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) }
      catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

async function handleCreateProject(req, res) {
  try {
    const data = await parseJsonBody(req)
    const project = await deploy.createProject(data)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: true, project }))
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

async function handleUpdateProject(req, res, id) {
  try {
    const data = await parseJsonBody(req)
    const project = deploy.updateProject(id, data)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: true, project }))
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

function handleRestartProject(req, res, id) {
  try {
    const project = deploy.getProject(id)
    if (!project) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: '專案不存在' }))
    }
    const pm2Name = project.pm2Name || id
    execSync(`pm2 restart ${pm2Name}`, { stdio: 'pipe', windowsHide: true })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: true, message: `${pm2Name} 已重啟` }))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

async function handleManualDeploy(req, res, id) {
  try {
    const url = new URL(req.url, 'http://localhost')
    const sync = url.searchParams.get('sync') === 'true'

    console.log(`[deploy] 手動觸發部署: ${id}${sync ? ' (sync)' : ''}`)

    if (sync) {
      const result = await deploy.deploy(id, { triggeredBy: 'manual' })
      res.writeHead(result.status === 'success' ? 200 : 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        success: result.status === 'success',
        deployment: {
          id: result.id,
          status: result.status,
          commit: result.commit,
          duration: result.duration,
          error: result.error,
        },
      }))
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, message: '部署已觸發' }))

      deploy.deploy(id, { triggeredBy: 'manual' }).catch(err => {
        console.error(`[deploy] 部署失敗: ${err.message}`)
      })
    }
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

async function handleRollback(req, res, id) {
  try {
    let targetCommit = null
    try {
      const data = await parseJsonBody(req)
      targetCommit = data.commit || null
    } catch {}

    console.log(`[rollback] Triggered for: ${id}${targetCommit ? ` → ${targetCommit}` : ' (last running)'}`)

    const result = await deploy.rollback(id, targetCommit, { triggeredBy: 'admin' })
    const statusCode = result.status === 'success' ? 200 : 500
    res.writeHead(statusCode, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      success: result.status === 'success',
      deployment: {
        id: result.id,
        status: result.status,
        commit: result.commit,
        duration: result.duration,
        error: result.error,
      },
    }))
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

async function handleInitRepoRoute(req, res, id) {
  try {
    const project = deploy.getProject(id)
    if (!project) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: '專案不存在' }))
    }

    let options = {}
    try { options = await parseJsonBody(req) } catch {}

    const projectDir = path.resolve(ROOT, project.directory)
    if (!fs.existsSync(projectDir)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: `專案目錄不存在: ${project.directory}` }))
    }

    const hasGit = fs.existsSync(path.join(projectDir, '.git'))
    let hasRemote = false
    if (hasGit) {
      try {
        const remotes = execSync('git remote -v', { cwd: projectDir, encoding: 'utf8', windowsHide: true })
        hasRemote = remotes.includes('origin')
      } catch {}
    }

    const result = { project: id, steps: [] }

    // 1. Generate .gitignore if missing
    if (!fs.existsSync(path.join(projectDir, '.gitignore'))) {
      fs.writeFileSync(path.join(projectDir, '.gitignore'), generateGitignore(project))
      result.steps.push('Generated .gitignore')
    }

    // 2. Generate README.md
    fs.writeFileSync(path.join(projectDir, 'README.md'), generateReadme(project, id))
    result.steps.push('Generated README.md')

    // 3. Git init if needed
    if (!hasGit) {
      execSync('git init', { cwd: projectDir, stdio: 'pipe', windowsHide: true })
      execSync('git branch -M master', { cwd: projectDir, stdio: 'pipe', windowsHide: true })
      result.steps.push('Initialized git repository')
    }

    // 4. Git add + commit
    const commitMsg = hasGit
      ? 'chore: update README via initrepo'
      : 'Initial commit via PIPEE initrepo'
    execSync('git add -A', { cwd: projectDir, stdio: 'pipe', windowsHide: true })
    try {
      execSync(`git commit -m "${commitMsg}"`, {
        cwd: projectDir, stdio: 'pipe', windowsHide: true,
      })
      result.steps.push('Created commit')
    } catch {
      result.steps.push('No new changes to commit')
    }

    // 5. Create GitHub repo or push to existing remote
    if (!hasRemote) {
      const repoName = project.name || id
      const ghOwner = options.owner || getConfig().githubOwner || 'pipee-user'
      const desc = (project.description || '').replace(/"/g, '\\"')
      const descFlag = desc ? ` --description "${desc}"` : ''
      try {
        execSync(
          `gh repo create ${ghOwner}/${repoName} --public --source=. --push${descFlag}`,
          { cwd: projectDir, stdio: 'pipe', windowsHide: true, timeout: 30000 },
        )
        const repoUrl = `https://github.com/${ghOwner}/${repoName}`
        result.repoUrl = repoUrl
        result.steps.push(`Created GitHub repo: ${repoUrl}`)
        deploy.updateProject(id, { repoUrl })
        result.steps.push('Updated project repoUrl')
      } catch (err) {
        const stderr = err.stderr ? err.stderr.toString().trim() : err.message
        result.steps.push(`GitHub repo creation failed: ${stderr}`)
        result.error = stderr
      }
    } else {
      try {
        execSync('git push', { cwd: projectDir, stdio: 'pipe', windowsHide: true, timeout: 30000 })
        result.steps.push('Pushed to existing remote')
        const remoteUrl = execSync('git remote get-url origin', {
          cwd: projectDir, encoding: 'utf8', windowsHide: true,
        }).trim()
        result.repoUrl = remoteUrl
      } catch (err) {
        const stderr = err.stderr ? err.stderr.toString().trim() : err.message
        result.steps.push(`Push failed: ${stderr}`)
      }
    }

    const statusCode = result.error ? 500 : 200
    res.writeHead(statusCode, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: !result.error, ...result }))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

function generateGitignore(project) {
  const lines = [
    'node_modules/',
    '.env',
    '.env.local',
    '.env.production',
    '*.db',
    '*.sqlite',
    '*.sqlite3',
    'data/',
    'uploads/',
    'storage/',
    'db/',
    '.pm2-start.cjs',
    '*.log',
    '.DS_Store',
    'Thumbs.db',
  ]
  if (project.runner === 'next') {
    lines.push('.next/', 'out/')
  }
  return lines.join('\n') + '\n'
}

function generateReadme(project, id) {
  const name = project.name || id
  const desc = project.description || ''
  const port = project.port || '?'

  const manifestPath = path.join(ROOT, 'data', 'manifests', `${id}.json`)
  let manifest = null
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch {}

  const lines = [`# ${name}`, '']
  if (desc) lines.push(desc, '')
  lines.push('Deployed with [Pipee](https://github.com/Jeffrey0117/pipee).', '')

  lines.push('## Quick Start', '', '```bash', 'npm install')
  if (project.buildCommand) lines.push(project.buildCommand)
  lines.push(`PORT=${port} node ${project.entryFile || 'server.js'}`, '```', '')

  lines.push('## Environment', '', '| Variable | Description |', '|----------|-------------|')
  lines.push(`| \`PORT\` | Server port (default: ${port}) |`, '')

  if (manifest && manifest.endpoints && manifest.endpoints.length > 0) {
    lines.push('## API', '', '| Method | Path | Description |', '|--------|------|-------------|')
    if (project.healthEndpoint) {
      lines.push(`| GET | \`${project.healthEndpoint}\` | Health check |`)
    }
    for (const ep of manifest.endpoints) {
      lines.push(`| ${ep.method} | \`${ep.path}\` | ${ep.description || ep.name} |`)
    }
    lines.push('')
  }

  lines.push('## License', '', 'MIT', '')
  return lines.join('\n')
}

async function handleSetupWebhook(req, res, id) {
  let body = ''
  req.on('data', chunk => body += chunk)
  req.on('end', async () => {
    try {
      const { webhookUrl } = JSON.parse(body)
      if (!webhookUrl) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: '缺少 webhookUrl' }))
      }

      const result = await deploy.setupGitHubWebhook(id, webhookUrl)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  })
}

async function handleRemoveWebhook(req, res, id) {
  try {
    const result = await deploy.removeGitHubWebhook(id)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

function handleListWebhooks(req, res, id) {
  try {
    const webhooks = deploy.listGitHubWebhooks(id)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ webhooks }))
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

function handleGetPM2Logs(req, res, pm2Name) {
  try {
    const pm2LogPath = path.join(process.env.USERPROFILE || process.env.HOME, '.pm2', 'logs')
    const outLogPath = path.join(pm2LogPath, `${pm2Name}-out.log`)
    const errLogPath = path.join(pm2LogPath, `${pm2Name}-error.log`)

    let logs = ''

    if (fs.existsSync(outLogPath)) {
      const content = fs.readFileSync(outLogPath, 'utf8')
      const lines = content.split('\n').slice(-100).join('\n')
      logs += '=== stdout ===\n' + lines + '\n\n'
    }

    if (fs.existsSync(errLogPath)) {
      const content = fs.readFileSync(errLogPath, 'utf8')
      const lines = content.split('\n').slice(-50).join('\n')
      if (lines.trim()) {
        logs += '=== stderr ===\n' + lines
      }
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ logs: logs || '無 log 檔案' }))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

module.exports = {
  handleCreateProject,
  handleUpdateProject,
  handleRestartProject,
  handleManualDeploy,
  handleRollback,
  handleInitRepoRoute,
  handleSetupWebhook,
  handleRemoveWebhook,
  handleListWebhooks,
  handleGetPM2Logs,
}
