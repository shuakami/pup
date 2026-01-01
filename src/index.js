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

async function boot(pluginsDir, externalPluginsDirs = []) {
  const kernel = new Kernel(config);
  const plugins = new PluginManager(kernel, pluginsDir);

  let loadError = null;
  try {
    // 加载内置插件
    await plugins.loadAll();
    
    // 加载外部插件目录
    for (const extDir of externalPluginsDirs) {
      await plugins.loadFromDir(extDir);
    }
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
  const binName = 'pup';
  const pluginsDir = path.join(__dirname, 'plugins');
  
  // 外部插件目录: 当前目录/.pup 和 用户目录/.pup
  const fs = require('fs');
  const os = require('os');
  const externalPluginsDirs = [];
  
  // 当前工作目录下的 .pup/
  const cwdPlugins = path.join(process.cwd(), '.pup');
  if (fs.existsSync(cwdPlugins)) {
    externalPluginsDirs.push(cwdPlugins);
  }
  
  // 用户目录下的 .pup/
  const homePlugins = path.join(os.homedir(), '.pup');
  if (fs.existsSync(homePlugins) && homePlugins !== cwdPlugins) {
    externalPluginsDirs.push(homePlugins);
  }

  const parsed = parseCliArgs(rawArgs);
  const writeLine = makeWriter(rawArgs);

  const { kernel, plugins } = await boot(pluginsDir, externalPluginsDirs);

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
