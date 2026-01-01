'use strict';

/**
 * Plugin Manager
 * - Scans src/plugins/*.js
 * - Loads plugins with (meta, onLoad, onUnload)
 * - Supports reloadByPath (hot reload)
 * - Generates CLI help from plugin meta + kernel command registry
 */

const fs = require('fs');
const path = require('path');

class PluginManager {
  /**
   * @param {import('./kernel').Kernel} kernel
   * @param {string} pluginsDir
   */
  constructor(kernel, pluginsDir) {
    this.kernel = kernel;
    this.pluginsDir = String(pluginsDir || '');

    /** @type {Map<string, {meta:any, mod:any, file:string}>} */
    this._loaded = new Map();
  }

  /**
   * Scan for plugin files.
   * @returns {string[]}
   */
  scan() {
    const dir = this.pluginsDir;
    if (!dir) return [];
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.js'))
      .map((e) => path.join(dir, e.name));

    files.sort((a, b) => a.localeCompare(b));
    return files;
  }

  /**
   * Load all plugins from the main plugins directory.
   */
  async loadAll() {
    const files = this.scan();
    for (const f of files) {
      await this.loadByPath(f);
    }
  }

  /**
   * Load plugins from an external directory.
   * @param {string} dir
   */
  async loadFromDir(dir) {
    const absDir = path.resolve(String(dir || ''));
    if (!absDir) return;
    
    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.js'))
      .map((e) => path.join(absDir, e.name));

    files.sort((a, b) => a.localeCompare(b));
    
    for (const f of files) {
      await this.loadByPath(f);
    }
  }

  /**
   * Unload all plugins.
   */
  async unloadAll() {
    const names = Array.from(this._loaded.keys());
    for (const n of names) {
      await this.unloadByName(n);
    }
  }

  /**
   * Load a plugin module by file path.
   * @param {string} file
   */
  async loadByPath(file) {
    const abs = path.resolve(String(file || ''));
    if (!abs) return;

    const mod = require(abs);
    const meta = mod && mod.meta ? mod.meta : null;

    if (!meta || !meta.name) {
      throw new Error(`Plugin missing meta.name: ${abs}`);
    }

    const name = String(meta.name);
    const enabled = this._isPluginEnabled(name, meta);

    if (!enabled) {
      // still track disabled plugin for help display? We skip load.
      return;
    }

    // if already loaded, unload first
    if (this._loaded.has(name)) {
      await this.unloadByName(name);
    }

    if (typeof mod.onLoad !== 'function') {
      throw new Error(`Plugin ${name} missing onLoad(kernel)`);
    }

    await mod.onLoad(this.kernel);

    this._loaded.set(name, { meta, mod, file: abs });
    this.kernel.bus.emit('plugin:loaded', { name, file: abs });
  }

  /**
   * Unload plugin by name.
   * @param {string} name
   */
  async unloadByName(name) {
    const n = String(name || '');
    const rec = this._loaded.get(n);
    if (!rec) return;

    try {
      if (rec.mod && typeof rec.mod.onUnload === 'function') {
        await rec.mod.onUnload(this.kernel);
      }
    } finally {
      this.kernel.cleanupPlugin(n);
      this._loaded.delete(n);
      this.kernel.bus.emit('plugin:unloaded', { name: n, file: rec.file });
    }
  }

  /**
   * Reload plugin module by path (used by hot reload).
   * @param {string} file
   */
  async reloadByPath(file) {
    const abs = path.resolve(String(file || ''));
    if (!abs.endsWith('.js')) return;

    // Determine plugin name by previously loaded map OR by requiring meta
    let existingName = null;
    for (const [name, rec] of this._loaded.entries()) {
      if (rec.file === abs) { existingName = name; break; }
    }

    if (existingName) {
      await this.unloadByName(existingName);
    }

    // Clear cache for this module
    try {
      delete require.cache[abs];
    } catch {}

    // Load again
    await this.loadByPath(abs);
  }

  /**
   * Build CLI help text using plugin meta + kernel commands.
   * @param {string} binName
   */
  buildHelp(binName = 'pup') {
    const commands = this.kernel.listCommands();
    const byPlugin = new Map();
    for (const c of commands) {
      if (!byPlugin.has(c.plugin)) byPlugin.set(c.plugin, []);
      byPlugin.get(c.plugin).push(c);
    }

    const pluginMetas = Array.from(this._loaded.values())
      .map((r) => r.meta)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const lines = [];
    lines.push('');
    lines.push('SOTA Pup / Neural-Link - Micro-Kernel Automation Engine');
    lines.push('');
    lines.push(`Usage: ${binName} <command> [args...] [options]`);
    lines.push('');
    lines.push('Output Options:');
    lines.push('  (default)        AI-friendly text format');
    lines.push('  -j, --json       Compact JSON (for programmatic use)');
    lines.push('  --pretty         Pretty-printed JSON');
    lines.push('');
    lines.push('Other Options:');
    lines.push('  -h, --help       Show this help');
    lines.push('');
    lines.push('Commands (grouped by plugin):');

    for (const meta of pluginMetas) {
      const pname = String(meta.name);
      const pdesc = meta.description ? String(meta.description) : '';
      lines.push('');
      lines.push(`  [${pname}] ${pdesc}`.trimEnd());

      const list = byPlugin.get(pname) || [];
      list.sort((a, b) => a.name.localeCompare(b.name));

      for (const cmd of list) {
        const usage = cmd.usage ? cmd.usage : cmd.name;
        const desc = cmd.description ? cmd.description : '';
        lines.push(`    ${usage}`.padEnd(40) + ` ${desc}`);
        if (Array.isArray(cmd.cliOptions) && cmd.cliOptions.length) {
          for (const opt of cmd.cliOptions) {
            const flags = opt.flags ? String(opt.flags) : '';
            const od = opt.description ? String(opt.description) : '';
            lines.push(`      ${flags}`.padEnd(26) + ` ${od}`);
          }
        }
      }
    }

    lines.push('');
    return lines.join('\n');
  }



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

  _isPluginEnabled(name, meta) {
    const cfg = this.kernel && this.kernel.config ? this.kernel.config : {};
    const pcfg = cfg.PLUGINS || {};
    if (pcfg && Object.prototype.hasOwnProperty.call(pcfg, name)) {
      const rec = pcfg[name];
      if (rec && typeof rec.enabled === 'boolean') return rec.enabled;
    }
    // plugin-level default
    if (meta && typeof meta.enabledByDefault === 'boolean') return meta.enabledByDefault;
    return true;
  }
}

module.exports = {
  PluginManager
};
