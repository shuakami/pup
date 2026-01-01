'use strict';

/**
 * Micro-Kernel:
 * - Owns browser lifecycle and CDP session pooling only.
 * - Provides a fast EventBus (micro-optimized vs EventEmitter for hot paths).
 * - Provides circuit breaker + command timeouts to avoid hung CDP calls.
 * - Supports plugin hot-reloading (fs.watch) by clearing require.cache.
 *
 * Plugins consume the kernel via:
 * - kernel.browser() / kernel.page() / kernel.cdp()
 * - kernel.enableHotReload(pluginManager, pluginsDir)
 * - kernel.registerCommand(pluginName, spec)
 * - kernel.provide(pluginName, serviceName, serviceObject)
 */

const fs = require('fs');
const path = require('path');
const configDefault = require('../config');
const { getBrowser } = require('../browser');

const { withTimeout } = require('../utils/async');
const { isRetryableError } = require('../utils/errors');


// Shared allowlist to avoid allocating a Set on every CDPClient.enable() call.
const NEEDS_ENABLE_DOMAINS = new Set(['Page', 'DOM', 'Runtime', 'Accessibility', 'Network', 'Log', 'Overlay', 'Emulation']);

/**
 * Ultra-light EventBus:
 * - avoids EventEmitter overhead (symbols, max listeners, etc.)
 * - uses arrays and stable references
 */
class EventBus {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this._map = new Map();
  }

  /**
   * @param {string} event
   * @param {(payload:any)=>void} handler
   */
  on(event, handler) {
    const k = String(event);
    const list = this._map.get(k);
    if (list) list.push(handler);
    else this._map.set(k, [handler]);
    return () => this.off(k, handler);
  }

  /**
   * @param {string} event
   * @param {(payload:any)=>void} handler
   */
  once(event, handler) {
    const off = this.on(event, (payload) => {
      try { off(); } catch {}
      handler(payload);
    });
    return off;
  }

  /**
   * @param {string} event
   * @param {(payload:any)=>void} handler
   */
  off(event, handler) {
    const k = String(event);
    const list = this._map.get(k);
    if (!list || list.length === 0) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this._map.delete(k);
  }

  /**
   * @param {string} event
   * @param {any} payload
   */
  emit(event, payload) {
    const k = String(event);
    const list = this._map.get(k);
    if (!list || list.length === 0) return;
    // Copy to allow mutation during emit
    const snapshot = list.slice(0);
    for (let i = 0; i < snapshot.length; i++) {
      try { snapshot[i](payload); } catch (e) {
        // best-effort: avoid crashing kernel on handler errors
        try { /* ignore */ } catch {}
      }
    }
  }
}

/**
 * CircuitBreaker for CDP commands:
 * - trips after N failures
 * - cools down for cooldownMs
 * - prevents infinite hangs by enforcing per-command timeouts
 */
class CircuitBreaker {
  /**
   * @param {{failureThreshold:number, cooldownMs:number}} opts
   */
  constructor(opts) {
    this.failureThreshold = Math.max(1, Number(opts.failureThreshold || 3));
    this.cooldownMs = Math.max(0, Number(opts.cooldownMs || 2000));
    this.failures = 0;
    this.openUntil = 0;
  }

  isOpen() {
    return Date.now() < this.openUntil;
  }

  recordSuccess() {
    this.failures = 0;
    this.openUntil = 0;
  }

  recordFailure() {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openUntil = Date.now() + this.cooldownMs;
    }
  }

  reset() {
    this.failures = 0;
    this.openUntil = 0;
  }
}

/**
 * Kernel CDP wrapper:
 * - lazy domain enable with caching
 * - applies command timeouts + circuit breaker
 */
class CDPClient {
  /**
   * @param {import('puppeteer-core').CDPSession} session
   * @param {{commandTimeoutMs:number, enableTimeoutMs:number, breaker:CircuitBreaker}} opts
   */
  constructor(session, opts) {
    this._session = session;
    this._enabled = new Set();
    this._commandTimeoutMs = opts.commandTimeoutMs;
    this._enableTimeoutMs = opts.enableTimeoutMs;
    this._breaker = opts.breaker;
  }

  /**
   * Lazy domain enabling:
   * @param {string} domain e.g. "Page", "DOM", "Runtime"
   */
  async enable(domain) {
    const d = String(domain || '').trim();
    if (!d) return;
    if (this._enabled.has(d)) return;

    // some domains do not require enable; keep allowlist (shared)


    if (!NEEDS_ENABLE_DOMAINS.has(d)) {


      this._enabled.add(d);


      return;


    }
const method = `${d}.enable`;
    try {
      await this.send(method, {}, { timeoutMs: this._enableTimeoutMs, label: `enable:${d}` });
      this._enabled.add(d);
    } catch (e) {
      // mark enabled anyway for best-effort (some runtimes reject enable)
      this._enabled.add(d);
    }
  }

  /**
   * @param {string} method
   * @param {any} [params]
   * @param {{timeoutMs?:number, label?:string}} [opts]
   */
  async send(method, params = {}, opts = {}) {
    if (this._breaker.isOpen()) {
      const err = new Error(`CDP circuit breaker open: ${String(opts.label || method)}`);
      err.code = 'CDP_BREAKER_OPEN';
      throw err;
    }

    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : this._commandTimeoutMs;
    const label = String(opts.label || method);

    try {
      const p = this._session.send(method, params);
      const res = await withTimeout(Promise.resolve(p), timeoutMs, `CDP timeout: ${label}`);
      this._breaker.recordSuccess();
      return res;
    } catch (e) {
      this._breaker.recordFailure();
      throw e;
    }
  }

  on(event, handler) {
    return this._session.on(event, handler);
  }

  off(event, handler) {
    // puppeteer CDPSession has removeListener
    try { this._session.off(event, handler); } catch {}
    try { this._session.removeListener(event, handler); } catch {}
  }

  detach() {
    try { return this._session.detach(); } catch {}
    return null;
  }
}

/**
 * Kernel
 */
class Kernel {
  /**
   * @param {any} config
   */
  constructor(config = configDefault) {
    this.config = config || configDefault;

    /** @type {import('puppeteer-core').Browser|null} */
    this._browser = null;

    /** @type {import('puppeteer-core').Page|null} */
    this._page = null;

    /** @type {boolean} */
    this._browserBound = false;

    /** @type {Map<string, CDPClient>} */
    this._cdpByTargetId = new Map();

    /** @type {EventBus} */
    this.bus = new EventBus();

    /** @type {Map<string, {plugin:string, spec:any}>} */
    this._commands = new Map();

    /** @type {Map<string, any>} plugin-scoped services */
    this._services = new Map();

    /** @type {Map<string, Set<string>>} plugin -> commandNames */
    this._pluginCommands = new Map();

    /** @type {Map<string, Set<string>>} plugin -> serviceKeys */
    this._pluginServices = new Map();

    this._breaker = new CircuitBreaker({
      failureThreshold: this.config.CDP_BREAKER_FAILURE_THRESHOLD || 3,
      cooldownMs: this.config.CDP_BREAKER_COOLDOWN_MS || 2000
    });

    this._hotReloadWatcher = null;
    this._hotReloadDebounce = null;
    
    // 标签页内存警告标记（只提醒一次）
    this._tabMemoryWarned = false;
    
    // 暴露工具函数给外部插件使用
    this.utils = {
      strings: require('../utils/strings'),
      async: require('../utils/async'),
      errors: require('../utils/errors'),
      colors: require('../utils/colors'),
      promisePool: require('../utils/promise-pool')
    };
  }

  // ===========================
  // Browser/Page lifecycle
  // ===========================

  async browser() {
    if (this._browser && this._browser.isConnected && this._browser.isConnected()) return this._browser;
    const b = await getBrowser();
    this._browser = b;

    if (!this._browserBound) {
      this._browserBound = true;
      b.on('disconnected', () => {
        this._browser = null;
        this._page = null;
        this._cdpByTargetId.clear();
        this.bus.emit('browser:disconnected', {});
      });
    }

    return b;
  }

  /**
   * Choose a "best" page:
   * - ignore devtools + extensions
   * - prefer a visible tab if possible
   */
  async page() {
    await this.browser();
    if (this._page && !this._page.isClosed()) return this._page;

    let pages = [];
    try {
      pages = await this._browser.pages();
    } catch (e) {
      // recover once
      this._browser = null;
      await this.browser();
      pages = await this._browser.pages();
    }

    const candidates = pages
      .filter((p) => p && !p.isClosed())
      .filter((p) => {
        const u = String((p.url && p.url()) || '');
        if (!u) return true;
        if (u.startsWith('chrome-extension://')) return false;
        if (u.startsWith('devtools://')) return false;
        return true;
      });

    if (candidates.length === 0) {
      this._page = await this._browser.newPage();
    } else {
      let active = null;
      for (const p of candidates) {
        try {
          const isVisible = await Promise.race([
            p.evaluate(() => document.visibilityState === 'visible'),
            new Promise((r) => setTimeout(() => r(false), 400))
          ]);
          if (isVisible) { active = p; break; }
        } catch {
          // ignore
        }
      }
      this._page = active || candidates[0];
    }

    this.bus.emit('page:changed', { url: safeUrl(this._page) });
    return this._page;
  }

  /**
   * CDP session pooling keyed by targetId.
   * Plugins should use kernel.cdp() and enable domains lazily.
   */
  async cdp({ forceNew = false } = {}) {
    const page = await this.page();
    const target = page.target();
    const tid = getTargetId(target);

    if (!forceNew && tid && this._cdpByTargetId.has(tid)) {
      return this._cdpByTargetId.get(tid);
    }

    try {
      const session = await target.createCDPSession();
      const client = new CDPClient(session, {
        commandTimeoutMs: this.config.CDP_COMMAND_TIMEOUT_MS || 5000,
        enableTimeoutMs: this.config.CDP_ENABLE_TIMEOUT_MS || 2500,
        breaker: this._breaker
      });

      if (tid) this._cdpByTargetId.set(tid, client);
      return client;
    } catch (e) {
      if (isRetryableError(e)) {
        this._page = null;
        const p2 = await this.page();
        const t2 = p2.target();
        const tid2 = getTargetId(t2);
        const session2 = await t2.createCDPSession();
        const client2 = new CDPClient(session2, {
          commandTimeoutMs: this.config.CDP_COMMAND_TIMEOUT_MS || 5000,
          enableTimeoutMs: this.config.CDP_ENABLE_TIMEOUT_MS || 2500,
          breaker: this._breaker
        });
        if (tid2) this._cdpByTargetId.set(tid2, client2);
        return client2;
      }
      throw e;
    }
  }

  async resetPageTo(page) {
    if (!page) return;
    this._page = page;
    // 清除旧的 CDP session 缓存，强制下次创建新的
    this._cdpByTargetId.clear();
    this.bus.emit('page:changed', { url: safeUrl(page) });
  }

  /**
   * Reset the circuit breaker (useful after recovery)
   */
  resetBreaker() {
    this._breaker.reset();
  }

  // ===========================
  // Commands + services
  // ===========================

  /**
   * @param {string} pluginName
   * @param {{name:string, description?:string, usage?:string, cliOptions?:any[], handler:(ctx:any)=>Promise<any>}} spec
   */
  registerCommand(pluginName, spec) {
    if (!spec || !spec.name || typeof spec.handler !== 'function') {
      throw new Error('registerCommand: invalid spec');
    }
    const name = String(spec.name).trim().toLowerCase();
    if (!name) throw new Error('registerCommand: empty name');

    this._commands.set(name, { plugin: pluginName, spec });
    if (!this._pluginCommands.has(pluginName)) this._pluginCommands.set(pluginName, new Set());
    this._pluginCommands.get(pluginName).add(name);
  }

  /**
   * Used by plugin manager on unload.
   * @param {string} pluginName
   */
  cleanupPlugin(pluginName) {
    // remove commands
    const cmdSet = this._pluginCommands.get(pluginName);
    if (cmdSet) {
      for (const cmd of cmdSet) this._commands.delete(cmd);
      this._pluginCommands.delete(pluginName);
    }

    // remove services
    const svcSet = this._pluginServices.get(pluginName);
    if (svcSet) {
      for (const key of svcSet) this._services.delete(key);
      this._pluginServices.delete(pluginName);
    }

    this.bus.emit('plugin:unloaded', { name: pluginName });
  }

  /**
   * Provide a plugin-scoped service.
   * @param {string} pluginName
   * @param {string} serviceName
   * @param {any} service
   */
  provide(pluginName, serviceName, service) {
    const key = `${pluginName}:${String(serviceName)}`;
    this._services.set(key, service);
    if (!this._pluginServices.has(pluginName)) this._pluginServices.set(pluginName, new Set());
    this._pluginServices.get(pluginName).add(key);
  }

  /**
   * Resolve service by:
   * - exact key "plugin:service"
   * - or by searching any plugin that provided serviceName (first match)
   * @param {string} serviceNameOrKey
   */
  getService(serviceNameOrKey) {
    const k = String(serviceNameOrKey || '');
    if (this._services.has(k)) return this._services.get(k);

    // fallback: search by suffix `:serviceName`
    const suffix = `:${k}`;
    for (const [key, svc] of this._services.entries()) {
      if (key.endsWith(suffix)) return svc;
    }
    return null;
  }

  /**
   * @returns {Array<{name:string, plugin:string, description?:string, usage?:string, cliOptions?:any[]}>}
   */
  listCommands() {
    const out = [];
    for (const [name, rec] of this._commands.entries()) {
      out.push({
        name,
        plugin: rec.plugin,
        description: rec.spec.description || '',
        usage: rec.spec.usage || '',
        cliOptions: rec.spec.cliOptions || []
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * Run a command by name.
   * ctx: {argv?:string[], ...}
   * @param {string} name
   * @param {any} ctx
   */


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

  async runCommand(name, ctx = {}) {
    const cmd = String(name || '').trim().toLowerCase();
    const rec = this._commands.get(cmd);
    if (!rec) {
      const err = new Error(`Unknown command: ${cmd}`);
      err.code = 'UNKNOWN_COMMAND';
      throw err;
    }

    const context = {
      ...ctx,
      argv: Array.isArray(ctx.argv) ? ctx.argv : [],
      kernel: this,
      bus: this.bus,
      config: this.config,
      now: Date.now()
    };

    try {
      const result = await rec.spec.handler(context);
      
      // 命令执行后检测标签页数量，超过20个提醒一次
      if (!this._tabMemoryWarned && this._browser) {
        try {
          const pages = await this._browser.pages();
          if (pages.length > 20) {
            this._tabMemoryWarned = true;
            if (result && typeof result === 'object') {
              result._tabWarning = `[!] Memory warning: ${pages.length} tabs open. Consider closing unused tabs with 'closeothertabs' or 'closetab'.`;
            }
          }
        } catch {}
      }
      
      return result;
    } catch (e) {
      // If this looks retryable, emit event for plugins to respond.
      if (isRetryableError(e)) {
        this.bus.emit('cdp:retryableError', { error: String(e && e.message ? e.message : e) });
      }
      throw e;
    }
  }

  // ===========================
  // Hot reload support
  // ===========================

  /**
   * Enable plugin hot reload (watch src/plugins)
   * @param {any} pluginManager
   * @param {string} pluginsDir
   */
  enableHotReload(pluginManager, pluginsDir) {
    if (this._hotReloadWatcher) return;
    const dir = String(pluginsDir || '');
    if (!dir) return;

    const enabledByConfig = !!(this.config && this.config.HOT_RELOAD_PLUGINS);
    const debounceMs = Number(this.config.HOT_RELOAD_DEBOUNCE_MS || 250);

    // default: enable in REPL/dev mode when config flag is set
    if (!enabledByConfig) {
      // still allow explicit enableHotReload usage without config guard
      // (the index.js always calls it; config can disable by env NL_HOT_RELOAD_PLUGINS=0)
    }

    try {
      this._hotReloadWatcher = fs.watch(dir, { recursive: true }, (evt, filename) => {
        if (!filename) return;

        if (this._hotReloadDebounce) clearTimeout(this._hotReloadDebounce);
        this._hotReloadDebounce = setTimeout(async () => {
          const f = path.join(dir, filename);
          try {
            clearRequireCacheUnder(dir);
            await pluginManager.reloadByPath(f);
            this.bus.emit('plugin:reloaded', { file: f });
          } catch (e) {
            this.bus.emit('plugin:reloadFailed', { file: f, error: String(e && e.message ? e.message : e) });
          }
        }, debounceMs);
      });

      this.bus.emit('hotreload:enabled', { dir });
    } catch (e) {
      this.bus.emit('hotreload:failed', { dir, error: String(e && e.message ? e.message : e) });
    }
  }

  async shutdown() {
    try {
      if (this._hotReloadWatcher) {
        this._hotReloadWatcher.close();
        this._hotReloadWatcher = null;
      }
    } catch {}

    try {
      for (const cdp of this._cdpByTargetId.values()) {
        try { await cdp.detach(); } catch {}
      }
      this._cdpByTargetId.clear();
    } catch {}

    try {
      if (this._browser && this._browser.isConnected && this._browser.isConnected()) {
        // do not close external chrome, just disconnect
        try { this._browser.disconnect(); } catch {}
      }
    } catch {}

    this._browser = null;
    this._page = null;
  }
}

function clearRequireCacheUnder(dir) {
  const base = path.resolve(dir);
  for (const k of Object.keys(require.cache)) {
    try {
      const resolved = path.resolve(k);
      if (resolved.startsWith(base)) delete require.cache[k];
    } catch {
      // ignore
    }
  }
}

function getTargetId(target) {
  try {
    if (!target) return '';
    if (target._targetId) return String(target._targetId);
    if (typeof target._targetInfo === 'function') {
      const info = target._targetInfo();
      if (info && info.targetId) return String(info.targetId);
    }
    if (target._targetInfo && target._targetInfo.targetId) return String(target._targetInfo.targetId);
  } catch {}
  return '';
}

function safeUrl(page) {
  try { return String(page.url()); } catch { return ''; }
}

module.exports = {
  Kernel
};
