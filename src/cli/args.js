'use strict';

function _isFlag(token) {
  const t = String(token || '');
  return t.startsWith('-');
}

function _firstNonFlagIndex(argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i]) continue;
    if (_isFlag(args[i])) continue;
    return i;
  }
  return -1;
}

/**
 * Parse CLI arguments into a stable shape.
 *
 * Modes:
 * - help: `pup help ...` OR `pup [cmd] --help`
 * - command: `pup <cmd> ...`
 * - repl: `pup` (no command) => read JSON lines from stdin
 */
function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(0) : [];

  const hasHelpFlag = args.includes('-h') || args.includes('--help');
  const idx = _firstNonFlagIndex(args);

  const cmdRaw = idx >= 0 ? String(args[idx] || '') : '';
  const cmd = cmdRaw.trim().toLowerCase();
  const rest = idx >= 0 ? args.slice(idx + 1) : [];

  // `help` command explicitly
  if (cmd === 'help') {
    const topicTokens = rest.filter((t) => t && !String(t).startsWith('-'));
    return { mode: 'help', helpTopicTokens: topicTokens };
  }

  // `--help` works both globally and per-command
  if (hasHelpFlag) {
    // if a command exists, treat it as `help <cmd> ...`
    if (idx >= 0 && cmd) {
      const topicTokens = [cmd, ...rest.filter((t) => t && !String(t).startsWith('-'))];
      return { mode: 'help', helpTopicTokens: topicTokens };
    }
    return { mode: 'help', helpTopicTokens: [] };
  }

  // command mode
  if (idx >= 0 && cmd) {
    return { mode: 'command', command: cmd, argv: rest };
  }

  // repl mode
  return { mode: 'repl' };
}

module.exports = {
  parseCliArgs
};
