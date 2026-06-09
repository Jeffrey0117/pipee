#!/usr/bin/env node
const output = require('../src/output');

const COMMANDS = {
  login: () => require('../src/commands/login'),
  logout: () => require('../src/commands/logout'),
  whoami: () => require('../src/commands/whoami'),
  deploy: () => require('../src/commands/deploy'),
  sites: () => require('../src/commands/sites'),
  data: () => require('../src/commands/data'),
};

// Flags that take a value; everything else with -- is boolean.
const VALUE_FLAGS = new Set(['token', 'site', 'api']);

function parseArgs(rest) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (VALUE_FLAGS.has(key)) {
        flags[key] = rest[++i];
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function help() {
  output.info('Pipee CLI — deploy static sites to pipee.tw (with a built-in Data API backend)');
  output.info('');
  output.info('Usage: pipee <command> [options]');
  output.info('');
  output.info('  login [--token <t>]        Log in with your deploy token (from pipee.tw/console)');
  output.info('  deploy [dir] [--site <s>]  Deploy a folder (default: current dir; slug remembered in pipee.json)');
  output.info('  sites                      List your sites');
  output.info('  data <slug> [--enable]     Show (or provision) the site\'s Data API key');
  output.info('  whoami                     Show current login');
  output.info('  logout                     Clear stored credentials');
  output.info('');
  output.info('  --json on any command prints machine-readable output (for AI agents/scripts).');
  output.info('  Env: PIPEE_TOKEN (deploy token), PIPEE_API (API base, default https://pipee.tw)');
  output.info('');
  output.info('Docs: https://pipee.tw/ai');
}

async function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    help();
    return 0;
  }
  if (command === '--version' || command === '-v') {
    output.info(require('../package.json').version);
    return 0;
  }

  const loader = COMMANDS[command];
  if (!loader) {
    output.error(`Unknown command: ${command}`);
    help();
    return 1;
  }

  const { flags, pos } = parseArgs(rest);
  return loader()(pos, flags);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    output.error(err.message || String(err));
    process.exit(1);
  });
