'use strict';

const os = require('os');
const path = require('path');

function resolveDir(p) {
  return path.resolve(p);
}

const HOST = process.env.NL_HOST || '127.0.0.1';
const PORT = Number(process.env.NL_PORT || 9222);

const STATE_DIR = process.env.NL_STATE_DIR
  ? resolveDir(process.env.NL_STATE_DIR)
  : path.join(os.homedir(), '.neural-link');

const USER_DATA_DIR = process.env.NL_USER_DATA_DIR
  ? resolveDir(process.env.NL_USER_DATA_DIR)
  : path.join(STATE_DIR, 'chrome-user-data');

const CHROME_EXECUTABLE = process.env.NL_CHROME_PATH || process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '';

const DEBUG = String(process.env.NL_DEBUG || '').trim() === '1';

const CONNECT_TIMEOUT_MS = Number(process.env.NL_CONNECT_TIMEOUT_MS || 15_000);
const PORT_PROBE_TIMEOUT_MS = Number(process.env.NL_PORT_PROBE_TIMEOUT_MS || 250);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NL_NAVIGATION_TIMEOUT_MS || 45_000);

// Scan limits
const MAX_SCAN_ELEMENTS = Number(process.env.NL_MAX_SCAN_ELEMENTS || 800);
const MAX_AX_NODES = Number(process.env.NL_MAX_AX_NODES || 5_000);

// CDP resilience
const CDP_COMMAND_TIMEOUT_MS = Number(process.env.NL_CDP_COMMAND_TIMEOUT_MS || 5_000);
const CDP_ENABLE_TIMEOUT_MS = Number(process.env.NL_CDP_ENABLE_TIMEOUT_MS || 2_500);
const CDP_BREAKER_FAILURE_THRESHOLD = Number(process.env.NL_CDP_BREAKER_FAILURE_THRESHOLD || 5);
const CDP_BREAKER_COOLDOWN_MS = Number(process.env.NL_CDP_BREAKER_COOLDOWN_MS || 1_500);

// Plugin hot reload (mainly for REPL/dev)
const HOT_RELOAD_PLUGINS = String(process.env.NL_HOT_RELOAD_PLUGINS || '').trim() === '1';
const HOT_RELOAD_DEBOUNCE_MS = Number(process.env.NL_HOT_RELOAD_DEBOUNCE_MS || 250);

/**
 * Plugin configuration:
 * - You can disable or tweak plugins here.
 * - Values are provided to plugins via kernel.config.PLUGINS[pluginName].
 */
const PLUGINS = {
  'core-scanner': {
    enabled: true
  },
  'core-interaction': {
    enabled: true
  },
  'core-navigation': {
    enabled: true
  },
  'auto-healer': {
    enabled: true,
    intervalMs: Number(process.env.NL_AUTO_HEAL_INTERVAL_MS || 3_000),
    stuckAfterMs: Number(process.env.NL_AUTO_HEAL_STUCK_AFTER_MS || 15_000),
    cooldownMs: Number(process.env.NL_AUTO_HEAL_COOLDOWN_MS || 30_000)
  }
};

const CHROME_ARGS = [
  `--remote-debugging-address=${HOST}`,
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${USER_DATA_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--disable-dev-shm-usage'
];

module.exports = {
  HOST,
  PORT,
  STATE_DIR,
  USER_DATA_DIR,
  CHROME_EXECUTABLE,
  DEBUG,
  CONNECT_TIMEOUT_MS,
  PORT_PROBE_TIMEOUT_MS,
  NAVIGATION_TIMEOUT_MS,

  MAX_SCAN_ELEMENTS,
  MAX_AX_NODES,

  CDP_COMMAND_TIMEOUT_MS,
  CDP_ENABLE_TIMEOUT_MS,
  CDP_BREAKER_FAILURE_THRESHOLD,
  CDP_BREAKER_COOLDOWN_MS,

  HOT_RELOAD_PLUGINS,
  HOT_RELOAD_DEBOUNCE_MS,

  PLUGINS,
  CHROME_ARGS
};
