/**
 * Core PIPEE MCP Tools
 * 平台管理工具：list projects, deploy, restart, logs, etc.
 */

const { z } = require('zod')
const { execSync } = require('child_process')
const { existsSync } = require('fs')
const { join, resolve } = require('path')

function registerCoreTools(server, client) {
  server.tool(
    'list_projects',
    'List all PIPEE projects with their status',
    async () => {
      try {
        const projects = await client.projects.list()
        return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'get_project',
    'Get project details and recent deployments',
    { id: z.string().describe('Project ID') },
    async ({ id }) => {
      try {
        const data = await client.projects.get(id)
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'create_project',
    'Register a new project in PIPEE',
    {
      id: z.string().describe('Project ID (lowercase, no spaces)'),
      name: z.string().describe('Display name'),
      repoUrl: z.string().optional().describe('GitHub repo URL'),
      branch: z.string().optional().describe('Git branch (default: master)'),
      port: z.number().describe('Port number'),
      entryFile: z.string().optional().describe('Entry file (e.g. server.js)'),
      buildCommand: z.string().optional().describe('Build command (e.g. npm run build)'),
      buildSteps: z.array(z.object({
        name: z.string().describe('Step name'),
        command: z.string().describe('Shell command'),
        optional: z.boolean().optional().describe('If true, failure does not block deploy'),
      })).optional().describe('Structured build steps (replaces buildCommand)'),
      healthEndpoint: z.string().optional().describe('Health check path (e.g. /api/health)'),
      runner: z.enum(['node', 'next', 'tsx']).optional().describe('PM2 runner type'),
      description: z.string().optional().describe('Project description'),
    },
    async (params) => {
      try {
        const data = {
          ...params,
          deployMethod: params.repoUrl ? 'github' : 'local',
          branch: params.branch || 'master',
          directory: `projects/${params.id}`,
          pm2Name: params.id,
        }
        const result = await client.projects.create(data)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'update_project',
    'Update an existing project configuration',
    {
      id: z.string().describe('Project ID'),
      name: z.string().optional().describe('Display name'),
      repoUrl: z.string().optional().describe('GitHub repo URL'),
      branch: z.string().optional().describe('Git branch'),
      port: z.number().optional().describe('Port number'),
      entryFile: z.string().optional().describe('Entry file'),
      buildCommand: z.string().optional().describe('Build command'),
      buildSteps: z.array(z.object({
        name: z.string().describe('Step name'),
        command: z.string().describe('Shell command'),
        optional: z.boolean().optional().describe('If true, failure does not block deploy'),
      })).optional().describe('Structured build steps (replaces buildCommand)'),
      healthEndpoint: z.string().optional().describe('Health check path'),
      runner: z.enum(['node', 'next', 'tsx']).optional().describe('PM2 runner type'),
      description: z.string().optional().describe('Project description'),
    },
    async ({ id, ...updates }) => {
      try {
        const result = await client.projects.update(id, updates)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'delete_project',
    'Remove a project from PIPEE',
    { id: z.string().describe('Project ID') },
    async ({ id }) => {
      try {
        const result = await client.projects.delete(id)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'deploy_project',
    'Trigger a deployment for a project',
    { id: z.string().describe('Project ID') },
    async ({ id }) => {
      try {
        const result = await client.deploy(id)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'restart_project',
    'Restart a project via PM2',
    { id: z.string().describe('Project ID') },
    async ({ id }) => {
      try {
        const result = await client.restart(id)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'get_logs',
    'Get PM2 logs for a project',
    { id: z.string().describe('Project ID (pm2Name)') },
    async ({ id }) => {
      try {
        const data = await client.logs(id)
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'get_deployments',
    'Get deployment history (all or for a specific project)',
    { id: z.string().optional().describe('Project ID (optional, omit for all)') },
    async ({ id }) => {
      try {
        let data
        if (id) {
          const project = await client.projects.get(id)
          data = project.deployments || []
        } else {
          data = await client.deployments.list()
        }
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'system_info',
    'Get PIPEE system information',
    async () => {
      try {
        const data = await client.system()
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'machines',
    'Get status of all PIPEE machines and tunnel connectors',
    async () => {
      try {
        const data = await client.machines()
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'rollback_project',
    'Rollback a project to its previous running commit (or a specific commit)',
    {
      id: z.string().describe('Project ID'),
      commit: z.string().optional().describe('Target commit hash (defaults to last running commit)'),
    },
    async ({ id, commit }) => {
      try {
        const result = await client.rollback(id, commit)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'init_repo',
    'Initialize a Git repo for a project, generate README + .gitignore, create GitHub repo, and push. Use this to put a new project on GitHub.',
    {
      id: z.string().describe('Project ID'),
      owner: z.string().optional().describe('GitHub owner'),
    },
    async ({ id, owner }) => {
      try {
        const body = owner ? { owner } : undefined
        const result = await client.initRepo(id, body)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  // --- ver2 cache-busting tool ---

  server.tool(
    'cache_bust',
    'Run ver2 cache-busting on a project\'s static HTML files. Scans HTML, hashes static assets (JS/CSS/images), and adds/updates ?v={hash} query params for cache invalidation.',
    {
      projectId: z.string().describe('Project ID — resolves to projects/{id}/public'),
      path: z.string().optional().describe('Custom path relative to project root (default: ./public)'),
      dryRun: z.boolean().optional().describe('Preview changes without writing (default: false)'),
      strip: z.string().optional().describe('Strip URL prefix before resolving (e.g. /static/)'),
    },
    async ({ projectId, path, dryRun, strip }) => {
      try {
        const projectDir = resolve(join(__dirname, '..', 'projects', projectId))
        if (!existsSync(projectDir)) {
          return { content: [{ type: 'text', text: `Error: Project directory not found: projects/${projectId}` }], isError: true }
        }

        const targetPath = path || './public'
        const fullTarget = resolve(join(projectDir, targetPath))
        if (!existsSync(fullTarget)) {
          return { content: [{ type: 'text', text: `Error: Target path not found: ${targetPath} (resolved: ${fullTarget})` }], isError: true }
        }

        const args = [fullTarget]
        if (dryRun) args.push('--dry-run')
        if (strip) args.push('--strip', strip)

        const cmd = `npx ver2-cli ${args.map(a => `"${a}"`).join(' ')}`
        const output = execSync(cmd, {
          cwd: projectDir,
          encoding: 'utf-8',
          timeout: 30000,
        })

        const summary = dryRun
          ? `[DRY RUN] ver2 preview for ${projectId}:\n${output}`
          : `ver2 cache-bust complete for ${projectId}:\n${output}`

        return { content: [{ type: 'text', text: summary }] }
      } catch (err) {
        const stderr = err.stderr || ''
        const stdout = err.stdout || ''
        return {
          content: [{ type: 'text', text: `Error running ver2: ${err.message}\n${stderr}\n${stdout}` }],
          isError: true,
        }
      }
    }
  )

  // --- Scheduler tools ---

  server.tool(
    'list_schedules',
    'List all scheduled tasks with their status, cron expression, and last run',
    async () => {
      try {
        const scheduler = require('../src/core/scheduler')
        const schedules = scheduler.listSchedules()
        return { content: [{ type: 'text', text: JSON.stringify(schedules, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'run_schedule',
    'Manually trigger a scheduled task immediately',
    { id: z.string().describe('Schedule ID') },
    async ({ id }) => {
      try {
        const scheduler = require('../src/core/scheduler')
        const result = await scheduler.runSchedule(id)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'toggle_schedule',
    'Enable or disable a scheduled task',
    { id: z.string().describe('Schedule ID') },
    async ({ id }) => {
      try {
        const scheduler = require('../src/core/scheduler')
        const result = scheduler.toggleSchedule(id)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }
  )
}

module.exports = { registerCoreTools }
