'use strict';

/**
 * Legacy compatibility wrapper.
 *
 * The original codebase used a monolithic Controller that owned:
 * - browser lifecycle
 * - CDP sessions
 * - scanning
 * - input simulation
 * - navigation
 * - tab management
 *
 * This file now provides a thin adapter around the Micro-Kernel + Plugins.
 * New code should directly use Kernel + PluginManager + plugin services.
 */

const path = require('path');
const config = require('./config');
const { Kernel } = require('./core/kernel');
const { PluginManager } = require('./core/plugin-manager');

class Controller {
  constructor() {
    this.kernel = new Kernel(config);
    this.plugins = new PluginManager(this.kernel, path.join(__dirname, 'plugins'));
    this._ready = this.plugins.loadAll().then(() => {
      // Enable hot reload primarily for long-running processes.
      this.kernel.enableHotReload(this.plugins, path.join(__dirname, 'plugins'));
    });
  }

  async ready() {
    await this._ready;
  }

  async status() {
    await this.ready();
    const res = await this.kernel.runCommand('status', { argv: [] });
    return res;
  }

  async goto(url, { autoScan = false } = {}) {
    await this.ready();
    const argv = [String(url || '')];
    if (autoScan) argv.push('--scan');
    return await this.kernel.runCommand('goto', { argv });
  }

  async scan() {
    await this.ready();
    return await this.kernel.runCommand('scan', { argv: [] });
  }

  async scanAll() {
    await this.ready();
    return await this.kernel.runCommand('scanall', { argv: [] });
  }

  async act(id, action, value, opts = {}) {
    await this.ready();
    return await this.kernel.runCommand('act', {
      id,
      action,
      value,
      ...opts
    });
  }

  async scroll(direction) {
    await this.ready();
    return await this.kernel.runCommand('scroll', { argv: [String(direction || 'down')] });
  }

  async back() {
    await this.ready();
    return await this.kernel.runCommand('back', { argv: [] });
  }

  async forward() {
    await this.ready();
    return await this.kernel.runCommand('forward', { argv: [] });
  }

  async reload() {
    await this.ready();
    return await this.kernel.runCommand('reload', { argv: [] });
  }

  async listTabs() {
    await this.ready();
    return await this.kernel.runCommand('tabs', { argv: [] });
  }

  async switchTab(id) {
    await this.ready();
    return await this.kernel.runCommand('tab', { argv: [String(id)] });
  }

  async newTab(url) {
    await this.ready();
    return await this.kernel.runCommand('newtab', { argv: url ? [String(url)] : [] });
  }

  async closeTab(id) {
    await this.ready();
    return await this.kernel.runCommand('closetab', { argv: [String(id)] });
  }

  async closeOtherTabs() {
    await this.ready();
    return await this.kernel.runCommand('closeothertabs', { argv: [] });
  }

  async shutdown() {
    try { await this.plugins.unloadAll(); } catch {}
    try { await this.kernel.shutdown(); } catch {}
  }
}

module.exports = {
  Controller
};
