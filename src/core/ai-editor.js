/**
 * AI Editor — Claude-powered static site editing
 *
 * Uses Anthropic Messages API with tool use to read/write site files.
 * Pro feature: users chat with Claude to modify their deployed sites.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { STATIC_DIR } = require('./static');

const MAX_FILE_SIZE = 256 * 1024; // 256 KB per file read
const MAX_CONVERSATION_MESSAGES = 40;

// Forbidden extensions — same as upload
const FORBIDDEN_EXTENSIONS = new Set([
  '.exe', '.dll', '.bat', '.ps1', '.cmd', '.com', '.scr', '.msi',
]);

// ── Tool definitions for Claude ──

const TOOLS = [
  {
    name: 'list_files',
    description: 'List all files in the website project. Returns file paths relative to the site root.',
    input_schema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Subdirectory to list (optional, defaults to root ".")',
        },
      },
      required: [],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file from the website project.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to site root (e.g. "index.html", "css/style.css")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file in the website project. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to site root (e.g. "index.html", "js/app.js")',
        },
        content: {
          type: 'string',
          description: 'The full file content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the website project.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to site root',
        },
      },
      required: ['path'],
    },
  },
];

// ── Tool execution ──

function resolveSafePath(siteDir, relativePath, { allowDir = false } = {}) {
  // Block empty, dot-only, or absolute paths
  if (!relativePath || relativePath === '.' || relativePath === '..' || path.isAbsolute(relativePath)) {
    if (allowDir && (relativePath === '.' || !relativePath)) {
      return path.resolve(siteDir);
    }
    return null;
  }

  const resolved = path.resolve(siteDir, relativePath);
  const normalizedSite = path.resolve(siteDir) + path.sep;

  // Must be strictly inside siteDir (not siteDir itself)
  if (!resolved.startsWith(normalizedSite)) {
    return null;
  }
  return resolved;
}

function executeTool(slug, toolName, toolInput) {
  const siteDir = path.join(STATIC_DIR, slug);

  if (!fs.existsSync(siteDir)) {
    return { error: 'Site directory does not exist. Deploy the site first.' };
  }

  switch (toolName) {
    case 'list_files': {
      const subdir = toolInput.directory || '.';
      const targetDir = resolveSafePath(siteDir, subdir, { allowDir: true });
      if (!targetDir) return { error: 'Invalid directory path' };
      if (!fs.existsSync(targetDir)) return { error: `Directory not found: ${subdir}` };

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
      walk(targetDir, subdir === '.' ? '' : subdir);
      return { files, total: files.length };
    }

    case 'read_file': {
      const filePath = resolveSafePath(siteDir, toolInput.path);
      if (!filePath) return { error: 'Invalid file path' };
      if (!fs.existsSync(filePath)) return { error: `File not found: ${toolInput.path}` };

      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        return { error: `File too large (${(stat.size / 1024).toFixed(1)} KB). Max: ${MAX_FILE_SIZE / 1024} KB.` };
      }

      const content = fs.readFileSync(filePath, 'utf8');
      return { path: toolInput.path, content, size: stat.size };
    }

    case 'write_file': {
      const ext = path.extname(toolInput.path).toLowerCase();
      if (FORBIDDEN_EXTENSIONS.has(ext)) {
        return { error: `Cannot write ${ext} files — forbidden extension` };
      }

      // Size guard: max 256 KB per file write
      if (toolInput.content && Buffer.byteLength(toolInput.content, 'utf8') > MAX_FILE_SIZE) {
        return { error: `Content too large. Max ${MAX_FILE_SIZE / 1024} KB per file.` };
      }

      const filePath = resolveSafePath(siteDir, toolInput.path);
      if (!filePath) return { error: 'Invalid file path' };

      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, toolInput.content, 'utf8');
      const stat = fs.statSync(filePath);
      return { path: toolInput.path, size: stat.size, written: true };
    }

    case 'delete_file': {
      const filePath = resolveSafePath(siteDir, toolInput.path);
      if (!filePath) return { error: 'Invalid file path' };
      if (!fs.existsSync(filePath)) return { error: `File not found: ${toolInput.path}` };

      fs.unlinkSync(filePath);
      return { path: toolInput.path, deleted: true };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Anthropic API call ──

function callAnthropic(apiKey, messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(parsed.error?.message || `API error ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch (err) {
          reject(new Error('Failed to parse API response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('API request timeout'));
    });

    req.write(body);
    req.end();
  });
}

// ── Main chat function ──

async function chat(slug, userMessage, conversationHistory, apiKey) {
  const siteDir = path.join(STATIC_DIR, slug);

  const systemPrompt = `You are an expert web developer AI assistant. You are editing a static website hosted on Pipee.

The user's site slug is "${slug}". The site files are served as a static website.

You have tools to list, read, write, and delete files in the project. Use them to understand and modify the site.

Guidelines:
- Always read files before modifying them to understand the current state
- When the user asks for changes, make them directly using write_file
- Produce clean, modern HTML/CSS/JS code
- Preserve existing code structure when making targeted changes
- If the site has no files yet, help the user create a basic website
- Explain what changes you made after modifying files
- Keep responses concise and focused on the task

The site directory currently ${fs.existsSync(siteDir) ? 'exists' : 'does not exist (needs first deploy)'}.`;

  // Build messages array
  const messages = [
    ...(conversationHistory || []).slice(-MAX_CONVERSATION_MESSAGES),
    { role: 'user', content: userMessage },
  ];

  // Agentic tool-use loop (max 10 iterations)
  let currentMessages = [...messages];
  const filesChanged = [];

  for (let i = 0; i < 10; i++) {
    const response = await callAnthropic(apiKey, currentMessages, systemPrompt);

    // Collect text blocks from assistant response
    const assistantContent = response.content || [];

    // Check if there are tool_use blocks
    const toolUses = assistantContent.filter((b) => b.type === 'tool_use');

    if (toolUses.length === 0) {
      // No tools called — final response
      const textParts = assistantContent
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

      // Return the full conversation history for session persistence
      const updatedHistory = [
        ...currentMessages,
        { role: 'assistant', content: assistantContent },
      ];

      return {
        reply: textParts,
        filesChanged,
        conversationHistory: updatedHistory,
        stopReason: response.stop_reason,
      };
    }

    // Execute tools and build tool_result messages
    currentMessages.push({ role: 'assistant', content: assistantContent });

    const toolResults = toolUses.map((tu) => {
      const result = executeTool(slug, tu.name, tu.input);

      if (tu.name === 'write_file' && result.written) {
        filesChanged.push({ action: 'write', path: tu.input.path });
      } else if (tu.name === 'delete_file' && result.deleted) {
        filesChanged.push({ action: 'delete', path: tu.input.path });
      }

      return {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      };
    });

    currentMessages.push({ role: 'user', content: toolResults });
  }

  // Safety: if we hit max iterations
  const lastText = 'I made several changes but reached the maximum number of tool calls. Please check the results and let me know if you need more changes.';
  return {
    reply: lastText,
    filesChanged,
    conversationHistory: currentMessages,
    stopReason: 'max_iterations',
  };
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
