'use strict';

/**
 * core-devtools plugin:
 * 完整的 Chrome DevTools Protocol API 封装
 * 专为逆向工程和调试设计
 * 
 * 核心功能：
 * - Network: 查看网络请求历史、响应体、Headers
 * - Scripts: 获取页面所有脚本、查看源代码、搜索代码
 * - Debugger: 断点、单步调试、调用栈、变量查看
 * - Storage: Cookie、LocalStorage、SessionStorage
 * - DOM: DOM 操作和搜索
 */

const { sleep } = require('../utils/async');

const meta = {
  name: 'core-devtools',
  description: 'Full Chrome DevTools Protocol API for reverse engineering'
};

// ==================== Network ====================

/**
 * 获取页面所有网络请求（通过 Performance API）
 * 这个方法不需要事件监听，直接从浏览器获取历史数据
 */
async function getNetworkRequests(kernel, opts = {}) {
  const { filter, type, limit = 100 } = opts;
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const entries = performance.getEntriesByType('resource');
          return entries.map(e => ({
            name: e.name,
            type: e.initiatorType,
            duration: Math.round(e.duration),
            size: e.transferSize || 0,
            startTime: Math.round(e.startTime),
            responseEnd: Math.round(e.responseEnd)
          }));
        })()
      `,
      returnByValue: true
    }, { timeoutMs: 10000, label: 'getNetworkRequests' });
    
    let requests = result.result?.value || [];
    
    // 过滤
    if (filter) {
      const lowerFilter = filter.toLowerCase();
      requests = requests.filter(r => r.name.toLowerCase().includes(lowerFilter));
    }
    if (type) {
      requests = requests.filter(r => r.type === type);
    }
    
    return {
      ok: true,
      requests: requests.slice(0, limit),
      total: requests.length,
      count: Math.min(requests.length, limit)
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 获取 XHR/Fetch 请求详情（通过拦截）
 * 注入脚本来捕获 XHR 和 Fetch 请求
 */
async function enableXHRCapture(kernel) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  await cdp.enable('Page');
  
  const script = `
    (function() {
      if (window.__pup_xhr_capture__) return;
      window.__pup_xhr_capture__ = true;
      window.__pup_requests__ = [];
      
      // 拦截 XHR
      const origXHR = window.XMLHttpRequest;
      window.XMLHttpRequest = function() {
        const xhr = new origXHR();
        const req = { type: 'xhr', method: '', url: '', requestHeaders: {}, responseHeaders: {}, status: 0, response: null, startTime: 0 };
        
        const origOpen = xhr.open;
        xhr.open = function(method, url) {
          req.method = method;
          req.url = url;
          req.startTime = Date.now();
          return origOpen.apply(this, arguments);
        };
        
        const origSetHeader = xhr.setRequestHeader;
        xhr.setRequestHeader = function(name, value) {
          req.requestHeaders[name] = value;
          return origSetHeader.apply(this, arguments);
        };
        
        xhr.addEventListener('load', function() {
          req.status = xhr.status;
          req.responseHeaders = {};
          xhr.getAllResponseHeaders().split('\\r\\n').forEach(line => {
            const [k, v] = line.split(': ');
            if (k) req.responseHeaders[k] = v;
          });
          try { req.response = xhr.responseText.substring(0, 10000); } catch {}
          req.duration = Date.now() - req.startTime;
          window.__pup_requests__.push(req);
          if (window.__pup_requests__.length > 200) window.__pup_requests__.shift();
        });
        
        return xhr;
      };
      
      // 拦截 Fetch
      const origFetch = window.fetch;
      window.fetch = async function(input, init) {
        const req = { type: 'fetch', method: init?.method || 'GET', url: typeof input === 'string' ? input : input.url, requestHeaders: {}, responseHeaders: {}, status: 0, response: null, startTime: Date.now() };
        if (init?.headers) {
          if (init.headers instanceof Headers) {
            init.headers.forEach((v, k) => req.requestHeaders[k] = v);
          } else {
            Object.assign(req.requestHeaders, init.headers);
          }
        }
        
        try {
          const res = await origFetch.apply(this, arguments);
          req.status = res.status;
          res.headers.forEach((v, k) => req.responseHeaders[k] = v);
          const clone = res.clone();
          try { req.response = (await clone.text()).substring(0, 10000); } catch {}
          req.duration = Date.now() - req.startTime;
          window.__pup_requests__.push(req);
          if (window.__pup_requests__.length > 200) window.__pup_requests__.shift();
          return res;
        } catch (e) {
          req.error = e.message;
          window.__pup_requests__.push(req);
          throw e;
        }
      };
    })();
  `;
  
  // 注入到当前页面
  await cdp.send('Runtime.evaluate', { expression: script }, { timeoutMs: 5000, label: 'injectXHRCapture' });
  
  // 注入到所有新页面
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script }, { timeoutMs: 5000, label: 'addXHRCapture' });
  
  return { ok: true, message: 'XHR/Fetch capture enabled' };
}

/**
 * 获取捕获的 XHR/Fetch 请求
 */
async function getXHRRequests(kernel, opts = {}) {
  const { filter, limit = 50 } = opts;
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'window.__pup_requests__ || []',
      returnByValue: true
    }, { timeoutMs: 5000, label: 'getXHRRequests' });
    
    let requests = result.result?.value || [];
    
    if (filter) {
      const lowerFilter = filter.toLowerCase();
      requests = requests.filter(r => r.url.toLowerCase().includes(lowerFilter));
    }
    
    // 倒序（最新的在前）
    requests = requests.reverse();
    
    return {
      ok: true,
      requests: requests.slice(0, limit),
      total: requests.length,
      count: Math.min(requests.length, limit)
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ==================== Scripts ====================

/**
 * 获取页面所有脚本
 */
async function getScripts(kernel, opts = {}) {
  const { filter, limit = 100 } = opts;
  const cdp = await kernel.cdp();
  
  try {
    // 启用 Debugger 来获取脚本列表
    await cdp.send('Debugger.enable', {}, { timeoutMs: 5000, label: 'enableDebugger' });
    
    // 获取所有脚本 - 通过 Runtime.evaluate 获取 document 中的 script 标签
    await cdp.enable('Runtime');
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const scripts = [];
          document.querySelectorAll('script').forEach((s, i) => {
            scripts.push({
              id: i,
              src: s.src || '(inline)',
              type: s.type || 'text/javascript',
              async: s.async,
              defer: s.defer,
              inline: !s.src,
              length: s.src ? 0 : s.textContent.length
            });
          });
          return scripts;
        })()
      `,
      returnByValue: true
    }, { timeoutMs: 10000, label: 'getScripts' });
    
    let scripts = result.result?.value || [];
    
    if (filter) {
      const lowerFilter = filter.toLowerCase();
      scripts = scripts.filter(s => s.src.toLowerCase().includes(lowerFilter));
    }
    
    return {
      ok: true,
      scripts: scripts.slice(0, limit),
      total: scripts.length,
      count: Math.min(scripts.length, limit)
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 获取脚本源代码（通过 URL 或 inline index）
 */
async function getScriptSource(kernel, urlOrIndex) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    // 如果是数字，获取 inline 脚本
    if (!isNaN(Number(urlOrIndex))) {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `document.querySelectorAll('script')[${urlOrIndex}]?.textContent || ''`,
        returnByValue: true
      }, { timeoutMs: 5000, label: 'getInlineScript' });
      
      const source = result.result?.value || '';
      return { ok: true, source, length: source.length, type: 'inline', index: Number(urlOrIndex) };
    }
    
    // 否则通过 fetch 获取外部脚本
    const result = await cdp.send('Runtime.evaluate', {
      expression: `fetch(${JSON.stringify(urlOrIndex)}).then(r => r.text())`,
      awaitPromise: true,
      returnByValue: true
    }, { timeoutMs: 30000, label: 'fetchScript' });
    
    const source = result.result?.value || '';
    return { ok: true, source, length: source.length, type: 'external', url: urlOrIndex };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 在所有脚本中搜索代码
 */
async function searchInScripts(kernel, query, opts = {}) {
  const { caseSensitive = false, limit = 50 } = opts;
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (async () => {
          const query = ${JSON.stringify(query)};
          const caseSensitive = ${caseSensitive};
          const results = [];
          
          // 搜索 inline 脚本
          document.querySelectorAll('script').forEach((s, i) => {
            if (!s.src && s.textContent) {
              const content = caseSensitive ? s.textContent : s.textContent.toLowerCase();
              const searchQuery = caseSensitive ? query : query.toLowerCase();
              let pos = 0;
              while ((pos = content.indexOf(searchQuery, pos)) !== -1) {
                const lineNum = s.textContent.substring(0, pos).split('\\n').length;
                const lineStart = s.textContent.lastIndexOf('\\n', pos) + 1;
                const lineEnd = s.textContent.indexOf('\\n', pos);
                const line = s.textContent.substring(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
                results.push({ type: 'inline', index: i, line: lineNum, preview: line.substring(0, 100) });
                pos++;
                if (results.length >= ${limit}) break;
              }
            }
          });
          
          // 搜索外部脚本（只搜索同源的）
          const origin = location.origin;
          for (const s of document.querySelectorAll('script[src]')) {
            if (results.length >= ${limit}) break;
            if (!s.src.startsWith(origin)) continue;
            try {
              const content = await fetch(s.src).then(r => r.text());
              const searchContent = caseSensitive ? content : content.toLowerCase();
              const searchQuery = caseSensitive ? query : query.toLowerCase();
              let pos = 0;
              while ((pos = searchContent.indexOf(searchQuery, pos)) !== -1) {
                const lineNum = content.substring(0, pos).split('\\n').length;
                const lineStart = content.lastIndexOf('\\n', pos) + 1;
                const lineEnd = content.indexOf('\\n', pos);
                const line = content.substring(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
                results.push({ type: 'external', url: s.src, line: lineNum, preview: line.substring(0, 100) });
                pos++;
                if (results.length >= ${limit}) break;
              }
            } catch {}
          }
          
          return results;
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    }, { timeoutMs: 60000, label: 'searchInScripts' });
    
    const matches = result.result?.value || [];
    return { ok: true, query, matches, count: matches.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ==================== Debugger ====================

/**
 * 设置 XHR 断点（当发起特定 URL 的请求时暂停）
 */
async function setXHRBreakpoint(kernel, urlPattern) {
  const cdp = await kernel.cdp();
  
  try {
    await cdp.send('Debugger.enable', {}, { timeoutMs: 5000, label: 'enableDebugger' });
    await cdp.send('DOMDebugger.setXHRBreakpoint', { url: urlPattern }, { timeoutMs: 5000, label: 'setXHRBreakpoint' });
    return { ok: true, message: `XHR breakpoint set for: ${urlPattern}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 移除 XHR 断点
 */
async function removeXHRBreakpoint(kernel, urlPattern) {
  const cdp = await kernel.cdp();
  
  try {
    await cdp.send('DOMDebugger.removeXHRBreakpoint', { url: urlPattern }, { timeoutMs: 5000, label: 'removeXHRBreakpoint' });
    return { ok: true, message: `XHR breakpoint removed for: ${urlPattern}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 设置事件监听断点
 */
async function setEventBreakpoint(kernel, eventName) {
  const cdp = await kernel.cdp();
  
  try {
    await cdp.send('Debugger.enable', {}, { timeoutMs: 5000, label: 'enableDebugger' });
    await cdp.send('DOMDebugger.setEventListenerBreakpoint', { eventName }, { timeoutMs: 5000, label: 'setEventBreakpoint' });
    return { ok: true, message: `Event breakpoint set for: ${eventName}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 移除事件监听断点
 */
async function removeEventBreakpoint(kernel, eventName) {
  const cdp = await kernel.cdp();
  
  try {
    await cdp.send('DOMDebugger.removeEventListenerBreakpoint', { eventName }, { timeoutMs: 5000, label: 'removeEventBreakpoint' });
    return { ok: true, message: `Event breakpoint removed for: ${eventName}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 获取全局变量
 */
async function getGlobalVar(kernel, varPath) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: varPath,
      returnByValue: true,
      generatePreview: true
    }, { timeoutMs: 10000, label: 'getGlobalVar' });
    
    if (result.exceptionDetails) {
      return { ok: false, error: result.exceptionDetails.text || 'Evaluation failed' };
    }
    
    return {
      ok: true,
      path: varPath,
      type: result.result?.type,
      subtype: result.result?.subtype,
      value: result.result?.value,
      description: result.result?.description
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 获取对象的所有属性
 */
async function getObjectProperties(kernel, expression) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    // 先获取对象引用
    const evalResult = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: false
    }, { timeoutMs: 10000, label: 'evalObject' });
    
    if (!evalResult.result?.objectId) {
      return { ok: false, error: 'Not an object or object not found' };
    }
    
    // 获取属性
    const propsResult = await cdp.send('Runtime.getProperties', {
      objectId: evalResult.result.objectId,
      ownProperties: true,
      generatePreview: true
    }, { timeoutMs: 10000, label: 'getProperties' });
    
    const properties = (propsResult.result || []).map(p => ({
      name: p.name,
      type: p.value?.type,
      value: p.value?.value,
      description: p.value?.description?.substring(0, 100)
    }));
    
    return { ok: true, expression, properties, count: properties.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Hook 函数（在函数调用时注入代码）
 */
async function hookFunction(kernel, funcPath, hookCode) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  const script = `
    (function() {
      const path = ${JSON.stringify(funcPath)}.split('.');
      let obj = window;
      for (let i = 0; i < path.length - 1; i++) {
        obj = obj[path[i]];
        if (!obj) return { ok: false, error: 'Path not found: ' + path.slice(0, i+1).join('.') };
      }
      const funcName = path[path.length - 1];
      const origFunc = obj[funcName];
      if (typeof origFunc !== 'function') return { ok: false, error: 'Not a function: ' + ${JSON.stringify(funcPath)} };
      
      obj[funcName] = function(...args) {
        ${hookCode}
        return origFunc.apply(this, args);
      };
      obj[funcName].__pup_hooked__ = true;
      obj[funcName].__pup_original__ = origFunc;
      return { ok: true, message: 'Function hooked: ' + ${JSON.stringify(funcPath)} };
    })()
  `;
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: script,
      returnByValue: true
    }, { timeoutMs: 5000, label: 'hookFunction' });
    
    return result.result?.value || { ok: false, error: 'Hook failed' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 取消 Hook
 */
async function unhookFunction(kernel, funcPath) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  const script = `
    (function() {
      const path = ${JSON.stringify(funcPath)}.split('.');
      let obj = window;
      for (let i = 0; i < path.length - 1; i++) {
        obj = obj[path[i]];
        if (!obj) return { ok: false, error: 'Path not found' };
      }
      const funcName = path[path.length - 1];
      if (!obj[funcName]?.__pup_hooked__) return { ok: false, error: 'Function not hooked' };
      obj[funcName] = obj[funcName].__pup_original__;
      return { ok: true, message: 'Function unhooked: ' + ${JSON.stringify(funcPath)} };
    })()
  `;
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: script,
      returnByValue: true
    }, { timeoutMs: 5000, label: 'unhookFunction' });
    
    return result.result?.value || { ok: false, error: 'Unhook failed' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ==================== Storage ====================

async function getCookies(kernel, urls = []) {
  const cdp = await kernel.cdp();
  await cdp.enable('Network');
  
  try {
    const result = await cdp.send('Network.getCookies', { urls: urls.length ? urls : undefined }, { timeoutMs: 5000, label: 'getCookies' });
    return { ok: true, cookies: result.cookies, count: result.cookies.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function setCookie(kernel, cookie) {
  const cdp = await kernel.cdp();
  await cdp.enable('Network');
  
  try {
    const result = await cdp.send('Network.setCookie', cookie, { timeoutMs: 5000, label: 'setCookie' });
    return { ok: result.success, message: result.success ? 'Cookie set' : 'Failed to set cookie' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function deleteCookies(kernel, opts) {
  const cdp = await kernel.cdp();
  await cdp.enable('Network');
  
  try {
    await cdp.send('Network.deleteCookies', opts, { timeoutMs: 5000, label: 'deleteCookies' });
    return { ok: true, message: 'Cookies deleted' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function getLocalStorage(kernel) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const items = {}; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); items[key] = localStorage.getItem(key); } return items; })()`,
      returnByValue: true
    }, { timeoutMs: 5000, label: 'getLocalStorage' });
    
    return { ok: true, storage: result.result?.value || {}, count: Object.keys(result.result?.value || {}).length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function setLocalStorage(kernel, key, value) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    await cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
      returnByValue: true
    }, { timeoutMs: 5000, label: 'setLocalStorage' });
    return { ok: true, key, value };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function clearLocalStorage(kernel) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    await cdp.send('Runtime.evaluate', { expression: 'localStorage.clear()', returnByValue: true }, { timeoutMs: 5000, label: 'clearLocalStorage' });
    return { ok: true, message: 'LocalStorage cleared' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function getSessionStorage(kernel) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const items = {}; for (let i = 0; i < sessionStorage.length; i++) { const key = sessionStorage.key(i); items[key] = sessionStorage.getItem(key); } return items; })()`,
      returnByValue: true
    }, { timeoutMs: 5000, label: 'getSessionStorage' });
    
    return { ok: true, storage: result.result?.value || {}, count: Object.keys(result.result?.value || {}).length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function clearCache(kernel) {
  const cdp = await kernel.cdp();
  await cdp.enable('Network');
  
  try {
    await cdp.send('Network.clearBrowserCache', {}, { timeoutMs: 5000, label: 'clearCache' });
    return { ok: true, message: 'Browser cache cleared' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ==================== DOM ====================

async function searchDOM(kernel, query) {
  const cdp = await kernel.cdp();
  await cdp.enable('DOM');
  
  try {
    await cdp.send('DOM.getDocument', { depth: 0 }, { timeoutMs: 5000, label: 'getDocument' });
    const result = await cdp.send('DOM.performSearch', { query }, { timeoutMs: 10000, label: 'searchDOM' });
    
    if (result.resultCount === 0) return { ok: true, count: 0, nodeIds: [] };
    
    const nodesResult = await cdp.send('DOM.getSearchResults', { searchId: result.searchId, fromIndex: 0, toIndex: Math.min(result.resultCount, 100) }, { timeoutMs: 5000, label: 'getSearchResults' });
    await cdp.send('DOM.discardSearchResults', { searchId: result.searchId }, { timeoutMs: 2000, label: 'discardSearch' }).catch(() => {});
    
    return { ok: true, query, count: result.resultCount, nodeIds: nodesResult.nodeIds };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function getOuterHTML(kernel, selector) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})?.outerHTML || ''`,
      returnByValue: true
    }, { timeoutMs: 5000, label: 'getOuterHTML' });
    
    const html = result.result?.value || '';
    if (!html) return { ok: false, error: 'Element not found' };
    return { ok: true, selector, html, length: html.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ==================== Performance ====================

async function getMetrics(kernel) {
  const cdp = await kernel.cdp();
  
  try {
    await cdp.send('Performance.enable', {}, { timeoutMs: 3000, label: 'enablePerformance' });
    const result = await cdp.send('Performance.getMetrics', {}, { timeoutMs: 5000, label: 'getMetrics' });
    
    const metrics = {};
    for (const m of result.metrics) metrics[m.name] = m.value;
    
    return { ok: true, metrics };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ==================== Emulation ====================

async function setDeviceMetrics(kernel, opts) {
  const cdp = await kernel.cdp();
  const { width, height, deviceScaleFactor = 1, mobile = false } = opts;
  
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile }, { timeoutMs: 5000, label: 'setDeviceMetrics' });
    return { ok: true, width, height, mobile };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function setGeolocation(kernel, latitude, longitude, accuracy = 100) {
  const cdp = await kernel.cdp();
  
  try {
    await cdp.send('Emulation.setGeolocationOverride', { latitude, longitude, accuracy }, { timeoutMs: 5000, label: 'setGeolocation' });
    return { ok: true, latitude, longitude };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function setUserAgent(kernel, userAgent) {
  const cdp = await kernel.cdp();
  
  try {
    await cdp.send('Emulation.setUserAgentOverride', { userAgent }, { timeoutMs: 5000, label: 'setUserAgent' });
    return { ok: true, userAgent };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ==================== Raw CDP ====================

async function sendCDP(kernel, method, params = {}) {
  const cdp = await kernel.cdp();
  
  try {
    const result = await cdp.send(method, params, { timeoutMs: 30000, label: `cdp:${method}` });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ==================== Command Registration ====================

async function onLoad(kernel) {
  // 提供服务接口
  kernel.provide(meta.name, 'devtools', {
    getNetworkRequests: (opts) => getNetworkRequests(kernel, opts),
    enableXHRCapture: () => enableXHRCapture(kernel),
    getXHRRequests: (opts) => getXHRRequests(kernel, opts),
    getScripts: (opts) => getScripts(kernel, opts),
    getScriptSource: (id) => getScriptSource(kernel, id),
    searchInScripts: (query, opts) => searchInScripts(kernel, query, opts),
    setXHRBreakpoint: (url) => setXHRBreakpoint(kernel, url),
    removeXHRBreakpoint: (url) => removeXHRBreakpoint(kernel, url),
    setEventBreakpoint: (event) => setEventBreakpoint(kernel, event),
    removeEventBreakpoint: (event) => removeEventBreakpoint(kernel, event),
    getGlobalVar: (path) => getGlobalVar(kernel, path),
    getObjectProperties: (expr) => getObjectProperties(kernel, expr),
    hookFunction: (path, code) => hookFunction(kernel, path, code),
    unhookFunction: (path) => unhookFunction(kernel, path),
    getCookies: (urls) => getCookies(kernel, urls),
    setCookie: (cookie) => setCookie(kernel, cookie),
    deleteCookies: (opts) => deleteCookies(kernel, opts),
    getLocalStorage: () => getLocalStorage(kernel),
    setLocalStorage: (k, v) => setLocalStorage(kernel, k, v),
    clearLocalStorage: () => clearLocalStorage(kernel),
    getSessionStorage: () => getSessionStorage(kernel),
    clearCache: () => clearCache(kernel),
    searchDOM: (query) => searchDOM(kernel, query),
    getOuterHTML: (selector) => getOuterHTML(kernel, selector),
    getMetrics: () => getMetrics(kernel),
    setDeviceMetrics: (opts) => setDeviceMetrics(kernel, opts),
    setGeolocation: (lat, lng, acc) => setGeolocation(kernel, lat, lng, acc),
    setUserAgent: (ua) => setUserAgent(kernel, ua),
    sendCDP: (method, params) => sendCDP(kernel, method, params)
  });

  // ========== CLI Commands ==========

  // network - 网络请求
  kernel.registerCommand(meta.name, {
    name: 'network',
    usage: 'network [--filter url] [--type type] [--xhr] [--capture]',
    description: 'View network requests. Use --capture to enable XHR/Fetch capture, --xhr to view captured requests.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      
      // 启用 XHR 捕获
      if (argv.includes('--capture')) {
        const result = await enableXHRCapture(kernel);
        return { ok: result.ok, cmd: 'NETWORK', action: 'capture', ...result };
      }
      
      // 查看捕获的 XHR 请求
      if (argv.includes('--xhr')) {
        const filterIdx = argv.indexOf('--filter');
        const opts = {};
        if (filterIdx !== -1 && argv[filterIdx + 1]) opts.filter = argv[filterIdx + 1];
        const result = await getXHRRequests(kernel, opts);
        return { ok: result.ok, cmd: 'NETWORK', action: 'xhr', ...result };
      }
      
      // 默认：查看 Performance API 的请求
      const filterIdx = argv.indexOf('--filter');
      const typeIdx = argv.indexOf('--type');
      const opts = {};
      if (filterIdx !== -1 && argv[filterIdx + 1]) opts.filter = argv[filterIdx + 1];
      if (typeIdx !== -1 && argv[typeIdx + 1]) opts.type = argv[typeIdx + 1];
      
      const result = await getNetworkRequests(kernel, opts);
      return { ok: result.ok, cmd: 'NETWORK', action: 'list', ...result };
    }
  });

  // scripts - 脚本
  kernel.registerCommand(meta.name, {
    name: 'scripts',
    usage: 'scripts [--filter url] [--source index|url] [--search query]',
    description: 'List scripts, view source, or search in scripts.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      
      // 搜索
      const searchIdx = argv.indexOf('--search');
      if (searchIdx !== -1 && argv[searchIdx + 1]) {
        const query = argv.slice(searchIdx + 1).join(' ');
        const result = await searchInScripts(kernel, query);
        return { ok: result.ok, cmd: 'SCRIPTS', action: 'search', ...result };
      }
      
      // 查看源代码
      const sourceIdx = argv.indexOf('--source');
      if (sourceIdx !== -1 && argv[sourceIdx + 1]) {
        const urlOrIndex = argv[sourceIdx + 1];
        const result = await getScriptSource(kernel, urlOrIndex);
        return { ok: result.ok, cmd: 'SCRIPTS', action: 'source', ...result };
      }
      
      // 列表
      const filterIdx = argv.indexOf('--filter');
      const opts = {};
      if (filterIdx !== -1 && argv[filterIdx + 1]) opts.filter = argv[filterIdx + 1];
      
      const result = await getScripts(kernel, opts);
      return { ok: result.ok, cmd: 'SCRIPTS', action: 'list', ...result };
    }
  });

  // hook - 函数 Hook
  kernel.registerCommand(meta.name, {
    name: 'hook',
    usage: 'hook <set funcPath code|remove funcPath>',
    description: 'Hook a function to inject code before execution.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const action = argv[0];
      
      if (action === 'set' && argv[1] && argv[2]) {
        const funcPath = argv[1];
        const code = argv.slice(2).join(' ');
        const result = await hookFunction(kernel, funcPath, code);
        return { ok: result.ok, cmd: 'HOOK', action: 'set', funcPath, ...result };
      }
      
      if (action === 'remove' && argv[1]) {
        const result = await unhookFunction(kernel, argv[1]);
        return { ok: result.ok, cmd: 'HOOK', action: 'remove', ...result };
      }
      
      throw new Error('HOOK: use "hook set <funcPath> <code>" or "hook remove <funcPath>"');
    }
  });

  // var - 查看变量
  kernel.registerCommand(meta.name, {
    name: 'var',
    usage: 'var <path> [--props]',
    description: 'Get global variable value. Use --props to list object properties.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const path = argv.filter(a => !a.startsWith('--'))[0];
      if (!path) throw new Error('VAR: missing variable path');
      
      if (argv.includes('--props')) {
        const result = await getObjectProperties(kernel, path);
        return { ok: result.ok, cmd: 'VAR', action: 'props', ...result };
      }
      
      const result = await getGlobalVar(kernel, path);
      return { ok: result.ok, cmd: 'VAR', action: 'get', ...result };
    }
  });

  // breakon - 设置断点
  kernel.registerCommand(meta.name, {
    name: 'breakon',
    usage: 'breakon <xhr url|event eventName>',
    description: 'Set breakpoint on XHR request or DOM event.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const type = argv[0];
      
      if (type === 'xhr' && argv[1]) {
        const result = await setXHRBreakpoint(kernel, argv[1]);
        return { ok: result.ok, cmd: 'BREAKON', type: 'xhr', url: argv[1], ...result };
      }
      
      if (type === 'event' && argv[1]) {
        const result = await setEventBreakpoint(kernel, argv[1]);
        return { ok: result.ok, cmd: 'BREAKON', type: 'event', event: argv[1], ...result };
      }
      
      throw new Error('BREAKON: use "breakon xhr <url>" or "breakon event <eventName>"');
    }
  });

  // cookies
  kernel.registerCommand(meta.name, {
    name: 'cookies',
    usage: 'cookies [--set name=value] [--delete name] [--clear]',
    description: 'Manage browser cookies.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      
      if (argv.includes('--clear')) {
        const page = await kernel.page();
        const url = new URL(page.url());
        const result = await deleteCookies(kernel, { domain: url.hostname });
        return { ok: result.ok, cmd: 'COOKIES', action: 'clear', ...result };
      }
      
      const deleteIdx = argv.indexOf('--delete');
      if (deleteIdx !== -1 && argv[deleteIdx + 1]) {
        const name = argv[deleteIdx + 1];
        const page = await kernel.page();
        const url = new URL(page.url());
        const result = await deleteCookies(kernel, { name, domain: url.hostname });
        return { ok: result.ok, cmd: 'COOKIES', action: 'delete', name, ...result };
      }
      
      const setIdx = argv.indexOf('--set');
      if (setIdx !== -1 && argv[setIdx + 1]) {
        const [name, value] = argv[setIdx + 1].split('=');
        const page = await kernel.page();
        const url = new URL(page.url());
        const result = await setCookie(kernel, { name, value: value || '', domain: url.hostname, path: '/' });
        return { ok: result.ok, cmd: 'COOKIES', action: 'set', name, value, ...result };
      }
      
      const result = await getCookies(kernel);
      return { ok: result.ok, cmd: 'COOKIES', action: 'list', ...result };
    }
  });

  // storage
  kernel.registerCommand(meta.name, {
    name: 'storage',
    usage: 'storage [--set key=value] [--clear] [--session]',
    description: 'Manage localStorage/sessionStorage.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const isSession = argv.includes('--session');
      const storageType = isSession ? 'session' : 'local';
      
      if (argv.includes('--clear')) {
        const result = await clearLocalStorage(kernel);
        return { ok: result.ok, cmd: 'STORAGE', action: 'clear', type: storageType, ...result };
      }
      
      const setIdx = argv.indexOf('--set');
      if (setIdx !== -1 && argv[setIdx + 1]) {
        const [key, ...valueParts] = argv[setIdx + 1].split('=');
        const value = valueParts.join('=');
        const result = await setLocalStorage(kernel, key, value);
        return { ok: result.ok, cmd: 'STORAGE', action: 'set', key, value, type: storageType, ...result };
      }
      
      const result = isSession ? await getSessionStorage(kernel) : await getLocalStorage(kernel);
      return { ok: result.ok, cmd: 'STORAGE', action: 'list', type: storageType, ...result };
    }
  });

  // dom
  kernel.registerCommand(meta.name, {
    name: 'dom',
    usage: 'dom <search query|html selector>',
    description: 'Search DOM or get element HTML.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const action = argv[0];
      
      if (action === 'search' && argv[1]) {
        const query = argv.slice(1).join(' ');
        const result = await searchDOM(kernel, query);
        return { ok: result.ok, cmd: 'DOM', action: 'search', ...result };
      }
      
      if (action === 'html' && argv[1]) {
        const selector = argv.slice(1).join(' ');
        const result = await getOuterHTML(kernel, selector);
        return { ok: result.ok, cmd: 'DOM', action: 'html', ...result };
      }
      
      throw new Error('DOM: use "dom search <query>" or "dom html <selector>"');
    }
  });

  // perf
  kernel.registerCommand(meta.name, {
    name: 'perf',
    usage: 'perf',
    description: 'Get page performance metrics.',
    handler: async () => {
      const result = await getMetrics(kernel);
      return { ok: result.ok, cmd: 'PERF', ...result };
    }
  });

  // emulate
  kernel.registerCommand(meta.name, {
    name: 'emulate',
    usage: 'emulate <iphone|ipad|android|desktop|viewport WxH|geo lat,lng|ua string>',
    description: 'Emulate device, viewport, geolocation, or user-agent.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const action = argv[0];
      
      if (!action) throw new Error('EMULATE: missing action');
      
      if (action === 'viewport' && argv[1]) {
        const [w, h] = argv[1].split('x').map(Number);
        if (!w || !h) throw new Error('EMULATE: invalid viewport format (use WxH)');
        const result = await setDeviceMetrics(kernel, { width: w, height: h });
        return { ok: result.ok, cmd: 'EMULATE', action: 'viewport', ...result };
      }
      
      if (action === 'geo' && argv[1]) {
        const [lat, lng] = argv[1].split(',').map(Number);
        if (isNaN(lat) || isNaN(lng)) throw new Error('EMULATE: invalid geo format (use lat,lng)');
        const result = await setGeolocation(kernel, lat, lng);
        return { ok: result.ok, cmd: 'EMULATE', action: 'geo', ...result };
      }
      
      if (action === 'ua') {
        const ua = argv.slice(1).join(' ');
        if (!ua) throw new Error('EMULATE: missing user-agent string');
        const result = await setUserAgent(kernel, ua);
        return { ok: result.ok, cmd: 'EMULATE', action: 'ua', ...result };
      }
      
      const devices = {
        'iphone': { width: 375, height: 812, mobile: true, deviceScaleFactor: 3 },
        'ipad': { width: 768, height: 1024, mobile: true, deviceScaleFactor: 2 },
        'android': { width: 360, height: 640, mobile: true, deviceScaleFactor: 3 },
        'desktop': { width: 1920, height: 1080, mobile: false, deviceScaleFactor: 1 }
      };
      
      const device = devices[action.toLowerCase()];
      if (device) {
        const result = await setDeviceMetrics(kernel, device);
        return { ok: result.ok, cmd: 'EMULATE', action: 'device', device: action, ...result };
      }
      
      throw new Error('EMULATE: use iphone, ipad, android, desktop, viewport, geo, or ua');
    }
  });

  // cdp
  kernel.registerCommand(meta.name, {
    name: 'cdp',
    usage: 'cdp <method> [params-json]',
    description: 'Send raw CDP command.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const method = argv[0];
      if (!method) throw new Error('CDP: missing method');
      
      let params = {};
      if (argv[1]) {
        try {
          params = JSON.parse(argv.slice(1).join(' '));
        } catch {
          throw new Error('CDP: invalid JSON params');
        }
      }
      
      const result = await sendCDP(kernel, method, params);
      return { ok: result.ok, cmd: 'CDP', method, ...result };
    }
  });

  // cache
  kernel.registerCommand(meta.name, {
    name: 'cache',
    usage: 'cache --clear',
    description: 'Clear browser cache.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      if (argv.includes('--clear')) {
        const result = await clearCache(kernel);
        return { ok: result.ok, cmd: 'CACHE', action: 'clear', ...result };
      }
      return { ok: true, cmd: 'CACHE', message: 'Use --clear to clear browser cache' };
    }
  });
}

async function onUnload(kernel) {}

module.exports = { meta, onLoad, onUnload };
