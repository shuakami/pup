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
