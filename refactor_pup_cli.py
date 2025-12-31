#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""/src JS refactor + help/UX + perf patches.

Run from repository root:

    python3 refactor_pup_cli.py

What it does (high level):
- Extracts the big `formatText()` function from `src/index.js` into `src/cli/format-text.js`
  (so `src/index.js` becomes small and maintainable).
- Adds a modular CLI layer under `src/cli/` (args/writer/help/repl/banner/serialize).
- Makes `help` dynamic and supports:
    - pup help
    - pup help <command>
    - pup help <command> <subcommand>
    - pup <command> --help
- Applies safe performance optimizations (timeouts/design preserved):
  - Avoid allocating a Set on every CDPClient.enable() call (kernel.js).
  - Scanner: concurrent BoxModel fetch + concurrent DOM enhancement (core-scanner.js).
  - Navigation: faster blank-page detection loop (core-navigation.js).
- Adds lightweight introspection helpers for dynamic help:
  - Kernel.getCommandInfo()
  - PluginManager.listPluginMetas(), PluginManager.getPluginMeta()

This script is conservative:
- It does NOT change any existing timeout values.
- It uses marker-based patches; if expected markers are missing, it fails loudly.

"""
from __future__ import annotations

import argparse
import datetime as _dt
import re
import shutil
import sys
from pathlib import Path
from textwrap import dedent
from typing import Optional, Tuple


REPO_ROOT = Path.cwd()


def _read_text(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def _write_text(p: Path, s: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    if not s.endswith("\n"):
        s += "\n"
    p.write_text(s, encoding="utf-8")


def _backup_file(p: Path, enabled: bool) -> Optional[Path]:
    if not enabled or not p.exists():
        return None
    ts = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    bak = p.with_suffix(p.suffix + f".bak.{ts}")
    shutil.copy2(p, bak)
    return bak


class PatchError(RuntimeError):
    pass


def _replace_once(content: str, old: str, new: str, *, already_ok_substring: Optional[str] = None) -> Tuple[str, bool]:
    """Replace `old` with `new` exactly once."""
    if already_ok_substring and already_ok_substring in content:
        return content, False
    if old not in content:
        raise PatchError("Expected patch target not found.")
    return content.replace(old, new, 1), True


def _insert_after(content: str, anchor: str, insert: str, *, already_ok_substring: Optional[str] = None) -> Tuple[str, bool]:
    """Insert `insert` right after first occurrence of `anchor`."""
    if already_ok_substring and already_ok_substring in content:
        return content, False
    idx = content.find(anchor)
    if idx < 0:
        raise PatchError("Expected anchor not found for insertion.")
    idx_end = idx + len(anchor)
    return content[:idx_end] + insert + content[idx_end:], True


def _insert_before(content: str, marker: str, insert: str, *, already_ok_substring: Optional[str] = None) -> Tuple[str, bool]:
    """Insert `insert` right before first occurrence of `marker`."""
    if already_ok_substring and already_ok_substring in content:
        return content, False
    idx = content.find(marker)
    if idx < 0:
        raise PatchError("Expected marker not found for insertion.")
    return content[:idx] + insert + content[idx:], True


def _replace_between(content: str, start_marker: str, end_marker: str, replacement: str, *, already_ok_substring: Optional[str] = None) -> Tuple[str, bool]:
    """Replace content from start_marker (inclusive) to end_marker (exclusive)."""
    if already_ok_substring and already_ok_substring in content:
        return content, False
    start = content.find(start_marker)
    if start < 0:
        raise PatchError("Start marker not found.")
    end = content.find(end_marker, start)
    if end < 0:
        raise PatchError("End marker not found.")
    return content[:start] + replacement + content[end:], True


def _extract_format_text_function(index_js: str) -> str:
    """Extract the `function formatText(res, startTime) { ... }` block."""
    start = index_js.find("function formatText")
    if start < 0:
        raise PatchError("Could not find 'function formatText' in src/index.js (already refactored?)")

    marker_candidates = [
        "return lines.join('\\n');",
        "return lines.join(\"\\n\");",
    ]
    ret = -1
    for m in marker_candidates:
        ret = index_js.find(m, start)
        if ret >= 0:
            break
    if ret < 0:
        raise PatchError("Could not find 'return lines.join(\\n)' marker inside formatText().")

    end = index_js.find("\n}\n", ret)
    if end < 0:
        end = index_js.find("\r\n}\r\n", ret)
        if end < 0:
            raise PatchError("Could not find the closing brace of formatText().")
        return index_js[start : end + 4]

    return index_js[start : end + 3]


def _write_cli_modules(repo: Path, *, format_text_code: str, overwrite_format_text: bool) -> None:
    """Create new JS modules under src/cli and src/utils."""

    # src/cli/format-text.js
    fmt_path = repo / "src" / "cli" / "format-text.js"
    if not fmt_path.exists() or overwrite_format_text:
        fmt_module = dedent(
            f"""
            'use strict';

            const {{
              cyan, green, yellow, red, magenta, blue, gray, white,
              brightCyan, bold, dim,
              formatDuration
            }} = require('../utils/colors');

            {format_text_code.strip()}

            module.exports = {{
              formatText
            }};
            """
        ).lstrip()
        _write_text(fmt_path, fmt_module)

    # src/cli/writer.js
    writer_js = dedent(
        r"""
        'use strict';

        const { formatText } = require('./format-text');

        /**
         * Output policy:
         * - --json / -j: compact JSONL (for programmatic use)
         * - --pretty: JSON pretty printed
         * - default: colorful text format (Vite/Vitest style)
         */
        function makeWriter(argv) {
          const args = Array.isArray(argv) ? argv : [];
          const JSON_LINE = args.includes('--json') || args.includes('-j');
          const PRETTY_JSON = args.includes('--pretty');

          return (obj, startTime) => {
            if (JSON_LINE) {
              process.stdout.write(`${JSON.stringify(obj)}\n`);
            } else if (PRETTY_JSON) {
              process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
            } else {
              process.stdout.write(`${formatText(obj, startTime)}\n`);
            }
          };
        }

        module.exports = { makeWriter };
        """
    ).lstrip()
    _write_text(repo / "src" / "cli" / "writer.js", writer_js)

    # src/cli/serialize.js
    serialize_js = dedent(
        r"""
        'use strict';

        function serializeError(err) {
          const message = (err && err.message) ? String(err.message) : String(err || 'Unknown error');
          const name = (err && err.name) ? String(err.name) : 'Error';
          const code = (err && err.code) ? String(err.code) : undefined;
          const out = { name, message };
          if (code) out.code = code;
          return out;
        }

        function pickCorrelation(req) {
          const keys = ['rpcId', 'reqId', 'requestId', 'corrId', 'correlationId', 'seq'];
          for (const k of keys) {
            if (req && Object.prototype.hasOwnProperty.call(req, k)) return req[k];
          }
          return null;
        }

        module.exports = {
          serializeError,
          pickCorrelation
        };
        """
    ).lstrip()
    _write_text(repo / "src" / "cli" / "serialize.js", serialize_js)

    # src/cli/args.js
    args_js = dedent(
        r"""
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
        """
    ).lstrip()
    _write_text(repo / "src" / "cli" / "args.js", args_js)

    # src/cli/banner.js
    banner_js = dedent(
        r"""
        'use strict';

        const path = require('path');
        const { brightCyan, bold, gray } = require('../utils/colors');

        function getVersion() {
          // Best effort: resolve package.json relative to src/
          try {
            const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
            if (pkg && pkg.version) return String(pkg.version);
          } catch {}
          return '0.0.0';
        }

        // Banner (minimal, Vite-style)
        function printBanner() {
          const version = getVersion();
          console.log('');
          console.log(`  ${bold(brightCyan('◆'))} ${bold('Pup')} ${gray('v' + version)}`);
          console.log('');
        }

        module.exports = {
          printBanner,
          getVersion
        };
        """
    ).lstrip()
    _write_text(repo / "src" / "cli" / "banner.js", banner_js)

    # src/cli/repl.js
    repl_js = dedent(
        r"""
        'use strict';

        const readline = require('readline');
        const { pickCorrelation, serializeError } = require('./serialize');

        /**
         * REPL mode: read JSON lines from stdin.
         *
         * Protocols supported:
         * - Legacy: { cmd: "GOTO", url: "..." }, { cmd: "SCAN" }, ...
         * - Direct passthrough: { cmd: "click", argv: ["5"] }
         */
        async function runRepl({ kernel, plugins, writeLine }) {
          const rl = readline.createInterface({
            input: process.stdin,
            crlfDelay: Infinity
          });

          let chain = Promise.resolve();

          rl.on('line', (line) => {
            const trimmed = String(line || '').trim();
            if (!trimmed) return;

            chain = chain.then(async () => {
              let req;
              try {
                req = JSON.parse(trimmed);
              } catch {
                writeLine({ ok: false, error: { name: 'ParseError', message: 'Invalid JSON line' } });
                return;
              }

              const corr = pickCorrelation(req);
              const startTime = Date.now();

              try {
                const cmdRaw = (req && req.cmd) ? String(req.cmd) : '';
                const cmd = cmdRaw.trim().toUpperCase();

                let res;

                // Legacy REPL protocol mapping.
                if (cmd === 'PING') {
                  res = await kernel.runCommand('ping', { argv: [] });
                } else if (cmd === 'STATUS') {
                  res = await kernel.runCommand('status', { argv: [] });
                } else if (cmd === 'GOTO') {
                  res = await kernel.runCommand('goto', { argv: [String(req.url || '')] });
                } else if (cmd === 'SCAN') {
                  res = await kernel.runCommand('scan', { argv: [] });
                } else if (cmd === 'SCANALL') {
                  res = await kernel.runCommand('scanall', { argv: [] });
                } else if (cmd === 'SCROLL') {
                  res = await kernel.runCommand('scroll', { argv: [String(req.direction || 'down')] });
                } else if (cmd === 'ACT') {
                  res = await kernel.runCommand('act', req);
                } else {
                  // Direct command passthrough: { cmd: "click", argv: ["5"] }
                  if (req && req.cmd && Array.isArray(req.argv)) {
                    res = await kernel.runCommand(String(req.cmd).toLowerCase(), { argv: req.argv });
                  } else {
                    throw new Error(`Unknown cmd: ${cmd}`);
                  }
                }

                if (corr !== null && corr !== undefined && res && typeof res === 'object') res.corr = corr;
                writeLine(res, startTime);
              } catch (e) {
                const out = { ok: false, error: serializeError(e) };
                if (corr !== null && corr !== undefined) out.corr = corr;
                writeLine(out, startTime);
              }
            }).catch((e) => {
              writeLine({ ok: false, error: serializeError(e) });
            });
          });

          rl.on('close', async () => {
            await plugins.unloadAll().catch(() => {});
            await kernel.shutdown().catch(() => {});
            process.exit(0);
          });
        }

        module.exports = {
          runRepl
        };
        """
    ).lstrip()
    _write_text(repo / "src" / "cli" / "repl.js", repl_js)

    # src/cli/help.js (dynamic, per-command and subcommand)
    help_js = dedent(
        r"""
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
        """
    ).lstrip()
    _write_text(repo / "src" / "cli" / "help.js", help_js)

    # src/utils/promise-pool.js
    promise_pool_js = dedent(
        r"""
        'use strict';

        /**
         * Small, dependency-free promise pool.
         *
         * - Preserves input order.
         * - Concurrency-limited.
         * - Optional "stopOnError" to fail fast.
         *
         * @template T,R
         * @param {T[]} items
         * @param {(item:T, index:number)=>Promise<R>} worker
         * @param {{concurrency?:number, stopOnError?:boolean}} [opts]
         * @returns {Promise<R[]>}
         */
        async function pMap(items, worker, opts = {}) {
          const list = Array.isArray(items) ? items : [];
          const concurrency = Math.max(1, Number(opts.concurrency || 4));
          const stopOnError = opts.stopOnError !== false;

          const results = new Array(list.length);
          let nextIndex = 0;
          let failed = false;
          let firstError = null;

          async function runOne() {
            while (true) {
              if (failed && stopOnError) return;
              const i = nextIndex++;
              if (i >= list.length) return;

              try {
                results[i] = await worker(list[i], i);
              } catch (e) {
                if (!firstError) firstError = e;
                failed = true;
                if (stopOnError) return;
                results[i] = null;
              }
            }
          }

          const workers = [];
          for (let i = 0; i < Math.min(concurrency, list.length); i++) {
            workers.push(runOne());
          }
          await Promise.all(workers);

          if (failed && stopOnError) throw firstError;
          return results;
        }

        module.exports = {
          pMap
        };
        """
    ).lstrip()
    _write_text(repo / "src" / "utils" / "promise-pool.js", promise_pool_js)


def _write_new_index_js(repo: Path) -> None:
    index_js = dedent(
        r"""
        #!/usr/bin/env node
        'use strict';

        const path = require('path');

        const config = require('./config');
        const { Kernel } = require('./core/kernel');
        const { PluginManager } = require('./core/plugin-manager');

        const { red } = require('./utils/colors');

        const { parseCliArgs } = require('./cli/args');
        const { makeWriter } = require('./cli/writer');
        const { printBanner } = require('./cli/banner');
        const { buildHelpText } = require('./cli/help');
        const { runRepl } = require('./cli/repl');
        const { serializeError } = require('./cli/serialize');

        async function boot(pluginsDir) {
          const kernel = new Kernel(config);
          const plugins = new PluginManager(kernel, pluginsDir);

          let loadError = null;
          try {
            await plugins.loadAll();
          } catch (e) {
            loadError = e;
          }

          if (loadError) {
            console.error(`${red('[-]')} ${red('Failed to load plugins:')} ${loadError.message}`);
            await plugins.unloadAll().catch(() => {});
            await kernel.shutdown().catch(() => {});
            process.exit(1);
          }

          // Enable hot reload in long-running mode (REPL/dev).
          kernel.enableHotReload(plugins, pluginsDir);

          return { kernel, plugins };
        }

        async function main() {
          const rawArgs = process.argv.slice(2);
          const binName = path.basename(process.argv[1] || 'pup');
          const pluginsDir = path.join(__dirname, 'plugins');

          const parsed = parseCliArgs(rawArgs);
          const writeLine = makeWriter(rawArgs);

          const { kernel, plugins } = await boot(pluginsDir);

          // Help (dynamic)
          if (parsed.mode === 'help') {
            printBanner();
            process.stdout.write(buildHelpText({ kernel, plugins, binName, topicTokens: parsed.helpTopicTokens }));
            process.stdout.write('\n');
            await plugins.unloadAll().catch(() => {});
            await kernel.shutdown().catch(() => {});
            process.exit(0);
          }

          // CLI command mode
          if (parsed.mode === 'command') {
            const cmd = String(parsed.command || '').trim().toLowerCase();
            const argv = Array.isArray(parsed.argv) ? parsed.argv : [];
            const startTime = Date.now();

            try {
              const res = await kernel.runCommand(cmd, { argv });
              writeLine(res, startTime);
              await plugins.unloadAll().catch(() => {});
              await kernel.shutdown().catch(() => {});
              process.exit(0);
            } catch (e) {
              writeLine({ ok: false, error: serializeError(e) }, startTime);
              await plugins.unloadAll().catch(() => {});
              await kernel.shutdown().catch(() => {});
              process.exit(1);
            }
          }

          // REPL mode
          await runRepl({ kernel, plugins, writeLine });
        }

        main().catch((e) => {
          const message = (e && e.message) ? String(e.message) : String(e || 'Unknown error');
          process.stderr.write(`✗ ${message}\n`);
          process.exit(1);
        });
        """
    ).lstrip()
    _write_text(repo / "src" / "index.js", index_js)


def _patch_kernel_js(repo: Path) -> bool:
    p = repo / "src" / "core" / "kernel.js"
    content = _read_text(p)
    changed_any = False

    # 1) Insert shared NEEDS_ENABLE_DOMAINS to avoid per-call Set allocation.
    if "const NEEDS_ENABLE_DOMAINS" not in content:
        # robust anchor: insert after the errors require line (without assuming line endings)
        anchor_line = "const { isRetryableError } = require('../utils/errors');"
        idx = content.find(anchor_line)
        if idx < 0:
            raise PatchError("kernel.js: cannot find isRetryableError require line for insertion.")
        # insert after the end-of-line
        eol = content.find("\n", idx)
        if eol < 0:
            raise PatchError("kernel.js: cannot locate EOL after isRetryableError require.")
        insert = "\n\n// Shared allowlist to avoid allocating a Set on every CDPClient.enable() call.\n" \
                 "const NEEDS_ENABLE_DOMAINS = new Set(['Page', 'DOM', 'Runtime', 'Accessibility', 'Network', 'Log', 'Overlay', 'Emulation']);\n"
        content = content[: eol + 1] + insert + content[eol + 1 :]
        changed_any = True

    # 2) Replace inline Set in CDPClient.enable with shared constant.
    if "needsEnable = new Set" in content:
        pattern = re.compile(
            r"""
            (\s*)//\s*some\s*domains\s*do\s*not\s*require\s*enable;\s*keep\s*allowlist\s*
            \n\s*const\s+needsEnable\s*=\s*new\s+Set\(\[[^\]]*\]\);\s*
            \n\s*if\s*\(!needsEnable\.has\(d\)\)\s*\{\s*
            \n\s*this\._enabled\.add\(d\);\s*
            \n\s*return;\s*
            \n\s*\}\s*
            """,
            re.VERBOSE,
        )

        def _repl(m: re.Match) -> str:
            ind = m.group(1) or "    "
            return (
                f"{ind}// some domains do not require enable; keep allowlist (shared)\n"
                f"{ind}if (!NEEDS_ENABLE_DOMAINS.has(d)) {{\n"
                f"{ind}  this._enabled.add(d);\n"
                f"{ind}  return;\n"
                f"{ind}}}\n"
            )

        new_content, n = pattern.subn(_repl, content, count=1)
        if n == 0:
            raise PatchError("kernel.js: failed to patch CDPClient.enable() allowlist block.")
        content = new_content
        changed_any = True

    # 3) Add Kernel.getCommandInfo() for dynamic help/introspection (insert before runCommand).
    if "getCommandInfo(name)" not in content:
        marker = "  async runCommand(name, ctx = {}) {"
        insert_method = dedent(
            """
            
              /**
               * Get detailed command info for help/introspection.
               * @param {string} name
               * @returns {{name:string, plugin:string, spec:any}|null}
               */
              getCommandInfo(name) {
                const cmd = String(name || '').trim().toLowerCase();
                if (!cmd) return null;
                const rec = this._commands.get(cmd);
                if (!rec) return null;
                return { name: cmd, plugin: rec.plugin, spec: rec.spec };
              }
            
            """
        )
        content, changed = _insert_before(content, marker, insert_method, already_ok_substring="getCommandInfo(name)")
        changed_any = changed_any or changed

    if changed_any:
        _write_text(p, content)
    return changed_any


def _patch_plugin_manager_js(repo: Path) -> bool:
    p = repo / "src" / "core" / "plugin-manager.js"
    content = _read_text(p)
    changed_any = False

    if "listPluginMetas()" not in content:
        marker = "  _isPluginEnabled(name, meta) {"
        insert = dedent(
            """
            
              /**
               * List metas for loaded plugins (for dynamic help/UX).
               * @returns {Array<any>}
               */
              listPluginMetas() {
                const metas = Array.from(this._loaded.values()).map((r) => r.meta);
                metas.sort((a, b) => String(a.name).localeCompare(String(b.name)));
                return metas;
              }
            
              /**
               * Get meta for a loaded plugin by name.
               * @param {string} name
               * @returns {any|null}
               */
              getPluginMeta(name) {
                const n = String(name || '');
                const rec = this._loaded.get(n);
                return rec ? rec.meta : null;
              }
            
            """
        )
        content, changed = _insert_before(content, marker, insert, already_ok_substring="listPluginMetas()")
        changed_any = changed_any or changed

    if changed_any:
        _write_text(p, content)
    return changed_any


def _patch_core_navigation_blank_detection(repo: Path) -> bool:
    p = repo / "src" / "plugins" / "core-navigation.js"
    content = _read_text(p)

    start_marker = "      // 检查可见元素数量"
    end_marker = "      // 检查是否只有错误信息"

    replacement = dedent(
        """
              // 检查可见元素数量（性能优化：计数到阈值后提前退出）
              const nodes = body.querySelectorAll('*');
              let visibleCount = 0;
              const needVisibleThreshold = 5;
              const earlyExitAt = needVisibleThreshold + 1;

              for (let i = 0; i < nodes.length; i++) {
                const el = nodes[i];
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                visibleCount += 1;
                if (visibleCount >= earlyExitAt) break;
              }

              // 白屏判断条件：
              // 1. body 文本内容少于 50 字符
              // 2. 可见元素少于 5 个
              // 3. HTML 内容少于 500 字符
              const isBlank = bodyText.length < 50 && visibleCount < needVisibleThreshold && bodyHtml.length < 500;

              if (isBlank) {
                return {
                  isBlank: true,
                  reason: 'empty_content',
                  details: {
                    textLength: bodyText.length,
                    htmlLength: bodyHtml.length,
                    visibleElements: visibleCount
                  }
                };
              }

        """
    )

    content, changed = _replace_between(
        content,
        start_marker,
        end_marker,
        replacement,
        already_ok_substring="visibleCount < needVisibleThreshold",
    )

    if changed:
        _write_text(p, content)
    return changed


def _patch_core_scanner_concurrency(repo: Path) -> bool:
    p = repo / "src" / "plugins" / "core-scanner.js"
    content = _read_text(p)
    changed_any = False

    # 1) Ensure promise pool import exists.
    if "require('../utils/promise-pool')" not in content:
        anchor = "const { withTimeout, sleep } = require('../utils/async');\n"
        if anchor not in content:
            # fallback: match sleep import line
            m = re.search(r"const\s+\{[^}]*sleep[^}]*\}\s*=\s*require\('\.\./utils/async'\);\s*\n", content)
            if not m:
                raise PatchError("core-scanner.js: cannot find async require line for pMap import.")
            anchor = m.group(0)
        content, changed = _insert_after(content, anchor, "const { pMap } = require('../utils/promise-pool');\n", already_ok_substring="pMap } = require('../utils/promise-pool')")
        changed_any = changed_any or changed

    # 2) Patch the BoxModel fetching loop inside scanViewport().
    start_marker = "  // For each candidate, fetch box model to check viewport intersection"
    end_marker = "  const page = await kernel.page();"

    new_block = dedent(
        """
          // For each candidate, fetch box model to check viewport intersection.
          // 性能优化：并发拉取 BoxModel，但保持输出顺序稳定（按 unique 顺序依次入选）。
          const elements = [];
          const truncated = unique.length > maxElements;

          const CONCURRENCY = 8; // conservative; do NOT change timeouts/design
          for (let offset = 0; offset < unique.length && elements.length < maxElements; offset += CONCURRENCY) {
            const batch = unique.slice(offset, offset + CONCURRENCY);

            const batchModels = await Promise.all(batch.map(async (c) => {
              try {
                const model = await domGetBoxModel(cdp, c.backendDOMNodeId);
                return { c, model };
              } catch {
                return null;
              }
            }));

            for (const item of batchModels) {
              if (!item || !item.model) continue;
              if (elements.length >= maxElements) break;

              const c = item.c;
              const model = item.model;

              // prefer border quad
              const quad = model.border || model.content;
              if (!quad || quad.length < 8) continue;

              // LayoutMetrics includes visualViewport offset; but quad is in CSS pixels in frame space.
              // We still keep x/y as best-effort; interaction computes exact points via JS later.
              const pt = computeClickablePointFromQuad(quad, viewportW, viewportH);
              if (!pt) continue;

              elements.push({
                id: elements.length + 1,
                type: c.role || 'element',
                role: c.role || null,
                text: c.text || '',
                x: pt.x,
                y: pt.y,
                w: pt.rect.width,
                h: pt.rect.height,
                value: c.value,
                checked: null,
                completed: null,
                backendDOMNodeId: c.backendDOMNodeId
              });
            }
          }

        """
    )

    content, changed = _replace_between(
        content,
        start_marker,
        end_marker,
        new_block,
        already_ok_substring="batchModels = await Promise.all",
    )
    changed_any = changed_any or changed

    # 3) Patch enhanceWithDOM() to run concurrently (order-preserving).
    enhance_start = "async function enhanceWithDOM(kernel, elements) {"
    enhance_end = "async function scanAll(kernel) {"

    if "const enhanced = await pMap" not in content:
        new_enhance = dedent(
            r"""
            async function enhanceWithDOM(kernel, elements) {
              const cdp = await kernel.cdp();
              await cdp.enable('DOM');
              await cdp.enable('Runtime');

              const list = Array.isArray(elements) ? elements : [];
              const CONCURRENCY = 3; // conservative; avoids overloading Runtime/DOM

              const enhanced = await pMap(list, async (el) => {
                // 如果已经有足够的文本，跳过
                if (el.text && el.text.length > 30) return el;

                // 只增强 listitem 和 generic 类型
                if (el.type !== 'listitem' && el.type !== 'generic') return el;

                try {
                  // 使用 backendDOMNodeId 精确定位元素
                  const resolved = await cdp.send('DOM.resolveNode', {
                    backendNodeId: el.backendDOMNodeId
                  }, { timeoutMs: 1500, label: 'DOM.resolveNode(enhance)' });

                  if (!resolved || !resolved.object || !resolved.object.objectId) return el;

                  const result = await cdp.send('Runtime.callFunctionOn', {
                    objectId: resolved.object.objectId,
                    functionDeclaration: `function() {
                      try {
                        const el = this;
                        let text = '';

                        // 查找产品标题
                        const titleEl = el.querySelector('h2, h2 a, [data-cy="title-recipe"], .a-text-normal, .a-link-normal .a-text-normal');
                        if (titleEl) {
                          text = (titleEl.innerText || titleEl.textContent || '').trim();
                        }

                        // 查找价格
                        const priceEl = el.querySelector('.a-price .a-offscreen, .a-price-whole');
                        if (priceEl) {
                          const price = (priceEl.textContent || '').trim();
                          if (price && price.startsWith('$')) {
                            text += text ? ' | ' + price : price;
                          }
                        }

                        // 查找评分
                        const ratingEl = el.querySelector('[aria-label*="out of 5"], .a-icon-alt');
                        if (ratingEl) {
                          const rating = ratingEl.getAttribute('aria-label') || '';
                          const match = rating.match(/([\\d.]+) out of 5/);
                          if (match) {
                            text += text ? ' | ★' + match[1] : '★' + match[1];
                          }
                        }

                        // 如果没有找到特定内容，使用 innerText 的前 80 字符
                        if (!text) {
                          text = (el.innerText || '').substring(0, 80).replace(/\\n+/g, ' ').trim();
                        }

                        return { ok: true, text: text.substring(0, 100) };
                      } catch (e) {
                        return { ok: false, error: String(e) };
                      }
                    }`,
                    returnByValue: true
                  }, { timeoutMs: 2000, label: 'enhance(callFunctionOn)' });

                  const v = result && result.result ? result.result.value : null;
                  if (v && v.ok && v.text) return { ...el, text: v.text };
                  return el;
                } catch {
                  return el;
                }
              }, { concurrency: CONCURRENCY, stopOnError: false });

              return enhanced;
            }

            """
        ).lstrip("\n")
        content, changed = _replace_between(
            content,
            enhance_start,
            enhance_end,
            new_enhance,
            already_ok_substring="const enhanced = await pMap",
        )
        changed_any = changed_any or changed

    if changed_any:
        _write_text(p, content)
    return changed_any


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Refactor Pup JS CLI (modular + dynamic help + safe perf tweaks).")
    ap.add_argument("--no-backup", action="store_true", help="Do not create .bak timestamp backups.")
    ap.add_argument("--overwrite-cli-format", action="store_true", help="Overwrite src/cli/format-text.js if it already exists.")
    ns = ap.parse_args(argv)

    repo = REPO_ROOT
    index_path = repo / "src" / "index.js"
    if not index_path.exists():
        print("ERROR: src/index.js not found. Please run from the repository root.", file=sys.stderr)
        return 2

    # Backup key files
    backup_enabled = not ns.no_backup
    for rel in [
        "src/index.js",
        "src/core/kernel.js",
        "src/core/plugin-manager.js",
        "src/plugins/core-navigation.js",
        "src/plugins/core-scanner.js",
    ]:
        p = repo / rel
        if p.exists():
            _backup_file(p, backup_enabled)

    # Extract formatText from the current index.js BEFORE overwriting it.
    fmt_path = repo / "src" / "cli" / "format-text.js"
    format_text_code = ""
    overwrite_fmt = bool(ns.overwrite_cli_format)

    if fmt_path.exists() and not overwrite_fmt:
        # Keep existing; no extraction required.
        pass
    else:
        index_js_old = _read_text(index_path)
        format_text_code = _extract_format_text_function(index_js_old)

    # Create/overwrite CLI modules
    if not fmt_path.exists() and not format_text_code:
        raise PatchError("src/cli/format-text.js missing and could not extract from src/index.js.")

    _write_cli_modules(repo, format_text_code=(format_text_code or "function formatText(){return ''}"), overwrite_format_text=overwrite_fmt or (not fmt_path.exists()))

    # Overwrite index.js to new modular entrypoint
    _write_new_index_js(repo)

    # Patch kernel + plugin manager for dynamic help + micro perf
    _patch_kernel_js(repo)
    _patch_plugin_manager_js(repo)

    # Patch plugins for safe perf improvements
    _patch_core_navigation_blank_detection(repo)
    _patch_core_scanner_concurrency(repo)

    print("Done. Updated files:")
    print("  - src/index.js (modular entrypoint)")
    print("  - src/cli/* (new CLI modules, dynamic help)")
    print("  - src/utils/promise-pool.js (new)")
    print("  - src/core/kernel.js (shared enable allowlist + getCommandInfo)")
    print("  - src/core/plugin-manager.js (listPluginMetas/getPluginMeta)")
    print("  - src/plugins/core-navigation.js (blank detection perf)")
    print("  - src/plugins/core-scanner.js (concurrent BoxModel + enhanceWithDOM)")
    print("")
    print("Try:")
    print("  node src/index.js --help")
    print("  node src/index.js help scan")
    print("  node src/index.js help download links")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PatchError as e:
        print(f"PATCH ERROR: {e}", file=sys.stderr)
        raise SystemExit(1)
