'use strict';

/**
 * core-navigation plugin:
 * - Navigation: status/goto/back/forward/reload
 * - Scroll
 * - Tab management: list/switch/new/close/closeOtherTabs
 * - Composite helpers: clicktext, do, batch
 */

const { toStr } = require('../utils/strings');
const { sleep, waitForEvent } = require('../utils/async');

const meta = {
  name: 'core-navigation',
  description: 'Navigation, scrolling, and tab management',
  cliOptions: [
    { flags: '--scan', description: 'Auto-scan after navigation/action when supported' },
    { flags: '--no-scan', description: 'Skip auto-scan (for composite commands)' }
  ]
};

function scanner(kernel) {
  return kernel.getService('scanner');
}

function interaction(kernel) {
  return kernel.getService('interaction');
}

async function safeGetTitle(kernel) {
  const page = await kernel.page();
  try { return await page.title(); } catch { return ''; }
}

/**
 * 检测页面是否白屏
 * 返回 { isBlank, reason } 或 null（如果检测失败）
 */
async function detectBlankPage(kernel) {
  const page = await kernel.page();
  try {
    const result = await page.evaluate(() => {
      const body = document.body;
      if (!body) return { isBlank: true, reason: 'no_body' };
      
      // 检查 body 内容长度
      const bodyText = (body.innerText || '').trim();
      const bodyHtml = body.innerHTML || '';
      
      // 检查可见元素数量
      const visibleElements = Array.from(body.querySelectorAll('*')).filter(el => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && 
               style.visibility !== 'hidden' && 
               rect.width > 0 && 
               rect.height > 0;
      });
      
      // 白屏判断条件：
      // 1. body 文本内容少于 50 字符
      // 2. 可见元素少于 5 个
      // 3. HTML 内容少于 500 字符
      const isBlank = bodyText.length < 50 && visibleElements.length < 5 && bodyHtml.length < 500;
      
      if (isBlank) {
        return {
          isBlank: true,
          reason: 'empty_content',
          details: {
            textLength: bodyText.length,
            htmlLength: bodyHtml.length,
            visibleElements: visibleElements.length
          }
        };
      }
      
      // 检查是否只有错误信息
      const errorKeywords = ['error', 'blocked', 'denied', 'forbidden', '403', '404', '500', '502', '503'];
      const lowerText = bodyText.toLowerCase();
      const hasOnlyError = bodyText.length < 200 && errorKeywords.some(k => lowerText.includes(k));
      
      if (hasOnlyError) {
        return {
          isBlank: false,
          isError: true,
          reason: 'error_page',
          errorText: bodyText.substring(0, 100)
        };
      }
      
      return { isBlank: false };
    });
    
    return result;
  } catch {
    return null; // 检测失败
  }
}

async function status(kernel) {
  const page = await kernel.page();
  const result = { title: await safeGetTitle(kernel), url: toStr(page.url()) };
  
  // 白屏检测
  const blankCheck = await detectBlankPage(kernel);
  if (blankCheck) {
    if (blankCheck.isBlank) {
      result.isBlank = true;
      result.blankReason = blankCheck.reason;
      if (blankCheck.details) result.blankDetails = blankCheck.details;
    }
    if (blankCheck.isError) {
      result.isError = true;
      result.errorText = blankCheck.errorText;
    }
  }
  
  return result;
}

async function goto(kernel, url, { autoScan = false } = {}) {
  const page = await kernel.page();
  const targetUrl = toStr(url).trim();
  if (!targetUrl) throw new Error('GOTO: missing url');

  // 确保 CDP session 是针对当前页面的
  await kernel.cdp({ forceNew: true });

  let timedOut = false;
  let result = {};
  const initialUrl = targetUrl;

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: kernel.config.NAVIGATION_TIMEOUT_MS || 45000 });
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    if (msg.includes('timeout') || msg.includes('Timeout')) {
      timedOut = true;
      // 超时了，但页面可能已经部分加载，尝试获取当前状态
    } else {
      throw e;
    }
  }

  // 等待一小段时间检测二次跳转
  await sleep(300);

  // 获取当前页面信息
  result.title = await safeGetTitle(kernel);
  result.url = toStr(page.url());
  
  // 检测二次跳转（404跳转、重定向等）
  const finalUrl = result.url;
  // 标准化 URL 比较（忽略末尾斜杠）
  const normalizeUrl = (u) => u.replace(/\/+$/, '').toLowerCase();
  if (normalizeUrl(finalUrl) !== normalizeUrl(initialUrl)) {
    // 检查是否跳转到了不同的页面
    try {
      const initialHost = new URL(initialUrl).hostname;
      const finalHost = new URL(finalUrl).hostname;
      
      // 如果域名完全不同，或者跳转到了首页
      if (initialHost !== finalHost) {
        result.redirected = true;
        result.redirectFrom = initialUrl;
        result.redirectReason = 'different_domain';
      } else {
        // 检查是否跳转到首页（排除只是加了斜杠的情况）
        const finalPath = new URL(finalUrl).pathname;
        const initialPath = new URL(initialUrl).pathname;
        if ((finalPath === '/' || finalPath === '') && initialPath !== '/' && initialPath !== '') {
          result.redirected = true;
          result.redirectFrom = initialUrl;
          result.redirectReason = 'redirected_to_home';
        } else if (finalUrl.includes('?spm_id_from=') && finalUrl.includes('errorpage')) {
          result.redirected = true;
          result.redirectFrom = initialUrl;
          result.redirectReason = 'redirected_to_home';
        }
      }
    } catch {
      // URL 解析失败，忽略
    }
  }
  
  // 检测页面是否是 404 或错误页面
  const title = result.title.toLowerCase();
  if (title.includes('404') || title.includes('not found') || 
      title.includes('去哪了') || title.includes('error') ||
      title.includes('页面不存在')) {
    result.is404 = true;
    result.redirectReason = '404_page';
  }

  if (timedOut) {
    result.timedOut = true;
    result.warning = 'Navigation timed out, but page may be partially loaded';
    
    // 尝试扫描当前页面状态
    try {
      const s = scanner(kernel);
      if (s) {
        const scanRes = await s.scan();
        result.elements = scanRes.elements;
        result.elementCount = (scanRes.elements || []).length;
        result.partialScan = true;
      }
    } catch {
      // 扫描失败也没关系
    }
  } else if (autoScan) {
    const s = scanner(kernel);
    if (s) {
      const scanRes = await s.scan();
      result.elements = scanRes.elements;
      result.elementCount = (scanRes.elements || []).length;
    }
  }

  // 白屏检测
  const blankCheck = await detectBlankPage(kernel);
  if (blankCheck) {
    if (blankCheck.isBlank) {
      result.isBlank = true;
      result.blankReason = blankCheck.reason;
      if (blankCheck.details) result.blankDetails = blankCheck.details;
    }
    if (blankCheck.isError) {
      result.isError = true;
      result.errorText = blankCheck.errorText;
    }
  }

  return result;
}

/**
 * 等待指定时间
 */
async function wait(kernel, ms) {
  const duration = Number(ms) || 1000;
  if (duration < 0 || duration > 60000) {
    throw new Error('WAIT: duration must be between 0 and 60000 ms');
  }
  await sleep(duration);
  return { waited: duration };
}

async function back(kernel) {
  const page = await kernel.page();
  const resp = await page.goBack({ waitUntil: 'domcontentloaded', timeout: kernel.config.NAVIGATION_TIMEOUT_MS || 45000 });
  if (!resp) await sleep(150);
  return { title: await safeGetTitle(kernel), url: toStr(page.url()) };
}

async function forward(kernel) {
  const page = await kernel.page();
  const resp = await page.goForward({ waitUntil: 'domcontentloaded', timeout: kernel.config.NAVIGATION_TIMEOUT_MS || 45000 });
  if (!resp) await sleep(150);
  return { title: await safeGetTitle(kernel), url: toStr(page.url()) };
}

async function reload(kernel) {
  const page = await kernel.page();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: kernel.config.NAVIGATION_TIMEOUT_MS || 45000 });
  return { title: await safeGetTitle(kernel), url: toStr(page.url()) };
}

async function scroll(kernel, direction) {
  const page = await kernel.page();
  const cdp = await kernel.cdp();

  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const x = Math.floor((viewport.w || 1) / 2);
  const y = Math.floor((viewport.h || 1) / 2);

  const dir = String(direction || '').toLowerCase();
  if (!['up', 'down', 'top', 'bottom'].includes(dir)) throw new Error('SCROLL: invalid direction (up/down/top/bottom)');

  if (dir === 'top') {
    for (let i = 0; i < 10; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -2000, pointerType: 'mouse' }, { timeoutMs: 3000, label: 'scrollTop' });
      await sleep(30);
    }
  } else if (dir === 'bottom') {
    for (let i = 0; i < 10; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 2000, pointerType: 'mouse' }, { timeoutMs: 3000, label: 'scrollBottom' });
      await sleep(30);
    }
  } else {
    const delta = dir === 'up' ? -(viewport.h || 800) * 1.5 : (viewport.h || 800) * 1.5;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: delta, pointerType: 'mouse' }, { timeoutMs: 3000, label: 'scroll' });
  }

  await sleep(120);
  return { direction: dir };
}

// ------------------------------
// Tabs
// ------------------------------
async function listTabs(kernel) {
  const browser = await kernel.browser();
  const pages = await browser.pages();
  const current = await kernel.page();

  const tabs = [];
  for (const p of pages) {
    try {
      if (!p || p.isClosed()) continue;
      const url = toStr(p.url());
      if (url.startsWith('chrome-extension://') || url.startsWith('devtools://')) continue;
      let title = '';
      try { title = await p.title(); } catch {}
      tabs.push({
        id: tabs.length + 1,
        title: title || '(untitled)',
        url: url || 'about:blank',
        active: p === current
      });
    } catch {}
  }
  return { tabs, count: tabs.length };
}

async function switchTab(kernel, tabId) {
  const browser = await kernel.browser();
  const pages = await browser.pages();

  const valid = pages.filter(p => {
    try {
      if (!p || p.isClosed()) return false;
      const u = toStr(p.url());
      if (u.startsWith('chrome-extension://') || u.startsWith('devtools://')) return false;
      return true;
    } catch {
      return false;
    }
  });

  const idx = Number(tabId) - 1;
  if (!Number.isFinite(idx) || idx < 0 || idx >= valid.length) throw new Error(`Invalid tab ID: ${tabId}. Available: 1-${valid.length}`);

  const target = valid[idx];
  await target.bringToFront();
  await sleep(80);
  await kernel.resetPageTo(target);
  await kernel.cdp({ forceNew: true });

  return { switched: true, title: await safeGetTitle(kernel), url: toStr(target.url()) };
}

async function newTab(kernel, url) {
  const browser = await kernel.browser();
  const p = await browser.newPage();
  await kernel.resetPageTo(p);
  await kernel.cdp({ forceNew: true });
  if (url) {
    await p.goto(String(url), { waitUntil: 'networkidle2', timeout: kernel.config.NAVIGATION_TIMEOUT_MS || 45000 });
  }
  return { created: true, title: await safeGetTitle(kernel), url: toStr(p.url()) };
}

async function closeTab(kernel, tabId) {
  const browser = await kernel.browser();
  const pages = await browser.pages();

  const valid = pages.filter(p => {
    try {
      if (!p || p.isClosed()) return false;
      const u = toStr(p.url());
      if (u.startsWith('chrome-extension://') || u.startsWith('devtools://')) return false;
      return true;
    } catch {
      return false;
    }
  });

  if (valid.length <= 1) throw new Error('Cannot close the last tab');

  const idx = Number(tabId) - 1;
  if (!Number.isFinite(idx) || idx < 0 || idx >= valid.length) throw new Error(`Invalid tab ID: ${tabId}. Available: 1-${valid.length}`);

  const target = valid[idx];
  const current = await kernel.page();
  const wasActive = (target === current);

  await target.close();

  if (wasActive) {
    const remaining = valid.filter(p => p !== target && !p.isClosed());
    if (remaining.length) {
      await remaining[0].bringToFront();
      await kernel.resetPageTo(remaining[0]);
      await kernel.cdp({ forceNew: true });
    }
  }

  // Count remaining tabs
  const pagesAfter = await browser.pages();
  const remainingCount = pagesAfter.filter(p => {
    try {
      if (!p || p.isClosed()) return false;
      const u = toStr(p.url());
      return !u.startsWith('chrome-extension://') && !u.startsWith('devtools://');
    } catch { return false; }
  }).length;

  const page = await kernel.page();
  return { closed: tabId, remaining: remainingCount, title: await safeGetTitle(kernel), url: toStr(page.url()) };
}

async function closeOtherTabs(kernel) {
  const browser = await kernel.browser();
  const pages = await browser.pages();

  const valid = pages.filter(p => {
    try {
      if (!p || p.isClosed()) return false;
      const u = toStr(p.url());
      if (u.startsWith('chrome-extension://') || u.startsWith('devtools://')) return false;
      return true;
    } catch {
      return false;
    }
  });

  if (valid.length <= 1) return { closed: 0, remaining: 1 };

  let keep = valid[0];
  for (const p of valid) {
    try {
      const u = toStr(p.url());
      if (u.includes('rewards.bing.com')) { keep = p; break; }
    } catch {}
  }

  let closedCount = 0;
  for (const p of valid) {
    if (p === keep) continue;
    try { await p.close(); closedCount += 1; } catch {}
  }

  await keep.bringToFront();
  await kernel.resetPageTo(keep);
  await kernel.cdp({ forceNew: true });

  await sleep(200);

  return { closed: closedCount, remaining: 1, title: await safeGetTitle(kernel), url: toStr(keep.url()) };
}

// ------------------------------
// clicktext / do / batch
// ------------------------------
async function clickText(kernel, query, { noScan = false, smooth = false } = {}) {
  const s = scanner(kernel);
  if (!s) throw new Error('Scanner service missing');

  const q = String(query || '').trim();
  if (!q) throw new Error('CLICKTEXT: missing text');

  // try viewport scan first
  let res = await s.scan();
  const f = q.toLowerCase();
  let matches = (res.elements || []).filter(e => (e.text || '').toLowerCase().includes(f));

  // fallback: scroll-search
  if (!matches.length) {
    await scroll(kernel, 'top');
    await sleep(250);
    for (let i = 0; i < 12; i++) {
      res = await s.scan();
      matches = (res.elements || []).filter(e => (e.text || '').toLowerCase().includes(f));
      if (matches.length) break;
      await scroll(kernel, 'down');
      await sleep(220);
    }
  }

  if (!matches.length) throw new Error(`CLICKTEXT: element not found: "${q}"`);

  const target = matches[0];
  const inter = interaction(kernel);
  if (!inter) throw new Error('Interaction service missing');

  const clickRes = await inter.clickById(target.id, { smooth });
  const out = { ok: true, cmd: 'CLICKTEXT', query: q, targetId: target.id, ...clickRes };

  if (!noScan) {
    await sleep(350);
    const after = await s.scan();
    out.elements = after.elements;
  }

  return out;
}

async function doCommand(kernel, argv) {
  // do <action> [args...] [--no-scan]
  const args = Array.isArray(argv) ? argv.slice(0) : [];
  if (!args.length) throw new Error('DO: missing action');

  const noScan = args.includes('--no-scan');
  const filtered = args.filter(a => a !== '--no-scan');

  const action = String(filtered[0]).toLowerCase();
  const rest = filtered.slice(1);

  // execute action by delegating to kernel commands
  const actionRes = await kernel.runCommand(action, { argv: rest });
  if (noScan) return { ok: true, cmd: 'DO', action, result: actionRes };

  // wait for settle
  await sleep(450);

  // auto scan
  const s = scanner(kernel);
  const scanRes = s ? await s.scan() : { elements: [] };

  return { ok: true, cmd: 'DO', action, result: actionRes, elements: scanRes.elements || [] };
}

async function batchCommand(kernel, argv) {
  // batch "cmd1 ; cmd2 ; ..."
  const joined = Array.isArray(argv) ? argv.join(' ') : String(argv || '');
  const commands = joined.split(';').map(s => s.trim()).filter(Boolean);
  if (!commands.length) throw new Error('BATCH: no commands');

  const results = [];
  for (const cmdLine of commands) {
    const parts = cmdLine.split(/\s+/).filter(Boolean);
    const cmd = String(parts[0] || '').toLowerCase();
    const args = parts.slice(1);

    try {
      const res = await kernel.runCommand(cmd, { argv: args });
      results.push({ cmd, ok: true, result: res });
    } catch (e) {
      results.push({ cmd, ok: false, error: String(e && e.message ? e.message : e) });
    }

    await sleep(80);
  }

  return { ok: true, cmd: 'BATCH', results };
}

// ------------------------------
// Plugin load
// ------------------------------
async function onLoad(kernel) {
  kernel.registerCommand(meta.name, {
    name: 'ping',
    usage: 'ping',
    description: 'Simple liveness check.',
    handler: async () => ({ ok: true, cmd: 'PING', ts: Date.now() })
  });

  kernel.registerCommand(meta.name, {
    name: 'wait',
    usage: 'wait <ms>',
    description: 'Wait for specified milliseconds (max 60000).',
    handler: async (ctx) => {
      const ms = Number((ctx.argv || [])[0]) || 1000;
      const res = await wait(kernel, ms);
      return { ok: true, cmd: 'WAIT', ...res };
    }
  });

  kernel.registerCommand(meta.name, {
    name: 'status',
    usage: 'status',
    description: 'Get current title and URL.',
    handler: async () => ({ ok: true, cmd: 'STATUS', ...(await status(kernel)) })
  });

  kernel.registerCommand(meta.name, {
    name: 'goto',
    usage: 'goto <url> [--scan]',
    description: 'Navigate to URL.',
    cliOptions: [{ flags: '--scan', description: 'Auto scan after navigation' }],
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const url = argv[0];
      const autoScan = argv.includes('--scan');
      const res = await goto(kernel, url, { autoScan });
      return { ok: true, cmd: 'GOTO', ...res };
    }
  });

  kernel.registerCommand(meta.name, {
    name: 'back',
    usage: 'back',
    description: 'Go back in history.',
    handler: async () => ({ ok: true, cmd: 'BACK', ...(await back(kernel)) })
  });

  kernel.registerCommand(meta.name, {
    name: 'forward',
    usage: 'forward',
    description: 'Go forward in history.',
    handler: async () => ({ ok: true, cmd: 'FORWARD', ...(await forward(kernel)) })
  });

  kernel.registerCommand(meta.name, {
    name: 'reload',
    usage: 'reload',
    description: 'Reload page.',
    handler: async () => ({ ok: true, cmd: 'RELOAD', ...(await reload(kernel)) })
  });

  kernel.registerCommand(meta.name, {
    name: 'scroll',
    usage: 'scroll <up|down|top|bottom> [--scan]',
    description: 'Scroll the page.',
    cliOptions: [{ flags: '--scan', description: 'Scan after scroll' }],
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const dir = argv[0] || '';
      const autoScan = argv.includes('--scan');
      const res = await scroll(kernel, dir);
      if (!autoScan) return { ok: true, cmd: 'SCROLL', ...res };
      const s = scanner(kernel);
      await sleep(250);
      const sc = s ? await s.scan() : { elements: [] };
      return { ok: true, cmd: 'SCROLL', ...res, elements: sc.elements || [] };
    }
  });

  // Screenshot
  kernel.registerCommand(meta.name, {
    name: 'screenshot',
    usage: 'screenshot [filename]',
    description: 'Take a screenshot of the current page.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const filename = argv[0] || `screenshot-${Date.now()}.png`;
      const page = await kernel.page();
      const path = filename.endsWith('.png') ? filename : `${filename}.png`;
      await page.screenshot({ path, fullPage: false });
      return { ok: true, cmd: 'SCREENSHOT', path, title: await safeGetTitle(kernel), url: toStr(page.url()) };
    }
  });

  // Tabs
  kernel.registerCommand(meta.name, {
    name: 'tabs',
    usage: 'tabs',
    description: 'List tabs.',
    handler: async () => ({ ok: true, cmd: 'TABS', ...(await listTabs(kernel)) })
  });

  kernel.registerCommand(meta.name, {
    name: 'tab',
    usage: 'tab <id>',
    description: 'Switch to tab by ID.',
    handler: async (ctx) => {
      const id = Number((ctx.argv || [])[0]);
      if (!Number.isFinite(id) || id <= 0) throw new Error('TAB: invalid id');
      const res = await switchTab(kernel, id);
      return { ok: true, cmd: 'TAB', ...res };
    }
  });

  kernel.registerCommand(meta.name, {
    name: 'newtab',
    usage: 'newtab [url]',
    description: 'Open a new tab, optionally navigating.',
    handler: async (ctx) => {
      const url = (ctx.argv || [])[0] || '';
      const res = await newTab(kernel, url || null);
      return { ok: true, cmd: 'NEWTAB', ...res };
    }
  });

  kernel.registerCommand(meta.name, {
    name: 'closetab',
    usage: 'closetab <id>',
    description: 'Close tab by ID.',
    handler: async (ctx) => {
      const id = Number((ctx.argv || [])[0]);
      if (!Number.isFinite(id) || id <= 0) throw new Error('CLOSETAB: invalid id');
      const res = await closeTab(kernel, id);
      return { ok: true, cmd: 'CLOSETAB', ...res };
    }
  });

  kernel.registerCommand(meta.name, {
    name: 'close',
    usage: 'close',
    description: 'Close current tab.',
    handler: async () => {
      // Find current tab index
      const browser = await kernel.browser();
      const pages = await browser.pages();
      const current = await kernel.page();
      
      const valid = pages.filter(p => {
        try {
          if (!p || p.isClosed()) return false;
          const u = toStr(p.url());
          if (u.startsWith('chrome-extension://') || u.startsWith('devtools://')) return false;
          return true;
        } catch { return false; }
      });
      
      const idx = valid.indexOf(current);
      if (idx < 0) throw new Error('CLOSE: cannot find current tab');
      
      const res = await closeTab(kernel, idx + 1);
      return { ok: true, cmd: 'CLOSE', ...res };
    }
  });

  kernel.registerCommand(meta.name, {
    name: 'closeothertabs',
    usage: 'closeothertabs',
    description: 'Close all tabs except one (prefers rewards.bing.com).',
    handler: async () => ({ ok: true, cmd: 'CLOSEOTHERTABS', ...(await closeOtherTabs(kernel)) })
  });

  // clicktext
  kernel.registerCommand(meta.name, {
    name: 'clicktext',
    usage: 'clicktext <text> [--no-scan] [--smooth]',
    description: 'Find element by text and click it (auto-scroll).',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const noScan = argv.includes('--no-scan');
      const smooth = argv.includes('--smooth');
      const query = argv.filter(a => !a.startsWith('--')).join(' ');
      return await clickText(kernel, query, { noScan, smooth });
    }
  });

  // do
  kernel.registerCommand(meta.name, {
    name: 'do',
    usage: 'do <command> [args...] [--no-scan]',
    description: 'Composite: run a command, wait, then scan (unless --no-scan).',
    handler: async (ctx) => doCommand(kernel, ctx.argv || [])
  });

  // batch
  kernel.registerCommand(meta.name, {
    name: 'batch',
    usage: 'batch "<cmd1> ; <cmd2> ; ..."',
    description: 'Execute multiple commands separated by semicolons.',
    handler: async (ctx) => batchCommand(kernel, ctx.argv || [])
  });
}

async function onUnload(kernel) {}

module.exports = {
  meta,
  onLoad,
  onUnload
};
