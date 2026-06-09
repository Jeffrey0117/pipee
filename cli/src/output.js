/**
 * Unified CLI output. All user-facing text goes through here so the
 * rest of the code never calls console.log directly. `json()` prints
 * machine-readable output for AI agents / scripts (--json flag).
 */
function info(msg) {
  process.stdout.write(`${msg}\n`);
}

function success(msg) {
  process.stdout.write(`✓ ${msg}\n`);
}

function error(msg) {
  process.stderr.write(`✗ ${msg}\n`);
}

function json(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

module.exports = { info, success, error, json };
