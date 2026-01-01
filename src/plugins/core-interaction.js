'use strict';

/**
 * core-interaction plugin:
 * - Converts element IDs from core-scanner into robust click/type/hover/select actions.
 * - Uses Bezier mouse movement for human-like behavior.
 * - Avoids blind sleeps where possible; relies on CDP timeouts + navigation signals.
 *
 * Important: For robust coordinates (especially in same-origin iframes),
 * we compute points using Runtime.callFunctionOn to bubble frameElement offsets.
 */

const { toStr } = require('../utils/strings');
const { sleep } = require('../utils/async');
const { isRetryableError, isCircuitBreakerError } = require('../utils/errors');

const meta = {
  name: 'core-interaction',
  description: 'Mouse/keyboard simulation + element actions (click/type/hover/select)',
  cliOptions: [
    { flags: '--smooth', description: 'Use smooth mouse movement (Bezier curve)' }
  ]
};

/**
 * 规范化 URL 用于比较（忽略末尾斜杠差异）
 * 例如: /video/BV123 和 /video/BV123/ 应该被视为相同
 */
function normalizeUrlForCompare(url) {
  if (!url) return '';
  // 移除末尾斜杠（但保留根路径的斜杠）
  try {
    const u = new URL(url);
    // 只处理路径部分的末尾斜杠，保留查询参数和 hash
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch {
    // 如果 URL 解析失败，简单移除末尾斜杠
    return url.replace(/\/+$/, '') || url;
  }
}

/**
 * 检查 URL 是否已在重定向链中（忽略末尾斜杠差异）
 */
function isUrlInChain(chain, url) {
  const normalizedUrl = normalizeUrlForCompare(url);
  return chain.some(u => normalizeUrlForCompare(u) === normalizedUrl);
}

function scanner(kernel) {
  const svc = kernel.getService('scanner');
  if (!svc) throw new Error('Scanner service missing: core-scanner not loaded');
  return svc;
}

// ------------------------------
// Bezier mouse movement
// ------------------------------
function generateBezierPath(x1, y1, x2, y2, steps = 20) {
  const cx1 = x1 + (x2 - x1) * 0.25 + (Math.random() - 0.5) * 100;
  const cy1 = y1 + (y2 - y1) * 0.10 + (Math.random() - 0.5) * 100;
  const cx2 = x1 + (x2 - x1) * 0.75 + (Math.random() - 0.5) * 100;
  const cy2 = y1 + (y2 - y1) * 0.90 + (Math.random() - 0.5) * 100;

  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;

    const x = mt3 * x1 + 3 * mt2 * t * cx1 + 3 * mt * t2 * cx2 + t3 * x2;
    const y = mt3 * y1 + 3 * mt2 * t * cy1 + 3 * mt * t2 * cy2 + t3 * y2;

    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
}

let _lastMousePos = null;

async function dispatchMouseMove(kernel, x, y, smooth = false) {
  try {
    const cdp = await kernel.cdp();
    if (smooth && _lastMousePos) {
      const path = generateBezierPath(_lastMousePos.x, _lastMousePos.y, x, y, 10 + Math.floor(Math.random() * 10));
      for (const p of path) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0, pointerType: 'mouse' }, { timeoutMs: 1500, label: 'mouseMove' });
        await sleep(5 + Math.random() * 10);
      }
    } else {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' }, { timeoutMs: 1500, label: 'mouseMove' });
    }
  } catch (e) {
    // Fallback to Puppeteer mouse
    const page = await kernel.page();
    await page.mouse.move(x, y);
  }
  _lastMousePos = { x, y };
}

async function dispatchClick(kernel, x, y, opts = {}) {
  const { debug = false } = opts;
  try {
    const cdp = await kernel.cdp();
    
    // 调试模式：在点击前检查坐标处的元素
    if (debug) {
      await cdp.enable('Runtime');
      const checkResult = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.elementFromPoint(${x}, ${y});
          if (!el) return { found: false };
          return {
            found: true,
            tag: el.tagName,
            id: el.id || '',
            className: el.className || '',
            text: (el.innerText || el.textContent || '').substring(0, 50).trim(),
            rect: (() => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()
          };
        })()`,
        returnByValue: true
      }, { timeoutMs: 2000, label: 'debugElementAtPoint' });
      console.log('[DEBUG] Click at', x, y, '-> element:', checkResult.result?.value);
    }
    
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }, { timeoutMs: 1500, label: 'mouseDown' });
    await sleep(40);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }, { timeoutMs: 1500, label: 'mouseUp' });
  } catch (e) {
    // Fallback to Puppeteer mouse
    const page = await kernel.page();
    await page.mouse.click(x, y);
  }
}

async function dispatchChar(kernel, ch) {
  try {
    const cdp = await kernel.cdp();
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch }, { timeoutMs: 1500, label: 'keyChar' });
  } catch (e) {
    // Fallback to Puppeteer keyboard
    const page = await kernel.page();
    await page.keyboard.type(ch);
  }
}

async function dispatchEnter(kernel) {
  // Prefer Puppeteer keyboard (more reliable)
  const page = await kernel.page();
  try {
    await page.keyboard.press('Enter');
    return;
  } catch {
    // fallback to CDP
  }
  const cdp = await kernel.cdp();
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, { timeoutMs: 1500, label: 'enterDown' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, { timeoutMs: 1500, label: 'enterUp' });
}

// ------------------------------
// Element resolution + point computation
// ------------------------------

async function scrollIntoViewById(kernel, id) {
  const s = scanner(kernel);
  const node = s.getNodeMeta(id);
  if (!node) throw new Error('ACT: unknown_id');

  // 优先使用 DOM.resolveNode + scrollIntoView（更准确）
  const cdp = await kernel.cdp();
  try {
    await cdp.enable('DOM');
    await cdp.enable('Runtime');

    const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId }, { timeoutMs: 3000, label: 'DOM.resolveNode(scroll)' });
    const obj = resolved && resolved.object ? resolved.object : null;
    
    if (obj && obj.objectId) {
      await cdp.send('Runtime.callFunctionOn', {
        objectId: obj.objectId,
        functionDeclaration: `function() {
          try {
            const el = this;
            try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
            catch { try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {} }
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
          }
        }`,
        returnByValue: true
      }, { timeoutMs: 3000, label: 'scrollIntoViewById' });
      return;
    }
  } catch {
    // DOM 方式失败，尝试 Puppeteer 方式
  }

  // Fallback: 使用 Puppeteer 的 page.evaluate 滚动到大概位置
  // 注意：这里的坐标是扫描时的视口坐标，可能不准确
  if (node.x !== undefined && node.y !== undefined) {
    const page = await kernel.page();
    try {
      // 获取当前滚动位置，计算元素的绝对位置
      await page.evaluate((x, y) => {
        // 滚动到让元素在视口中心
        window.scrollBy({
          left: 0,
          top: y - window.innerHeight / 2,
          behavior: 'instant'
        });
      }, node.x, node.y);
    } catch {
      // 忽略错误
    }
  }
}

async function computePointById(kernel, id, opts = {}) {
  const s = scanner(kernel);
  const node = s.getNodeMeta(id);
  if (!node) throw new Error('ACT: unknown_id');
  
  const maxRetries = opts.maxRetries || 3;
  const autoScroll = opts.autoScroll !== false;

  // 优先使用 CDP 方式获取精确坐标
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const cdp = await kernel.cdp();
      await cdp.enable('DOM');
      await cdp.enable('Runtime');

      const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId }, { timeoutMs: 3000, label: 'DOM.resolveNode(point)' });
      const obj = resolved && resolved.object ? resolved.object : null;
      
      if (obj && obj.objectId) {
        const res = await cdp.send('Runtime.callFunctionOn', {
          objectId: obj.objectId,
          functionDeclaration: `function() {
            try {
              const el = this;
              if (!el || !el.getBoundingClientRect) return { ok: false, error: 'no_rect' };

              const r = el.getBoundingClientRect();
              if (!r || r.width < 3 || r.height < 3) return { ok: false, error: 'too_small' };

              // getBoundingClientRect 返回的是相对于视口的坐标
              const cx = Math.floor(r.left + Math.max(1, Math.min(r.width * 0.5, r.width - 1)));
              const cy = Math.floor(r.top + Math.max(1, Math.min(r.height * 0.5, r.height - 1)));
              
              // 获取视口尺寸
              const vw = window.innerWidth || document.documentElement.clientWidth;
              const vh = window.innerHeight || document.documentElement.clientHeight;
              
              // 检查是否在视口内
              const inViewport = cx >= 0 && cx < vw && cy >= 0 && cy < vh;

              return {
                ok: true,
                x: cx,
                y: cy,
                inViewport,
                viewport: { width: vw, height: vh },
                rect: {
                  left: Math.round(r.left),
                  top: Math.round(r.top),
                  width: Math.round(r.width),
                  height: Math.round(r.height)
                }
              };
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) };
            }
          }`,
          returnByValue: true
        }, { timeoutMs: 3000, label: 'computePointById' });

        const v = res && res.result ? res.result.value : null;
        if (v && v.ok === true) {
          // 如果坐标在视口外，尝试滚动
          if (!v.inViewport && autoScroll && attempt < maxRetries - 1) {
            await scrollIntoViewById(kernel, id);
            await sleep(150); // 等待滚动完成
            continue; // 重新计算坐标
          }
          return { x: Number(v.x), y: Number(v.y), rect: v.rect || null, inViewport: v.inViewport };
        }
      }
    } catch {
      // CDP 方式失败，尝试 Puppeteer 方式
    }
    break; // 如果不是视口问题，不重试
  }

  // Fallback: 使用 Puppeteer 的 page.evaluate 获取元素位置
  // 通过元素的 text 内容查找
  if (node.text) {
    const page = await kernel.page();
    try {
      const point = await page.evaluate((text, role) => {
        // 尝试通过 text 内容查找元素
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let el = walker.nextNode();
        while (el) {
          const elText = (el.innerText || el.textContent || '').trim();
          if (elText && elText.includes(text.substring(0, 30))) {
            const r = el.getBoundingClientRect();
            if (r.width > 5 && r.height > 5) {
              return {
                ok: true,
                x: Math.floor(r.left + r.width / 2),
                y: Math.floor(r.top + r.height / 2),
                rect: { left: r.left, top: r.top, width: r.width, height: r.height }
              };
            }
          }
          el = walker.nextNode();
        }
        return { ok: false };
      }, node.text, node.role);

      if (point && point.ok) {
        return { x: point.x, y: point.y, rect: point.rect };
      }
    } catch {
      // 忽略错误
    }
  }

  // 最后的 fallback: 使用扫描时的坐标（可能不准确）
  if (node.x !== undefined && node.y !== undefined) {
    return {
      x: node.x,
      y: node.y,
      rect: { left: node.x, top: node.y, width: node.w || 10, height: node.h || 10 }
    };
  }

  throw new Error('ACT: cannot compute click point');
}

async function ensureScanMap(kernel) {
  const s = scanner(kernel);
  const last = s.getLastScan();
  if (!last || !Array.isArray(last.elements) || last.elements.length === 0) {
    // 如果 breaker 是 open 的，先重置
    try {
      await s.scan();
    } catch (e) {
      if (isCircuitBreakerError(e)) {
        kernel.resetBreaker();
        await s.scan();
      } else {
        throw e;
      }
    }
  }
}

/**
 * 解析选择器：支持 id 或 text
 * - 纯数字：按 id
 * - 字符串：按 text 查找（自动扫描）
 * 返回 { id, text, element }
 */
async function resolveSelector(kernel, selector) {
  const s = scanner(kernel);
  
  // 如果是数字，直接用 id
  const numId = Number(selector);
  if (Number.isFinite(numId) && numId > 0) {
    await ensureScanMap(kernel);
    const el = s.getNodeMeta(numId);
    if (!el) throw new Error(`ACT: element id ${numId} not found`);
    return { id: numId, element: el };
  }
  
  // 否则按 text 查找
  const text = String(selector).trim();
  if (!text) throw new Error('ACT: empty selector');
  
  // 先扫描
  const scanRes = await s.scan();
  const elements = scanRes.elements || [];
  
  // 精确匹配
  let match = elements.find(e => (e.text || '').trim() === text);
  
  // 如果没有精确匹配，尝试包含匹配
  if (!match) {
    const lowerText = text.toLowerCase();
    match = elements.find(e => (e.text || '').toLowerCase().includes(lowerText));
  }
  
  // 如果 AXTree 没找到，尝试 DOM 查询
  if (!match) {
    const page = await kernel.page();
    try {
      const domResult = await page.evaluate((searchText) => {
        // 查找包含文本的可点击元素
        const lowerSearch = searchText.toLowerCase();
        const clickable = document.querySelectorAll('a, button, [role="button"], [role="link"], input[type="submit"], [onclick]');
        
        for (const el of clickable) {
          const elText = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
          if (elText.includes(lowerSearch)) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 5 && rect.height > 5) {
              // 先滚动到元素
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              // 重新获取坐标
              const newRect = el.getBoundingClientRect();
              return {
                found: true,
                x: Math.floor(newRect.left + newRect.width / 2),
                y: Math.floor(newRect.top + newRect.height / 2),
                text: (el.innerText || el.textContent || '').substring(0, 50).trim(),
                tag: el.tagName.toLowerCase()
              };
            }
          }
        }
        
        // 也搜索 h2, h3 等标题元素
        const headings = document.querySelectorAll('h1, h2, h3, h4, [class*="title"], span[class*="product"], span[class*="item"]');
        for (const el of headings) {
          const elText = (el.innerText || el.textContent || '').toLowerCase();
          if (elText.includes(lowerSearch)) {
            // 找到标题后，尝试找它的父级链接
            let linkEl = el.closest('a') || el.querySelector('a');
            if (!linkEl) linkEl = el;
            
            // 先滚动到元素
            linkEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            // 重新获取坐标
            const rect = linkEl.getBoundingClientRect();
            if (rect.width > 5 && rect.height > 5) {
              return {
                found: true,
                x: Math.floor(rect.left + rect.width / 2),
                y: Math.floor(rect.top + rect.height / 2),
                text: (el.innerText || el.textContent || '').substring(0, 50).trim(),
                tag: linkEl.tagName.toLowerCase()
              };
            }
          }
        }
        
        return { found: false };
      }, text);
      
      if (domResult && domResult.found) {
        // 等待滚动完成
        await sleep(150);
        // 创建一个虚拟元素用于点击
        return {
          id: -1, // 特殊 ID 表示 DOM 查询结果
          text: domResult.text,
          element: {
            x: domResult.x,
            y: domResult.y,
            text: domResult.text,
            type: domResult.tag,
            _domFound: true
          }
        };
      }
    } catch {
      // DOM 查询失败，继续抛出原始错误
    }
  }
  
  if (!match) {
    throw new Error(`ACT: element with text "${text}" not found`);
  }
  
  return { id: match.id, text, element: match };
}

// ------------------------------
// Actions
// ------------------------------

async function clickById(kernel, id, opts = {}) {
  const smooth = !!opts.smooth;
  const useJs = !!opts.useJs; // 使用 JS click() 而不是模拟鼠标
  
  // 确保有 scan 结果（--js 模式下如果已有结果则跳过）
  const s = scanner(kernel);
  const last = s.getLastScan();
  if (!last || !Array.isArray(last.elements) || last.elements.length === 0) {
    await ensureScanMap(kernel);
  }

  // Record state before click
  const browser = await kernel.browser();
  const pagesBefore = await browser.pages();
  const countBefore = pagesBefore.filter(p => {
    try {
      if (!p || p.isClosed()) return false;
      const u = toStr(p.url());
      return !u.startsWith('chrome-extension://') && !u.startsWith('devtools://');
    } catch { return false; }
  }).length;

  // Get URL before click from the page we're about to click on
  const pageBefore = await kernel.page();
  const urlBefore = toStr(pageBefore.url());
  
  // 设置 CDP Network 监听来追踪重定向链
  const cdp = await kernel.cdp();
  const redirectChain = [];
  let mainFrameId = null;
  let mainRequestId = null;
  
  await cdp.enable('Network');
  await cdp.enable('Page');
  
  const requestHandler = (params) => {
    // 只追踪主框架的文档请求
    if (params.type === 'Document' && params.requestId) {
      const reqUrl = params.request && params.request.url;
      if (reqUrl && 
          (reqUrl.startsWith('http://') || reqUrl.startsWith('https://')) &&
          !reqUrl.includes('browser.pipe.aria.microsoft.com') &&
          !reqUrl.includes('chrome-extension://') &&
          !reqUrl.includes('edge://')) {
        
        if (!mainFrameId) {
          mainFrameId = params.frameId;
          mainRequestId = params.requestId;
        }
        
        // 只追踪主请求链（使用 isUrlInChain 忽略末尾斜杠差异）
        if (params.requestId === mainRequestId || 
            (params.redirectResponse && redirectChain.length > 0)) {
          if (!isUrlInChain(redirectChain, reqUrl)) {
            redirectChain.push(reqUrl);
          }
          mainRequestId = params.requestId;
        }
      }
    }
  };
  
  const redirectHandler = (params) => {
    if (params.redirectResponse && params.requestId === mainRequestId) {
      const redirUrl = params.redirectResponse.url;
      const newUrl = params.request && params.request.url;
      
      // 使用 isUrlInChain 忽略末尾斜杠差异
      if (redirUrl && !isUrlInChain(redirectChain, redirUrl) &&
          !redirUrl.includes('browser.pipe.aria.microsoft.com')) {
        if (redirectChain.length === 0 || normalizeUrlForCompare(redirectChain[redirectChain.length - 1]) !== normalizeUrlForCompare(redirUrl)) {
          redirectChain.push(redirUrl);
        }
      }
      
      if (newUrl && !isUrlInChain(redirectChain, newUrl) &&
          !newUrl.includes('browser.pipe.aria.microsoft.com') &&
          (newUrl.startsWith('http://') || newUrl.startsWith('https://'))) {
        redirectChain.push(newUrl);
      }
      
      mainRequestId = params.requestId;
    }
  };
  
  cdp.on('Network.requestWillBeSent', requestHandler);
  cdp.on('Network.requestWillBeSent', redirectHandler);

  const attempt = async () => {
    // 如果使用 JS 点击，直接调用 element.click()，跳过坐标计算
    if (useJs) {
      const s = scanner(kernel);
      const node = s.getNodeMeta(id);
      const cdp = await kernel.cdp();
      await cdp.enable('DOM');
      await cdp.enable('Runtime');
      
      // 策略1: 使用 backendDOMNodeId
      if (node && node.backendDOMNodeId) {
        try {
          const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId }, { timeoutMs: 3000, label: 'DOM.resolveNode(jsClick)' });
          if (resolved && resolved.object && resolved.object.objectId) {
            await cdp.send('Runtime.callFunctionOn', {
              objectId: resolved.object.objectId,
              functionDeclaration: `function() { 
                try { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch {}
              }`,
              returnByValue: true
            }, { timeoutMs: 3000, label: 'jsScrollIntoView' });
            
            await sleep(100);
            
            await cdp.send('Runtime.callFunctionOn', {
              objectId: resolved.object.objectId,
              functionDeclaration: `function() { this.click(); }`,
              returnByValue: true
            }, { timeoutMs: 3000, label: 'jsClick' });
            
            return { action: 'click', id, jsClick: true, method: 'backendNodeId' };
          }
        } catch {
          // backendDOMNodeId 失效，重置 breaker 以便后续策略能执行
          kernel.resetBreaker();
        }
      }
      
      // 策略2: 通过元素文本内容查找并点击
      if (node && node.text) {
        try {
          const searchText = (node.text || '').substring(0, 50).trim();
          const role = (node.role || '').toLowerCase();
          
          const jsClickResult = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
              const searchText = ${JSON.stringify(searchText)};
              const role = ${JSON.stringify(role)};
              
              // 根据 role 确定要搜索的元素类型
              let selectors = ['button', 'a', '[role="button"]', '[role="link"]', 'input[type="submit"]', 'input[type="button"]'];
              if (role === 'link') selectors = ['a', '[role="link"]'];
              else if (role === 'button') selectors = ['button', '[role="button"]', 'input[type="submit"]', 'input[type="button"]'];
              
              for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                for (const el of elements) {
                  const elText = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
                  if (elText && (elText === searchText || elText.includes(searchText) || searchText.includes(elText))) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                      el.click();
                      return { ok: true, text: elText.substring(0, 50), tag: el.tagName };
                    }
                  }
                }
              }
              
              // 如果按 role 没找到，尝试更广泛的搜索
              const allClickable = document.querySelectorAll('button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"], [onclick]');
              for (const el of allClickable) {
                const elText = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
                if (elText && (elText === searchText || elText.includes(searchText) || searchText.includes(elText))) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                    el.click();
                    return { ok: true, text: elText.substring(0, 50), tag: el.tagName };
                  }
                }
              }
              
              return { ok: false, error: 'element_not_found' };
            })()`,
            returnByValue: true
          }, { timeoutMs: 5000, label: 'jsClickByText' });
          
          const v = jsClickResult.result?.value;
          if (v && v.ok) {
            return { action: 'click', id, jsClick: true, method: 'textSearch', matchedText: v.text, tag: v.tag };
          }
        } catch {
          // 文本搜索失败，尝试下一个策略
        }
      }
      
      // 策略3: 通过坐标找到元素并用 JS 点击（避免触发原生行为）
      try {
        await scrollIntoViewById(kernel, id);
        await sleep(150);
        const { x, y } = await computePointById(kernel, id, { autoScroll: true, maxRetries: 2 });
        
        const jsClickResult = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const el = document.elementFromPoint(${x}, ${y});
            if (!el) return { ok: false, error: 'no_element_at_point' };
            
            // 找到最近的可点击祖先
            let clickTarget = el;
            let current = el;
            while (current && current !== document.body) {
              if (current.tagName === 'BUTTON' || current.tagName === 'A' || 
                  current.getAttribute('role') === 'button' || current.getAttribute('role') === 'link' ||
                  current.onclick || current.hasAttribute('onclick')) {
                clickTarget = current;
                break;
              }
              current = current.parentElement;
            }
            
            clickTarget.click();
            return { ok: true, tag: clickTarget.tagName, text: (clickTarget.innerText || '').substring(0, 50) };
          })()`,
          returnByValue: true
        }, { timeoutMs: 3000, label: 'jsClickByCoord' });
        
        const v = jsClickResult.result?.value;
        if (v && v.ok) {
          return { action: 'click', id, jsClick: true, method: 'coordinate', x, y, tag: v.tag };
        }
      } catch {
        // 坐标点击也失败
      }
      
      // 所有 JS 点击策略都失败，抛出错误而不是回退到鼠标点击
      throw new Error('JS click failed: element not found or not clickable. Try re-scanning with "scan" command.');
    }
    
    // 普通鼠标点击
    await scrollIntoViewById(kernel, id);
    await sleep(150); // 增加等待时间让滚动完成
    
    // computePointById 现在会自动检测视口并重试滚动
    const { x, y, rect, inViewport } = await computePointById(kernel, id, { autoScroll: true, maxRetries: 3 });
    
    // 如果仍然不在视口内，记录警告但继续尝试点击
    if (!inViewport) {
      // 最后一次尝试强制滚动到元素
      const page = await kernel.page();
      try {
        await page.evaluate((targetY) => {
          window.scrollBy({ top: targetY - window.innerHeight / 2, behavior: 'instant' });
        }, y);
        await sleep(100);
      } catch {}
    }
    
    await dispatchMouseMove(kernel, x, y, smooth);
    await dispatchClick(kernel, x, y);
    return { action: 'click', id, x, y, rect };
  };

  let res = null;
  try {
    res = await attempt();
  } catch (e) {
    if (isCircuitBreakerError(e)) {
      // 重置 circuit breaker，重新扫描，然后重试
      kernel.resetBreaker();
      await scanner(kernel).scan();
      res = await attempt();
    } else if (isRetryableError(e)) {
      await kernel.cdp({ forceNew: true });
      res = await attempt();
    } else {
      throw e;
    }
  }

  // Wait for potential new tab or navigation - 使用多次检测
  // 某些网站（如 XVideos）导航可能比较慢
  let urlAfterClick = urlBefore;
  let newTabOpened = false;
  let validPagesAfter = [];
  
  // 增加检测次数和等待时间
  for (let i = 0; i < 5; i++) {
    await sleep(250);
    
    // 检查当前页面 URL
    const currentPage = await kernel.page();
    urlAfterClick = toStr(currentPage.url());
    if (urlAfterClick !== urlBefore) {
      break; // URL 变了，导航成功
    }
    
    // 检查是否有新标签页
    const pagesAfter = await browser.pages();
    validPagesAfter = pagesAfter.filter(p => {
      try {
        if (!p || p.isClosed()) return false;
        const u = toStr(p.url());
        return !u.startsWith('chrome-extension://') && !u.startsWith('devtools://');
      } catch { return false; }
    });
    
    if (validPagesAfter.length > countBefore) {
      newTabOpened = true;
      // 等待新标签页加载一点内容
      await sleep(200);
      break;
    }
  }

  // 检查是否导航了
  if (urlAfterClick !== urlBefore) {
    res.navigated = true;
    res.newUrl = urlAfterClick;
    return res;
  }

  // 如果原页面没有导航，检查是否打开了新标签页
  if (newTabOpened) {
    // 重新获取页面列表，确保获取最新状态
    const pagesNow = await browser.pages();
    const validPagesNow = pagesNow.filter(p => {
      try {
        if (!p || p.isClosed()) return false;
        const u = toStr(p.url());
        return !u.startsWith('chrome-extension://') && !u.startsWith('devtools://');
      } catch { return false; }
    });
    
    // 找到新打开的标签页（不在 pagesBefore 中的）
    let newPage = null;
    for (const p of validPagesNow) {
      const pUrl = toStr(p.url());
      // 检查这个页面是否是新的（URL 不在之前的列表中，或者是最后一个页面）
      const isNew = !pagesBefore.some(pb => {
        try {
          return pb === p || toStr(pb.url()) === pUrl;
        } catch { return false; }
      });
      if (isNew && pUrl !== 'about:blank') {
        newPage = p;
        break;
      }
    }
    
    // 如果没找到明确的新页面，使用最后一个页面
    if (!newPage && validPagesNow.length > countBefore) {
      newPage = validPagesNow[validPagesNow.length - 1];
    }
    
    if (newPage) {
      res.newTab = true;
      res.newUrl = toStr(newPage.url());
      await kernel.resetPageTo(newPage);
      
      // 新标签页需要重新设置 CDP 监听
      const newCdp = await kernel.cdp({ forceNew: true });
      await newCdp.enable('Network');
    }
  }
  
  // 清理 CDP 监听器
  try {
    cdp.off('Network.requestWillBeSent', requestHandler);
    cdp.off('Network.requestWillBeSent', redirectHandler);
  } catch {}

  // 如果有导航或新标签页，检测 404 和跳转链
  if (res.navigated || res.newTab) {
    const currentPage = await kernel.page();
    const finalUrl = toStr(currentPage.url());
    
    // 确保最终 URL 在链中（使用 isUrlInChain 忽略末尾斜杠差异）
    if (finalUrl && !isUrlInChain(redirectChain, finalUrl)) {
      redirectChain.push(finalUrl);
    }
    
    // 等待页面稳定，检测可能的 JS 跳转
    let lastUrl = finalUrl;
    for (let hop = 0; hop < 2; hop++) {
      await sleep(400);
      const nowUrl = toStr(currentPage.url());
      // 使用 normalizeUrlForCompare 比较，忽略末尾斜杠差异
      if (normalizeUrlForCompare(nowUrl) !== normalizeUrlForCompare(lastUrl) && nowUrl !== 'about:blank') {
        if (!isUrlInChain(redirectChain, nowUrl)) {
          redirectChain.push(nowUrl);
        }
        lastUrl = nowUrl;
      } else {
        break;
      }
    }
    
    // 如果有多次跳转，记录跳转链
    if (redirectChain.length > 1) {
      res.redirectChain = redirectChain;
      res.finalUrl = redirectChain[redirectChain.length - 1];
      res.hopCount = redirectChain.length;
    } else if (redirectChain.length === 1) {
      res.finalUrl = redirectChain[0];
    }
    
    // 检测 404 页面
    try {
      let title = '';
      try { title = await currentPage.title(); } catch {}
      const lowerTitle = (title || '').toLowerCase();
      const currentUrl = toStr(currentPage.url());
      
      // 检测 404 关键词
      const is404ByTitle = lowerTitle.includes('404') || 
                           lowerTitle.includes('not found') || 
                           lowerTitle.includes('去哪了') || 
                           lowerTitle.includes('error') ||
                           lowerTitle.includes('页面不存在') ||
                           lowerTitle.includes('does not exist');
      
      // 检测 URL 中的错误标识
      const is404ByUrl = currentUrl.includes('errorpage') || 
                         currentUrl.includes('/404') ||
                         currentUrl.includes('error=') ||
                         currentUrl.includes('notfound');
      
      // 检测是否跳转到首页（可能是 404 重定向）
      let redirectedToHome = false;
      try {
        const originalUrl = res.newUrl || urlAfterClick;
        if (originalUrl && currentUrl) {
          const origPath = new URL(originalUrl).pathname;
          const currPath = new URL(currentUrl).pathname;
          const origHost = new URL(originalUrl).hostname;
          const currHost = new URL(currentUrl).hostname;
          
          // 如果原始路径不是首页，但最终跳转到了首页
          if (origPath !== '/' && origPath !== '' && (currPath === '/' || currPath === '')) {
            redirectedToHome = true;
          }
          // 如果域名变了
          if (origHost !== currHost) {
            res.domainChanged = true;
            res.originalDomain = origHost;
            res.finalDomain = currHost;
          }
        }
      } catch {}
      
      if (is404ByTitle || is404ByUrl) {
        res.is404 = true;
        res.errorTitle = title;
      }
      
      if (redirectedToHome && !res.is404) {
        res.redirectedToHome = true;
        res.warning = 'Page redirected to homepage (possible 404)';
      }
      
      // 更新最终 URL
      res.finalUrl = currentUrl;
      res.finalTitle = title;
      
    } catch {
      // 检测失败，忽略
    }
  }

  return res;
}

async function typeById(kernel, id, text, opts = {}) {
  await ensureScanMap(kernel);
  const pressEnter = !!opts.pressEnter;

  // 如果要按 Enter，记录当前 URL 用于检测导航
  let urlBefore = '';
  if (pressEnter) {
    const pageBefore = await kernel.page();
    urlBefore = toStr(pageBefore.url());
  }

  const attempt = async () => {
    await scrollIntoViewById(kernel, id);
    await sleep(150);
    const { x, y, rect } = await computePointById(kernel, id, { autoScroll: true, maxRetries: 3 });
    await dispatchMouseMove(kernel, x, y, false);
    await dispatchClick(kernel, x, y);

    // type char-by-char (CDP)
    for (const ch of String(text || '')) {
      if (ch === '\n') await dispatchEnter(kernel);
      else if (ch === '\r') continue;
      else await dispatchChar(kernel, ch);
    }
    if (pressEnter) await dispatchEnter(kernel);
    return { action: 'type', id, typed: String(text || ''), pressEnter, rect };
  };

  let res;
  try {
    res = await attempt();
  } catch (e) {
    if (isCircuitBreakerError(e)) {
      // 重置 circuit breaker，重新扫描，然后重试
      kernel.resetBreaker();
      await scanner(kernel).scan();
      res = await attempt();
    } else if (isRetryableError(e)) {
      await kernel.cdp({ forceNew: true });
      res = await attempt();
    } else {
      throw e;
    }
  }

  // 如果按了 Enter，检测导航
  if (pressEnter) {
    await sleep(800); // 增加等待时间
    const pageBefore = await kernel.page();
    const urlAfter = toStr(pageBefore.url());
    if (urlAfter !== urlBefore) {
      res.navigated = true;
      res.newUrl = urlAfter;
    }
  }

  return res;
}

async function clearById(kernel, id) {
  await ensureScanMap(kernel);

  const attempt = async () => {
    await scrollIntoViewById(kernel, id);
    await sleep(150);
    const { x, y, rect } = await computePointById(kernel, id, { autoScroll: true, maxRetries: 3 });
    await dispatchMouseMove(kernel, x, y, false);
    await dispatchClick(kernel, x, y);
    await sleep(40);

    // Try to clear via page JS (more reliable)
    const cdp = await kernel.cdp();
    await cdp.enable('DOM');
    await cdp.enable('Runtime');

    const s = scanner(kernel);
    const node = s.getNodeMeta(id);
    const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId }, { timeoutMs: 3000, label: 'DOM.resolveNode(clear)' });
    const obj = resolved && resolved.object ? resolved.object : null;
    if (obj && obj.objectId) {
      await cdp.send('Runtime.callFunctionOn', {
        objectId: obj.objectId,
        functionDeclaration: `function() {
          try {
            const el = this;
            if (!el) return;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
              try { el.select(); } catch {}
              el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (el.isContentEditable) {
              el.innerText = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
          } catch {}
        }`,
        returnByValue: true
      }, { timeoutMs: 3000, label: 'clear(callFunctionOn)' });
    }

    return { action: 'clear', id, rect };
  };

  try {
    return await attempt();
  } catch (e) {
    if (isRetryableError(e)) {
      await kernel.cdp({ forceNew: true });
      return await attempt();
    }
    throw e;
  }
}

async function hoverById(kernel, id, opts = {}) {
  await ensureScanMap(kernel);
  const smooth = !!opts.smooth;

  const attempt = async () => {
    await scrollIntoViewById(kernel, id);
    await sleep(150);
    const { x, y, rect } = await computePointById(kernel, id, { autoScroll: true, maxRetries: 3 });
    await dispatchMouseMove(kernel, x, y, smooth);
    await sleep(150);
    return { action: 'hover', id, x, y, rect };
  };

  try {
    return await attempt();
  } catch (e) {
    if (isRetryableError(e)) {
      await kernel.cdp({ forceNew: true });
      return await attempt();
    }
    throw e;
  }
}

async function pressEnterById(kernel, id) {
  await ensureScanMap(kernel);

  // 记录当前 URL 用于检测导航
  const pageBefore = await kernel.page();
  const urlBefore = toStr(pageBefore.url());

  const attempt = async () => {
    await scrollIntoViewById(kernel, id);
    await sleep(150);
    const { x, y, rect } = await computePointById(kernel, id, { autoScroll: true, maxRetries: 3 });
    await dispatchMouseMove(kernel, x, y, false);
    await dispatchClick(kernel, x, y);
    await sleep(80);
    
    // 确保元素被 focus
    const s = scanner(kernel);
    const node = s.getNodeMeta(id);
    if (node && node.backendDOMNodeId) {
      try {
        const cdp = await kernel.cdp();
        await cdp.enable('DOM');
        await cdp.send('DOM.focus', { backendNodeId: node.backendDOMNodeId }, { timeoutMs: 2000, label: 'DOM.focus' });
      } catch {
        // focus 失败也继续，因为 click 可能已经 focus 了
      }
    }
    
    await sleep(40);
    await dispatchEnter(kernel);
    return { action: 'enter', id, x, y, rect };
  };

  let res;
  try {
    res = await attempt();
  } catch (e) {
    if (isCircuitBreakerError(e)) {
      kernel.resetBreaker();
      await scanner(kernel).scan();
      res = await attempt();
    } else if (isRetryableError(e)) {
      await kernel.cdp({ forceNew: true });
      res = await attempt();
    } else {
      throw e;
    }
  }

  // 检测导航
  await sleep(600);
  const pageAfter = await kernel.page();
  const urlAfter = toStr(pageAfter.url());
  if (urlAfter !== urlBefore) {
    res.navigated = true;
    res.newUrl = urlAfter;
  }

  return res;
}

async function selectById(kernel, id, optionValue) {
  await ensureScanMap(kernel);

  const attempt = async () => {
    await scrollIntoViewById(kernel, id);
    await sleep(150);
    const { x, y, rect } = await computePointById(kernel, id, { autoScroll: true, maxRetries: 3 });
    await dispatchMouseMove(kernel, x, y, false);
    await dispatchClick(kernel, x, y);
    await sleep(40);

    const cdp = await kernel.cdp();
    await cdp.enable('DOM');
    await cdp.enable('Runtime');

    const s = scanner(kernel);
    const node = s.getNodeMeta(id);
    const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId }, { timeoutMs: 3000, label: 'DOM.resolveNode(select)' });
    const obj = resolved && resolved.object ? resolved.object : null;
    if (!obj || !obj.objectId) throw new Error('ACT: cannot_resolve_node');

    const res = await cdp.send('Runtime.callFunctionOn', {
      objectId: obj.objectId,
      arguments: [{ value: String(optionValue || '') }],
      functionDeclaration: `function(val) {
        try {
          const el = this;
          if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'not_a_select' };

          let found = false;
          for (const opt of el.options) {
            if (opt.value === val || opt.text === val || (opt.text && opt.text.toLowerCase().includes(String(val).toLowerCase()))) {
              el.value = opt.value;
              found = true;
              break;
            }
          }

          if (!found) {
            const idx = parseInt(val, 10);
            if (!Number.isNaN(idx) && idx >= 0 && idx < el.options.length) {
              el.selectedIndex = idx;
              found = true;
            }
          }

          if (found) {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, selected: el.value, text: el.options[el.selectedIndex].text };
          }

          return { ok: false, error: 'option_not_found', available: Array.from(el.options).map(o => o.text) };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      }`,
      returnByValue: true
    }, { timeoutMs: 3500, label: 'select(callFunctionOn)' });

    const v = res && res.result ? res.result.value : null;
    if (!v || v.ok !== true) {
      const err = v && v.error ? String(v.error) : 'select_failed';
      if (v && v.available) throw new Error(`ACT: ${err}. Available options: ${v.available.join(', ')}`);
      throw new Error(`ACT: ${err}`);
    }

    return { action: 'select', id, selected: v.selected, text: v.text, rect };
  };

  try {
    return await attempt();
  } catch (e) {
    if (isRetryableError(e)) {
      await kernel.cdp({ forceNew: true });
      return await attempt();
    }
    throw e;
  }
}

// ------------------------------
// Command wiring
// ------------------------------
async function onLoad(kernel) {
  kernel.provide(meta.name, 'interaction', {
    clickById: (id, opts) => clickById(kernel, id, opts),
    typeById: (id, text, opts) => typeById(kernel, id, text, opts),
    clearById: (id) => clearById(kernel, id),
    hoverById: (id, opts) => hoverById(kernel, id, opts),
    pressEnterById: (id) => pressEnterById(kernel, id),
    selectById: (id, value) => selectById(kernel, id, value)
  });

  kernel.registerCommand(meta.name, {
    name: 'act',
    usage: 'act <id> <click|type|clear|enter|hover|select> [value]',
    description: 'Generic action dispatcher.',
    handler: async (ctx) => {
      const id = Number(ctx.id || (ctx.argv && ctx.argv[0]));
      const action = String(ctx.action || (ctx.argv && ctx.argv[1]) || '').toLowerCase().trim();
      const value = ctx.value !== undefined ? ctx.value : (ctx.argv && ctx.argv[2]);
      const smooth = !!(ctx.smooth || (ctx.argv && ctx.argv.includes('--smooth')));

      if (!Number.isFinite(id) || id <= 0) throw new Error('ACT: invalid id');
      if (!action) throw new Error('ACT: missing action');

      if (action === 'click') return { ok: true, cmd: 'ACT', ...(await clickById(kernel, id, { smooth })) };
      if (action === 'type') {
        const pressEnter = !!(ctx.enter || ctx.pressEnter || ctx.submit || (ctx.argv && ctx.argv.includes('--enter')));
        return { ok: true, cmd: 'ACT', ...(await typeById(kernel, id, toStr(value), { pressEnter })) };
      }
      if (action === 'clear') return { ok: true, cmd: 'ACT', ...(await clearById(kernel, id)) };
      if (action === 'enter' || action === 'pressenter') return { ok: true, cmd: 'ACT', ...(await pressEnterById(kernel, id)) };
      if (action === 'hover') return { ok: true, cmd: 'ACT', ...(await hoverById(kernel, id, { smooth })) };
      if (action === 'select') return { ok: true, cmd: 'ACT', ...(await selectById(kernel, id, toStr(value))) };

      throw new Error(`ACT: unsupported action "${action}" (supported: click, type, clear, enter, hover, select)`);
    }
  });

  // Convenience commands
  kernel.registerCommand(meta.name, {
    name: 'click',
    usage: 'click <id|"text"> [--smooth] [--js]',
    description: 'Click element by id or text. Use --js for direct JS click (avoids scroll issues with modals).',
    cliOptions: meta.cliOptions,
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const selector = argv.filter(a => !a.startsWith('--'))[0];
      if (!selector) throw new Error('CLICK: missing id or text');
      const smooth = argv.includes('--smooth');
      const useJs = argv.includes('--js');
      
      const { id, element } = await resolveSelector(kernel, selector);
      
      // 如果是 DOM 查询结果（id = -1），直接使用坐标点击
      if (id === -1 && element && element._domFound) {
        const { x, y } = element;
        
        // 记录点击前的状态
        const browser = await kernel.browser();
        const pagesBefore = await browser.pages();
        const countBefore = pagesBefore.filter(p => {
          try {
            if (!p || p.isClosed()) return false;
            const u = toStr(p.url());
            return !u.startsWith('chrome-extension://') && !u.startsWith('devtools://');
          } catch { return false; }
        }).length;
        const pageBefore = await kernel.page();
        const urlBefore = toStr(pageBefore.url());
        
        // 直接点击坐标
        await dispatchMouseMove(kernel, x, y, smooth);
        await dispatchClick(kernel, x, y);
        
        const res = { action: 'click', id: -1, x, y, text: element.text };
        
        // 等待并检测导航
        await sleep(600);
        const pagesAfter = await browser.pages();
        const validPagesAfter = pagesAfter.filter(p => {
          try {
            if (!p || p.isClosed()) return false;
            const u = toStr(p.url());
            return !u.startsWith('chrome-extension://') && !u.startsWith('devtools://');
          } catch { return false; }
        });
        
        if (validPagesAfter.length > countBefore) {
          res.newTab = true;
          const newPage = validPagesAfter[validPagesAfter.length - 1];
          res.newUrl = toStr(newPage.url());
          await kernel.resetPageTo(newPage);
        } else {
          const pageAfter = await kernel.page();
          const urlAfter = toStr(pageAfter.url());
          if (urlAfter !== urlBefore) {
            res.navigated = true;
            res.newUrl = urlAfter;
          }
        }
        
        return { ok: true, cmd: 'CLICK', ...res };
      }
      
      const res = await clickById(kernel, id, { smooth, useJs });
      return { ok: true, cmd: 'CLICK', ...res };
    }
  });

  kernel.registerCommand(meta.name, {
    name: 'type',
    usage: 'type <id|"text"> <content> [--enter] [--clear]',
    description: 'Type into element by id or text.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const pressEnter = argv.includes('--enter') || argv.includes('-e');
      const autoClear = argv.includes('--clear') || argv.includes('-c');
      const filtered = argv.filter(a => a !== '--enter' && a !== '-e' && a !== '--clear' && a !== '-c');
      
      let selector = filtered[0];
      let text = filtered.slice(1).join(' ');
      if (!selector) throw new Error('TYPE: missing id or text');
      
      // 如果 selector 是 1（rootwebarea），自动找输入框
      const numId = Number(selector);
      if (numId === 1) {
        const s = scanner(kernel);
        await ensureScanMap(kernel);
        const last = s.getLastScan();
        const elements = (last && last.elements) || [];
        
        // 找所有可输入的元素
        const inputEls = elements.filter(e => {
          const role = (e.role || '').toLowerCase();
          return role === 'textbox' || role === 'combobox' || role === 'searchbox' || 
                 role === 'spinbutton' || role === 'textarea';
        });
        
        if (inputEls.length === 0) {
          // AXTree 没找到，尝试 DOM fallback
          const page = await kernel.page();
          const domInput = await page.evaluate(() => {
            const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type]), textarea, [contenteditable="true"]');
            const visible = [];
            for (const el of inputs) {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              if (rect.width > 20 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden') {
                visible.push({
                  x: Math.floor(rect.left + rect.width / 2),
                  y: Math.floor(rect.top + rect.height / 2),
                  placeholder: el.placeholder || el.getAttribute('aria-label') || '',
                  type: el.type || 'text'
                });
              }
            }
            return visible;
          });
          
          if (domInput.length === 0) {
            throw new Error('TYPE: no input field found on page');
          }
          
          if (domInput.length === 1) {
            // 直接点击并输入
            const inp = domInput[0];
            await dispatchMouseMove(kernel, inp.x, inp.y, false);
            await dispatchClick(kernel, inp.x, inp.y);
            await sleep(100);
            
            for (const ch of String(text || '')) {
              if (ch === '\n') await dispatchEnter(kernel);
              else if (ch === '\r') continue;
              else await dispatchChar(kernel, ch);
            }
            
            const res = { action: 'type', id: -1, typed: text, pressEnter };
            
            if (pressEnter) {
              const pageBefore = await kernel.page();
              const urlBefore = toStr(pageBefore.url());
              await dispatchEnter(kernel);
              await sleep(800);
              const urlAfter = toStr(pageBefore.url());
              if (urlAfter !== urlBefore) {
                res.navigated = true;
                res.newUrl = urlAfter;
              }
            }
            
            return { ok: true, cmd: 'TYPE', ...res };
          } else {
            // 多个输入框
            const list = domInput.map((inp, i) => `[DOM ${i+1}] input "${inp.placeholder || inp.type}"`).join('\n    ');
            throw new Error(`TYPE: multiple input fields found (use scan to find ids):\n    ${list}`);
          }
        }
        
        if (inputEls.length === 1) {
          // 只有一个输入框，自动使用并提示
          selector = String(inputEls[0].id);
          // 返回结果时会显示实际使用的 id
        } else {
          // 多个输入框，列出让用户选择
          const list = inputEls.map(e => `[${e.id}] ${e.role} "${(e.text || e.name || '').substring(0, 40)}"`).join('\n    ');
          throw new Error(`TYPE: multiple input fields found, please specify:\n    ${list}`);
        }
      }
      
      const { id } = await resolveSelector(kernel, selector);
      
      // 如果指定了 --clear，先清空
      if (autoClear) {
        await clearById(kernel, id);
        await sleep(50);
      }
      
      const res = await typeById(kernel, id, text, { pressEnter });
      return { ok: true, cmd: 'TYPE', ...res };
    }
  });

  kernel.registerCommand(meta.name, {
    name: 'clear',
    usage: 'clear <id|"text">',
    description: 'Clear input field by id or text.',
    handler: async (ctx) => {
      const selector = (ctx.argv || [])[0];
      if (!selector) throw new Error('CLEAR: missing id or text');
      const { id } = await resolveSelector(kernel, selector);
      const res = await clearById(kernel, id);
      return { ok: true, cmd: 'CLEAR', ...res };
    }
  });

  kernel.registerCommand(meta.name, {
    name: 'hover',
    usage: 'hover <id|"text"> [--smooth]',
    description: 'Hover over element by id or text.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const selector = argv.filter(a => a !== '--smooth')[0];
      if (!selector) throw new Error('HOVER: missing id or text');
      const smooth = argv.includes('--smooth');
      
      const { id } = await resolveSelector(kernel, selector);
      const res = await hoverById(kernel, id, { smooth });
      return { ok: true, cmd: 'HOVER', ...res };
    }
  });

  kernel.registerCommand(meta.name, {
    name: 'enter',
    usage: 'enter <id|"text">',
    description: 'Focus element and press Enter.',
    handler: async (ctx) => {
      const selector = (ctx.argv || [])[0];
      if (!selector) throw new Error('ENTER: missing id or text');
      
      const { id } = await resolveSelector(kernel, selector);
      const res = await pressEnterById(kernel, id);
      return { ok: true, cmd: 'ENTER', ...res };
    }
  });

  kernel.registerCommand(meta.name, {
    name: 'select',
    usage: 'select <id|"text"> <option>',
    description: 'Select option in <select> element.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const selector = argv[0];
      const opt = argv.slice(1).join(' ');
      if (!selector) throw new Error('SELECT: missing id or text');
      if (!opt) throw new Error('SELECT: missing option');
      
      const { id } = await resolveSelector(kernel, selector);
      const res = await selectById(kernel, id, opt);
      return { ok: true, cmd: 'SELECT', ...res };
    }
  });

  // 调试命令：检查指定 id 的元素坐标和点击目标
  kernel.registerCommand(meta.name, {
    name: 'debug',
    usage: 'debug <id> [click]',
    description: 'Debug element position and click target.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const id = Number(argv[0]);
      const doClick = argv[1] === 'click';
      
      if (!Number.isFinite(id) || id <= 0) {
        throw new Error('DEBUG: invalid id');
      }
      
      await ensureScanMap(kernel);
      const s = scanner(kernel);
      const node = s.getNodeMeta(id);
      if (!node) throw new Error(`DEBUG: element id ${id} not found`);
      
      // 滚动到元素
      await scrollIntoViewById(kernel, id);
      await sleep(200);
      
      // 计算坐标
      const { x, y, rect, inViewport } = await computePointById(kernel, id, { autoScroll: false, maxRetries: 1 });
      
      // 检查该坐标处的实际元素
      const cdp = await kernel.cdp();
      await cdp.enable('Runtime');
      
      const checkResult = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.elementFromPoint(${x}, ${y});
          if (!el) return { found: false, x: ${x}, y: ${y} };
          
          // 获取元素的完整路径
          const path = [];
          let current = el;
          while (current && current !== document.body) {
            let selector = current.tagName.toLowerCase();
            if (current.id) selector += '#' + current.id;
            else if (current.className) selector += '.' + String(current.className).split(' ')[0];
            path.unshift(selector);
            current = current.parentElement;
          }
          
          return {
            found: true,
            x: ${x},
            y: ${y},
            tag: el.tagName,
            id: el.id || '',
            className: String(el.className || '').substring(0, 100),
            text: (el.innerText || el.textContent || '').substring(0, 80).trim(),
            path: path.join(' > '),
            rect: (() => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()
          };
        })()`,
        returnByValue: true
      }, { timeoutMs: 3000, label: 'debugElementAtPoint' });
      
      const elementAtPoint = checkResult.result?.value || { found: false };
      
      const result = {
        ok: true,
        cmd: 'DEBUG',
        targetId: id,
        targetNode: {
          role: node.role,
          text: (node.text || '').substring(0, 80),
          backendDOMNodeId: node.backendDOMNodeId
        },
        computedPoint: { x, y, inViewport },
        computedRect: rect,
        elementAtPoint
      };
      
      // 如果指定了 click，执行点击并返回结果
      if (doClick) {
        await dispatchMouseMove(kernel, x, y, false);
        await dispatchClick(kernel, x, y, { debug: true });
        result.clicked = true;
      }
      
      return result;
    }
  });
}

async function onUnload(kernel) {}

function getTargetId(target) {
  try {
    if (!target) return '';
    if (target._targetId) return String(target._targetId);
    if (target._targetInfo && target._targetInfo.targetId) return String(target._targetInfo.targetId);
    if (typeof target._targetInfo === 'function') {
      const info = target._targetInfo();
      if (info && info.targetId) return String(info.targetId);
    }
  } catch {}
  return '';
}

module.exports = {
  meta,
  onLoad,
  onUnload
};
