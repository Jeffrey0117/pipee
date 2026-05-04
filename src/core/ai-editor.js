/**
 * AI Editor — Claude Code CLI powered site editing
 *
 * Spawns Claude Code CLI as a subprocess to edit user's static sites.
 * Pro feature: users chat with Claude to modify their deployed sites.
 * No API key needed — uses locally installed Claude CLI.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { STATIC_DIR } = require('./static');

const TIMEOUT_MS = 120_000; // 2 minutes

// ── Resolve Claude CLI path (same logic as ClaudeBot) ──

function resolveClaudeCli() {
  if (process.platform !== 'win32') {
    return { cmd: 'claude', prefix: [] };
  }
  try {
    const cmdPath = execSync('where claude.cmd', { encoding: 'utf-8', windowsHide: true })
      .trim().split('\n')[0].trim();
    const dir = path.dirname(cmdPath);
    const cliJs = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(cliJs)) {
      return { cmd: process.execPath, prefix: [cliJs] };
    }
    return { cmd: 'claude', prefix: [] };
  } catch {
    return { cmd: 'claude', prefix: [] };
  }
}

const claudeCli = resolveClaudeCli();

// ── Stream event parser ──

function handleStreamEvent(event, handlers) {
  switch (event.type) {
    case 'assistant': {
      handlers.onNewTurn();
      const msg = event.message;
      if (msg && msg.content) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            handlers.onTextDelta(block.text);
          } else if (block.type === 'tool_use' && block.name) {
            handlers.onToolUse(block.name, block.input);
          }
        }
      }
      break;
    }
    case 'content_block_start': {
      if (event.content_block.type === 'tool_use' && event.content_block.name) {
        handlers.onToolUse(event.content_block.name, null);
      }
      break;
    }
    case 'content_block_delta': {
      if (event.delta && event.delta.type === 'text_delta' && event.delta.text) {
        handlers.onTextDelta(event.delta.text);
      }
      break;
    }
    case 'result': {
      handlers.onResult(event);
      break;
    }
  }
}

// ── Main chat function ──

async function chat(slug, userMessage, sessionId) {
  const siteDir = path.join(STATIC_DIR, slug);

  if (!fs.existsSync(siteDir)) {
    fs.mkdirSync(siteDir, { recursive: true });
  }

  const systemPrompt = [
    `You are editing a static website hosted on Pipee.`,
    `The site slug is "${slug}". You are in the site's root directory.`,
    `Use Read, Write, Edit tools to modify files. Use Glob/LS to explore.`,
    `Guidelines:`,
    `- Read files before modifying them`,
    `- Produce clean, modern HTML/CSS/JS`,
    `- Preserve existing structure when making targeted changes`,
    `- If the site has no files, help create a basic website`,
    `- Explain what you changed after modifying files`,
    `- Keep responses concise`,
    `- Only modify files inside this directory`,
  ].join('\n');

  const args = [
    '-p', userMessage,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', 'sonnet',
    '--max-turns', '10',
    '--append-system-prompt', systemPrompt,
    '--dangerously-skip-permissions',
  ];

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(claudeCli.cmd, [...claudeCli.prefix, ...args], {
      cwd: siteDir,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let buffer = '';
    let accumulated = '';
    let resultReceived = false;
    const filesChanged = [];

    function trackFileChange(toolName, toolInput) {
      if (!toolInput) return;
      if (toolName === 'Write' || toolName === 'Edit') {
        const filePath = toolInput.file_path;
        if (filePath) {
          const rel = path.isAbsolute(filePath)
            ? path.relative(siteDir, filePath)
            : filePath;
          filesChanged.push({ action: 'write', path: rel });
        }
      }
    }

    function dedupeFiles() {
      const seen = new Map();
      for (const f of filesChanged) {
        seen.set(f.path, f);
      }
      return [...seen.values()];
    }

    function processLine(trimmed) {
      try {
        const event = JSON.parse(trimmed);
        handleStreamEvent(event, {
          onNewTurn: () => { accumulated = ''; },
          onTextDelta: (text) => { accumulated += text; },
          onToolUse: (name, input) => { trackFileChange(name, input); },
          onResult: (result) => {
            resultReceived = true;
            if (result.is_error) {
              reject(new Error(result.errors?.[0] || result.error || 'Claude error'));
            } else {
              resolve({
                reply: result.result || accumulated,
                sessionId: result.session_id,
                filesChanged: dedupeFiles(),
              });
            }
          },
        });
      } catch {
        // skip non-JSON lines
      }
    }

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) processLine(trimmed);
      }
    });

    proc.stderr.on('data', () => {
      // ignore stderr noise
    });

    proc.on('close', (code) => {
      // Process remaining buffer
      if (buffer.trim() && !resultReceived) {
        processLine(buffer.trim());
      }

      if (!resultReceived) {
        if (code !== 0 && code !== null) {
          reject(new Error(`Claude process exited with code ${code}`));
        } else {
          resolve({
            reply: accumulated || 'No response received.',
            sessionId: null,
            filesChanged: dedupeFiles(),
          });
        }
      }
    });

    proc.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error('Claude CLI not installed. Install: npm install -g @anthropic-ai/claude-code'));
      } else {
        reject(new Error(`Claude CLI failed: ${error.message}`));
      }
    });

    // Timeout
    setTimeout(() => {
      if (!resultReceived) {
        proc.kill('SIGTERM');
        reject(new Error('AI request timed out'));
      }
    }, TIMEOUT_MS);
  });
}

// ── File listing (for UI) ──

function listSiteFiles(slug) {
  const siteDir = path.join(STATIC_DIR, slug);
  if (!fs.existsSync(siteDir)) return [];

  const files = [];
  function walk(dir, prefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        const stat = fs.statSync(path.join(dir, entry.name));
        files.push({ path: rel, size: stat.size });
      }
    }
  }
  walk(siteDir, '');
  return files;
}

module.exports = { chat, listSiteFiles };
