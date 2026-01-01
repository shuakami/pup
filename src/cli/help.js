'use strict';

const {
  cyan, yellow, magenta, gray,
  bold, dim,
} = require('../utils/colors');

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s) {
  return String(s || '').replace(ANSI_RE, '');
}

function vlen(s) {
  return stripAnsi(s).length;
}

function padRight(s, width) {
  const txt = String(s || '');
  const pad = Math.max(0, width - vlen(txt));
  return txt + ' '.repeat(pad);
}

function wrap(text, width, indent) {
  const w = Math.max(20, Number(width) || 80);
  const ind = ' '.repeat(Math.max(0, Number(indent) || 0));
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const word of words) {
    if (!line) { line = word; continue; }
    if ((line.length + 1 + word.length) > (w - ind.length)) {
      out.push(ind + line);
      line = word;
    } else {
      line += ' ' + word;
    }
  }
  if (line) out.push(ind + line);
  return out.join('\n');
}

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

// Curated beginner-friendly notes for a few high-traffic commands.
// Everything else is auto-generated from kernel.registerCommand() specs.
const GUIDES = {
  goto: {
    args: [
      { name: 'url', required: true, desc: 'Target URL. Include https:// when possible.' }
    ],
    notes: [
      'If navigation times out, the page may still be partially loaded. You will see timedOut=true.'
    ],
    examples: [
      'pup goto https://www.google.com',
      'pup goto https://example.com --scan'
    ]
  },
  scan: {
    notes: [
      'Scan is Accessibility-first (AXTree). It returns element ids that you can click/type.',
      'Use --filter to narrow down results, e.g. --filter input or --filter "sign in".',
      'Use --deep when list items have too little text (slower but richer).'
    ],
    examples: [
      'pup scan',
      'pup scan --filter input',
      'pup scan --filter "search" --no-empty'
    ]
  },
  clicktext: {
    notes: [
      'clicktext finds an element by text (auto-scroll if needed) and clicks the best match.',
      'Prefer this when ids change often, or before doing a full scan.'
    ],
    examples: [
      'pup clicktext "Sign in"',
      'pup clicktext "Buy now" --smooth'
    ]
  },
  download: {
    sub: {
      links: {
        summary: 'List downloadable links discovered on the current page.',
        examples: ['pup download links', 'pup download click 3']
      },
      click: {
        summary: 'Click a download link by index (from `download links`).',
        examples: ['pup download click 3']
      }
    }
  },
  network: {
    notes: [
      'Use --capture to start capturing requests before you reproduce an action (click/type).'
    ],
    examples: [
      'pup network',
      'pup network --capture'
    ]
  }
};

function _cmdList(kernel) {
  try { return kernel.listCommands(); } catch { return []; }
}

function _cmdInfo(kernel, name) {
  if (kernel && typeof kernel.getCommandInfo === 'function') return kernel.getCommandInfo(name);
  const n = norm(name);
  for (const c of _cmdList(kernel)) {
    if (norm(c.name) === n) return { name: n, plugin: c.plugin, spec: c };
  }
  return null;
}

function _pluginMetas(plugins) {
  if (plugins && typeof plugins.listPluginMetas === 'function') return plugins.listPluginMetas();
  try {
    const loaded = plugins && plugins._loaded ? Array.from(plugins._loaded.values()) : [];
    return loaded.map((r) => r.meta).filter(Boolean);
  } catch {
    return [];
  }
}

function _buildGlobal({ kernel, plugins, binName }) {
  const lines = [];

  lines.push(`${bold('Usage:')} ${cyan(`${binName} <command> [args...] [options]`)}`);
  lines.push('');
  lines.push(bold('Quick Start (beginner):'));
  lines.push(`  ${gray('1)')} ${cyan(`${binName} goto https://www.google.com`)}`);
  lines.push(`  ${gray('2)')} ${cyan(`${binName} scan`)} ${dim('# list elements and ids')}`);
  lines.push(`  ${gray('3)')} ${cyan(`${binName} click <id>`)} ${dim('# click an element by id')}`);
  lines.push(`  ${gray('4)')} ${cyan(`${binName} type <id> "hello" --enter`)} ${dim('# type and press Enter')}`);
  lines.push('');
  lines.push(bold('Help:'));
  lines.push(`  ${cyan(`${binName} help`)} ${dim('# show all commands')}`);
  lines.push(`  ${cyan(`${binName} help <command>`)} ${dim('# detailed command help')}`);
  lines.push(`  ${cyan(`${binName} <command> --help`)} ${dim('# same as help <command>')}`);
  lines.push('');
  lines.push(bold('Output Options:'));
  lines.push(`  ${cyan('--json, -j')}    ${gray('output JSONL (one JSON per line)')}`);
  lines.push(`  ${cyan('--pretty')}     ${gray('pretty-printed JSON')}`);
  lines.push('');

  // REPL note
  lines.push(bold('REPL Mode (JSON lines):'));
  lines.push(`  ${gray('Run without a command to read JSON from stdin.')}`);
  lines.push(`  ${dim('Example:')} ${cyan(`echo '{"cmd":"GOTO","url":"https://example.com"}' | ${binName} -j`)}`);
  lines.push('');

  // Commands grouped by plugin
  const commands = _cmdList(kernel);
  const byPlugin = new Map();
  for (const c of commands) {
    const p = String(c.plugin || 'unknown');
    if (!byPlugin.has(p)) byPlugin.set(p, []);
    byPlugin.get(p).push(c);
  }

  const metas = _pluginMetas(plugins);
  const metaByName = new Map(metas.map((m) => [String(m.name), m]));
  const pluginNames = Array.from(byPlugin.keys()).sort((a, b) => a.localeCompare(b));

  lines.push(bold('Commands:'));
  for (const pname of pluginNames) {
    const meta = metaByName.get(pname);
    const pdesc = meta && meta.description ? String(meta.description) : '';
    lines.push('');
    lines.push(`  ${magenta('[' + pname + ']')} ${gray(pdesc)}`.trimEnd());

    const list = (byPlugin.get(pname) || []).slice(0).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const leftWidth = 34;

    for (const cmd of list) {
      const usage = cmd.usage ? String(cmd.usage) : String(cmd.name);
      const desc = cmd.description ? String(cmd.description) : '';
      lines.push(`    ${padRight(cyan(usage), leftWidth)} ${gray(desc)}`.trimEnd());
    }
  }

  lines.push('');
  lines.push(`${dim('Tip:')} ${gray(`Use "${binName} help <command>" to see options & examples.`)}`);

  return lines.join('\n');
}

function _inferArgsFromUsage(usage) {
  const u = String(usage || '');
  const args = [];
  const re = /<([^>]+)>/g;
  let m;
  while ((m = re.exec(u))) {
    const raw = m[1].trim();
    if (!raw) continue;
    args.push({ name: raw, required: true });
  }
  return args;
}

function _buildCommand({ kernel, plugins, binName, cmdName, subName }) {
  const info = _cmdInfo(kernel, cmdName);
  if (!info) {
    const lines = [];
    lines.push(`${yellow('[!]')} ${yellow('Unknown command:')} ${cyan(cmdName)}`);
    lines.push('');
    lines.push(_buildGlobal({ kernel, plugins, binName }));
    return lines.join('\n');
  }

  const spec = info.spec || {};
  const usage = spec.usage ? String(spec.usage) : String(info.name);
  const desc = spec.description ? String(spec.description) : '';
  const opts = Array.isArray(spec.cliOptions) ? spec.cliOptions : [];

  const guide = GUIDES[info.name] || null;

  // Subcommand help (curated only)
  if (subName && guide && guide.sub && guide.sub[subName]) {
    const sub = guide.sub[subName];
    const lines = [];
    lines.push(`${bold('Command:')} ${cyan(info.name)} ${gray(`(plugin: ${info.plugin})`)}`);
    lines.push(`${bold('Subcommand:')} ${cyan(subName)}`);
    lines.push('');
    lines.push(bold('Usage:'));
    lines.push(`  ${cyan(`${binName} ${info.name} ${subName}`)}`);
    lines.push('');
    if (sub.summary) {
      lines.push(bold('What it does:'));
      lines.push(wrap(sub.summary, 88, 2));
      lines.push('');
    }
    if (sub.examples && sub.examples.length) {
      lines.push(bold('Examples:'));
      for (const ex of sub.examples) lines.push(`  ${cyan(ex)}`);
      lines.push('');
    }
    lines.push(`${dim('See also:')} ${gray(`${binName} help ${info.name}`)}`);
    return lines.join('\n');
  }

  const inferredArgs = _inferArgsFromUsage(usage);
  const argDocs = guide && Array.isArray(guide.args) ? guide.args : [];

  const lines = [];
  lines.push(`${bold('Command:')} ${cyan(info.name)} ${gray(`(plugin: ${info.plugin})`)}`);
  lines.push('');
  lines.push(bold('Usage:'));
  lines.push(`  ${cyan(`${binName} ${usage}`)}`);
  lines.push('');

  if (desc) {
    lines.push(bold('Description:'));
    lines.push(wrap(desc, 88, 2));
    lines.push('');
  }

  if (inferredArgs.length) {
    lines.push(bold('Arguments:'));
    for (const a of inferredArgs) {
      const doc = argDocs.find((d) => norm(d.name) === norm(a.name)) || null;
      const right = doc && doc.desc ? doc.desc : 'Required argument.';
      lines.push(`  ${padRight(cyan('<' + a.name + '>'), 20)} ${gray(right)}`.trimEnd());
    }
    lines.push('');
  }

  if (opts.length) {
    lines.push(bold('Options:'));
    for (const o of opts) {
      const flags = o && o.flags ? String(o.flags) : '';
      const od = o && o.description ? String(o.description) : '';
      lines.push(`  ${padRight(cyan(flags), 20)} ${gray(od)}`.trimEnd());
    }
    lines.push('');
  }

  lines.push(bold('Output options (global):'));
  lines.push(`  ${padRight(cyan('--json, -j'), 20)} ${gray('JSONL output (one JSON per line)')}`);
  lines.push(`  ${padRight(cyan('--pretty'), 20)} ${gray('Pretty-printed JSON')}`);
  lines.push('');

  if (guide && Array.isArray(guide.notes) && guide.notes.length) {
    lines.push(bold('Beginner notes:'));
    for (const n of guide.notes) lines.push(`  ${yellow('•')} ${gray(n)}`);
    lines.push('');
  }
  if (guide && Array.isArray(guide.examples) && guide.examples.length) {
    lines.push(bold('Examples:'));
    for (const ex of guide.examples) lines.push(`  ${cyan(ex)}`);
    lines.push('');
  }

  if (guide && guide.sub) {
    const subs = Object.keys(guide.sub).sort();
    if (subs.length) {
      lines.push(bold('Subcommands:'));
      for (const s of subs) {
        lines.push(`  ${cyan(`${binName} help ${info.name} ${s}`)}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function _buildPlugin({ kernel, plugins, binName, pluginName }) {
  const name = String(pluginName || '');
  const metas = _pluginMetas(plugins);
  const meta = metas.find((m) => String(m.name) === name) || null;

  const commands = _cmdList(kernel).filter((c) => String(c.plugin) === name);
  commands.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const lines = [];
  lines.push(`${bold('Plugin:')} ${magenta(name)}`);
  if (meta && meta.description) {
    lines.push('');
    lines.push(bold('Description:'));
    lines.push(wrap(String(meta.description), 88, 2));
  }
  lines.push('');
  lines.push(bold('Commands:'));
  for (const cmd of commands) {
    const usage = cmd.usage ? String(cmd.usage) : String(cmd.name);
    const desc = cmd.description ? String(cmd.description) : '';
    lines.push(`  ${padRight(cyan(usage), 34)} ${gray(desc)}`.trimEnd());
  }
  lines.push('');
  lines.push(`${dim('Tip:')} ${gray(`Use "${binName} help <command>" for per-command help.`)}`);
  return lines.join('\n');
}

function buildHelpText({ kernel, plugins, binName, topicTokens }) {
  const tokens = Array.isArray(topicTokens) ? topicTokens : [];
  if (!tokens.length) return _buildGlobal({ kernel, plugins, binName });

  const first = norm(tokens[0]);
  const second = tokens[1] ? norm(tokens[1]) : '';

  if (_cmdInfo(kernel, first)) {
    return _buildCommand({ kernel, plugins, binName, cmdName: first, subName: second || '' });
  }

  const metas = _pluginMetas(plugins);
  if (metas.some((m) => norm(m.name) === first)) {
    return _buildPlugin({ kernel, plugins, binName, pluginName: first });
  }

  const lines = [];
  lines.push(`${yellow('[!]')} ${yellow('Unknown help topic:')} ${cyan(tokens.join(' '))}`);
  lines.push('');
  lines.push(_buildGlobal({ kernel, plugins, binName }));
  return lines.join('\n');
}

module.exports = {
  buildHelpText
};
