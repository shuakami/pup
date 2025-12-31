'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn, spawnSync } = require('child_process');
const { addExtra } = require('puppeteer-extra');
const puppeteer = addExtra(require('puppeteer-core'));
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const config = require('./config');

puppeteer.use(StealthPlugin());

let _browser = null;
let _connecting = null;
let _spawnedOnce = false;

function logDebug(...args) {
  if (!config.DEBUG) return;
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  process.stderr.write(`[NEURAL-LINK][browser] ${msg}\n`);
}

function ensureDirExists(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (e) {
    if (e && e.code === 'EEXIST') return;
    throw e;
  }
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function which(cmd) {
  const isWin = process.platform === 'win32';
  const tool = isWin ? 'where' : 'which';
  try {
    const out = spawnSync(tool, [cmd], { encoding: 'utf8' });
    if (out.status === 0 && out.stdout) {
      const line = out.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (line) return line;
    }
  } catch {
    // ignore
  }
  return '';
}

function resolveChromeExecutable() {
  if (config.CHROME_EXECUTABLE && fileExists(config.CHROME_EXECUTABLE)) {
    return config.CHROME_EXECUTABLE;
  }

  const platform = process.platform;

  if (platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
    for (const p of candidates) {
      if (fileExists(p)) return p;
    }
  }

  if (platform === 'win32') {
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    const pfx86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    const candidates = [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Chromium', 'Application', 'chrome.exe'),
      path.join(pfx86, 'Chromium', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ];
    for (const p of candidates) {
      if (p && fileExists(p)) return p;
    }
  }

  // linux + fallback: try PATH
  const pathCandidates = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'microsoft-edge-stable'
  ];
  for (const name of pathCandidates) {
    const p = which(name);
    if (p) return p;
  }

  throw new Error('Chrome executable not found. Set env NL_CHROME_PATH (or CHROME_PATH / PUPPETEER_EXECUTABLE_PATH) to your Chrome/Chromium binary.');
}

function isPortOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const sock = new net.Socket();
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try {
      sock.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

async function fetchJsonVersion(host, port) {
  const url = `http://${host}:${port}/json/version`;
  const resp = await axios.get(url, {
    timeout: 2_000,
    validateStatus: (s) => s >= 200 && s < 400
  });
  return resp.data;
}

async function waitForDebugger(host, port, timeoutMs) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    const open = await isPortOpen(host, port, config.PORT_PROBE_TIMEOUT_MS);
    if (!open) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    try {
      const info = await fetchJsonVersion(host, port);
      if (info && info.webSocketDebuggerUrl) return info;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const msg = lastErr && lastErr.message ? lastErr.message : String(lastErr || 'timeout');
  throw new Error(`Chrome debugger not ready on ${host}:${port} within ${timeoutMs}ms (${msg}).`);
}

function spawnChromeDetached() {
  ensureDirExists(config.USER_DATA_DIR);
  const chromePath = resolveChromeExecutable();
  const args = [...config.CHROME_ARGS];
  logDebug('Spawning Chrome:', chromePath);
  logDebug('Args:', args);
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
  _spawnedOnce = true;
  return child;
}

async function connectToChrome(host, port) {
  const info = await waitForDebugger(host, port, config.CONNECT_TIMEOUT_MS);
  const wsEndpoint = info.webSocketDebuggerUrl;
  logDebug('Connecting puppeteer to:', wsEndpoint);
  const browser = await puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: null
  });
  browser.on('disconnected', () => {
    logDebug('Browser disconnected');
    _browser = null;
    _connecting = null;
  });
  return browser;
}

async function getBrowser() {
  if (_browser && _browser.isConnected && _browser.isConnected()) return _browser;
  if (_connecting) return _connecting;

  _connecting = (async () => {
    const open = await isPortOpen(config.HOST, config.PORT, config.PORT_PROBE_TIMEOUT_MS);
    if (!open) {
      spawnChromeDetached();
    } else {
      logDebug(`Port ${config.PORT} open; attempting to attach...`);
    }

    try {
      const b = await connectToChrome(config.HOST, config.PORT);
      _browser = b;
      return b;
    } catch (e) {
      // If attach failed and we haven't spawned yet in this process, try spawning once.
      if (!_spawnedOnce) {
        logDebug('Attach failed; spawning Chrome once and retrying:', e && e.message ? e.message : String(e));
        spawnChromeDetached();
        const b = await connectToChrome(config.HOST, config.PORT);
        _browser = b;
        return b;
      }
      throw e;
    } finally {
      _connecting = null;
    }
  })();

  return _connecting;
}

module.exports = {
  getBrowser
};
