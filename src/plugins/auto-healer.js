'use strict';

/**
 * auto-healer (Imagined Plugin)
 * -----------------------------
 * Detects a "stuck" page (no navigation progress / repeated retryable errors / runtime not responsive)
 * and attempts recovery:
 * - reload page
 * - re-scan (if scanner exists)
 *
 * This plugin showcases cross-plugin orchestration:
 * - listens to kernel events
 * - uses navigation + scanner services
 * - enforces cooldown to avoid aggressive loops
 */

const { sleep } = require('../utils/async');

const meta = {
  name: 'auto-healer',
  description: 'Detects stuck pages and attempts auto-recovery (reload + rescan).',
  cliOptions: [
    { flags: '--heal', description: 'Manually trigger healer once' }
  ]
};

let _lastOkTs = Date.now();
let _lastHealTs = 0;
let _errorCount = 0;
let _timer = null;
let _offErr = null;
let _offPage = null;

function cfg(kernel) {
  const pcfg = (kernel.config && kernel.config.PLUGINS && kernel.config.PLUGINS[meta.name]) ? kernel.config.PLUGINS[meta.name] : {};
  return {
    intervalMs: Number(pcfg.intervalMs || 3000),
    stuckAfterMs: Number(pcfg.stuckAfterMs || 15000),
    cooldownMs: Number(pcfg.cooldownMs || 30000)
  };
}

async function livenessCheck(kernel) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');

  try {
    // runtime ping
    const res = await cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, { timeoutMs: 2000, label: 'auto-healer:ping' });
    if (res && res.result && res.result.value === 2) {
      _lastOkTs = Date.now();
      return true;
    }
  } catch {
    // ignore here; error count is handled by events
  }
  return false;
}

async function heal(kernel, reason) {
  const { cooldownMs } = cfg(kernel);
  const now = Date.now();
  if (now - _lastHealTs < cooldownMs) return { ok: false, skipped: true, reason: 'cooldown' };
  _lastHealTs = now;

  const page = await kernel.page();
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: kernel.config.NAVIGATION_TIMEOUT_MS || 45000 });
    await sleep(500);
  } catch {}

  // optional re-scan
  const scanner = kernel.getService('scanner');
  let scanRes = null;
  if (scanner && typeof scanner.scan === 'function') {
    try { scanRes = await scanner.scan(); } catch {}
  }

  _errorCount = 0;
  _lastOkTs = Date.now();

  return { ok: true, healed: true, reason: String(reason || 'unknown'), scanned: !!scanRes, elements: scanRes ? scanRes.elements : undefined };
}

async function onLoad(kernel) {
  const conf = cfg(kernel);

  _offErr = kernel.bus.on('cdp:retryableError', () => {
    _errorCount += 1;
  });

  _offPage = kernel.bus.on('page:changed', () => {
    _lastOkTs = Date.now();
    _errorCount = 0;
  });

  _timer = setInterval(async () => {
    const { stuckAfterMs } = cfg(kernel);
    const now = Date.now();

    // If recent OK, do nothing
    if (now - _lastOkTs < stuckAfterMs && _errorCount < 3) {
      await livenessCheck(kernel).catch(() => {});
      return;
    }

    // Stuck: attempt heal
    await heal(kernel, `stuck: okAge=${now - _lastOkTs}ms, errors=${_errorCount}`).catch(() => {});
  }, conf.intervalMs);

  kernel.registerCommand(meta.name, {
    name: 'heal',
    usage: 'heal',
    description: 'Manually trigger auto-healer recovery once.',
    handler: async () => {
      const res = await heal(kernel, 'manual');
      return { ok: true, cmd: 'HEAL', ...res };
    }
  });
}

async function onUnload(kernel) {
  try { if (_timer) clearInterval(_timer); } catch {}
  _timer = null;

  try { if (_offErr) _offErr(); } catch {}
  try { if (_offPage) _offPage(); } catch {}

  _offErr = null;
  _offPage = null;
}

module.exports = {
  meta,
  onLoad,
  onUnload
};
