'use strict';

/**
 * core-exec plugin:
 * 提供隐蔽的 JavaScript 执行能力，网站无法检测
 * 
 * 特性：
 * - 使用 CDP Runtime.evaluate 在隔离的上下文中执行
 * - 支持 DOM 操作、数据提取、事件触发
 * - 绕过网站的自动化检测
 * - 支持异步代码执行
 */

const { sleep } = require('../utils/async');

const meta = {
  name: 'core-exec',
  description: 'Stealth JavaScript execution - undetectable by websites'
};

/**
 * 在页面中执行 JavaScript 代码（隐蔽模式）
 * 使用 CDP 的 Runtime.evaluate，在隔离上下文中执行
 */
async function execScript(kernel, code, opts = {}) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  const {
    returnByValue = true,
    awaitPromise = true,
    timeout = 30000,
    isolate = false  // 是否在隔离的 world 中执行
  } = opts;

  try {
    let result;
    
    if (isolate) {
      // 在隔离的执行上下文中运行（更隐蔽）
      // 先创建一个隔离的 world
      const page = await kernel.page();
      const frameId = page.mainFrame()._id;
      
      const worldResult = await cdp.send('Page.createIsolatedWorld', {
        frameId,
        worldName: '_pup_exec_' + Date.now(),
        grantUniveralAccess: true
      }, { timeoutMs: 5000, label: 'createIsolatedWorld' });
      
      const contextId = worldResult.executionContextId;
      
      result = await cdp.send('Runtime.evaluate', {
        expression: code,
        contextId,
        returnByValue,
        awaitPromise,
        userGesture: true,
        allowUnsafeEvalBlockedByCSP: true
      }, { timeoutMs: timeout, label: 'exec(isolated)' });
    } else {
      // 在主上下文中执行
      result = await cdp.send('Runtime.evaluate', {
        expression: code,
        returnByValue,
        awaitPromise,
        userGesture: true,
        allowUnsafeEvalBlockedByCSP: true
      }, { timeoutMs: timeout, label: 'exec' });
    }

    if (result.exceptionDetails) {
      const err = result.exceptionDetails;
      const msg = err.exception?.description || err.text || 'Script execution failed';
      return { ok: false, error: msg };
    }

    return { 
      ok: true, 
      result: result.result?.value,
      type: result.result?.type
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 在页面中注入并执行函数
 * 比直接执行字符串更安全，支持参数传递
 */
async function execFunction(kernel, fn, args = [], opts = {}) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  await cdp.enable('DOM');
  
  const { timeout = 30000 } = opts;

  try {
    // 获取 document 对象的 objectId
    const docResult = await cdp.send('Runtime.evaluate', {
      expression: 'document',
      returnByValue: false
    }, { timeoutMs: 5000, label: 'getDocument' });

    if (!docResult.result?.objectId) {
      return { ok: false, error: 'Cannot get document object' };
    }

    // 使用 callFunctionOn 执行函数
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId: docResult.result.objectId,
      functionDeclaration: fn.toString(),
      arguments: args.map(arg => ({ value: arg })),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    }, { timeoutMs: timeout, label: 'execFunction' });

    if (result.exceptionDetails) {
      const err = result.exceptionDetails;
      const msg = err.exception?.description || err.text || 'Function execution failed';
      return { ok: false, error: msg };
    }

    return { 
      ok: true, 
      result: result.result?.value 
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 注入脚本到页面（持久化）
 * 脚本会在页面加载时自动执行
 */
async function injectScript(kernel, code, opts = {}) {
  const cdp = await kernel.cdp();
  await cdp.enable('Page');
  
  const { runOnLoad = true } = opts;

  try {
    const result = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: code,
      runImmediately: !runOnLoad
    }, { timeoutMs: 5000, label: 'injectScript' });

    return { 
      ok: true, 
      identifier: result.identifier,
      message: 'Script injected successfully'
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 移除注入的脚本
 */
async function removeInjectedScript(kernel, identifier) {
  const cdp = await kernel.cdp();
  await cdp.enable('Page');

  try {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
      identifier
    }, { timeoutMs: 5000, label: 'removeScript' });

    return { ok: true, message: 'Script removed' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 执行 DOM 查询并返回结果
 */
async function queryDOM(kernel, selector, opts = {}) {
  const { 
    all = false,      // 是否返回所有匹配元素
    extract = null,   // 提取的属性列表，如 ['innerText', 'href']
    limit = 100       // 最大返回数量
  } = opts;

  const code = `
    (() => {
      try {
        const selector = ${JSON.stringify(selector)};
        const all = ${all};
        const extract = ${JSON.stringify(extract)};
        const limit = ${limit};
        
        if (all) {
          const els = Array.from(document.querySelectorAll(selector)).slice(0, limit);
          if (!extract) {
            return { ok: true, count: els.length };
          }
          return {
            ok: true,
            count: els.length,
            items: els.map(el => {
              const item = {};
              for (const prop of extract) {
                if (prop === 'innerText') item.text = (el.innerText || '').trim();
                else if (prop === 'innerHTML') item.html = el.innerHTML;
                else if (prop === 'href') item.href = el.href || el.getAttribute('href');
                else if (prop === 'src') item.src = el.src || el.getAttribute('src');
                else if (prop === 'value') item.value = el.value;
                else if (prop === 'className') item.className = el.className;
                else if (prop === 'id') item.id = el.id;
                else if (prop === 'tagName') item.tag = el.tagName.toLowerCase();
                else if (prop.startsWith('data-')) item[prop] = el.getAttribute(prop);
                else if (prop.startsWith('aria-')) item[prop] = el.getAttribute(prop);
                else item[prop] = el.getAttribute(prop);
              }
              return item;
            })
          };
        } else {
          const el = document.querySelector(selector);
          if (!el) return { ok: false, error: 'Element not found' };
          if (!extract) return { ok: true, found: true };
          const item = {};
          for (const prop of extract) {
            if (prop === 'innerText') item.text = (el.innerText || '').trim();
            else if (prop === 'innerHTML') item.html = el.innerHTML;
            else if (prop === 'href') item.href = el.href || el.getAttribute('href');
            else if (prop === 'src') item.src = el.src || el.getAttribute('src');
            else if (prop === 'value') item.value = el.value;
            else if (prop === 'className') item.className = el.className;
            else if (prop === 'id') item.id = el.id;
            else if (prop === 'tagName') item.tag = el.tagName.toLowerCase();
            else if (prop.startsWith('data-')) item[prop] = el.getAttribute(prop);
            else if (prop.startsWith('aria-')) item[prop] = el.getAttribute(prop);
            else item[prop] = el.getAttribute(prop);
          }
          return { ok: true, ...item };
        }
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    })()
  `;

  return await execScript(kernel, code);
}

/**
 * 触发 DOM 事件
 */
async function triggerEvent(kernel, selector, eventType, opts = {}) {
  const { 
    bubbles = true, 
    cancelable = true,
    eventInit = {}
  } = opts;

  const code = `
    (() => {
      try {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'Element not found' };
        
        const eventType = ${JSON.stringify(eventType)};
        const eventInit = ${JSON.stringify({ bubbles, cancelable, ...eventInit })};
        
        let event;
        if (eventType === 'click' || eventType === 'mousedown' || eventType === 'mouseup' || eventType === 'mouseover' || eventType === 'mouseout') {
          event = new MouseEvent(eventType, eventInit);
        } else if (eventType === 'keydown' || eventType === 'keyup' || eventType === 'keypress') {
          event = new KeyboardEvent(eventType, eventInit);
        } else if (eventType === 'input' || eventType === 'change') {
          event = new Event(eventType, eventInit);
        } else if (eventType === 'focus' || eventType === 'blur') {
          event = new FocusEvent(eventType, eventInit);
        } else {
          event = new Event(eventType, eventInit);
        }
        
        el.dispatchEvent(event);
        return { ok: true, eventType, selector: ${JSON.stringify(selector)} };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    })()
  `;

  return await execScript(kernel, code);
}

/**
 * 设置 DOM 元素的值
 */
async function setDOMValue(kernel, selector, value, opts = {}) {
  const { triggerEvents = true } = opts;

  const code = `
    (() => {
      try {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'Element not found' };
        
        const value = ${JSON.stringify(value)};
        const triggerEvents = ${triggerEvents};
        
        // 设置值
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          el.value = value;
          if (triggerEvents) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } else if (el.isContentEditable) {
          el.innerText = value;
          if (triggerEvents) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else {
          el.innerText = value;
        }
        
        return { ok: true, selector: ${JSON.stringify(selector)}, value };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    })()
  `;

  return await execScript(kernel, code);
}

/**
 * 获取页面的全局变量或数据
 */
async function getPageData(kernel, path) {
  const code = `
    (() => {
      try {
        const path = ${JSON.stringify(path)};
        const parts = path.split('.');
        let obj = window;
        for (const part of parts) {
          if (obj === null || obj === undefined) return { ok: false, error: 'Path not found: ' + path };
          obj = obj[part];
        }
        
        // 尝试序列化
        if (typeof obj === 'function') {
          return { ok: true, type: 'function', value: obj.toString().substring(0, 200) };
        }
        if (typeof obj === 'object' && obj !== null) {
          try {
            return { ok: true, type: 'object', value: JSON.parse(JSON.stringify(obj)) };
          } catch {
            return { ok: true, type: 'object', value: '[Complex Object]' };
          }
        }
        return { ok: true, type: typeof obj, value: obj };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    })()
  `;

  return await execScript(kernel, code);
}

// ------------------------------
// Command wiring
// ------------------------------
async function onLoad(kernel) {
  // 提供服务接口
  kernel.provide(meta.name, 'exec', {
    execScript: (code, opts) => execScript(kernel, code, opts),
    execFunction: (fn, args, opts) => execFunction(kernel, fn, args, opts),
    injectScript: (code, opts) => injectScript(kernel, code, opts),
    removeInjectedScript: (id) => removeInjectedScript(kernel, id),
    queryDOM: (selector, opts) => queryDOM(kernel, selector, opts),
    triggerEvent: (selector, event, opts) => triggerEvent(kernel, selector, event, opts),
    setDOMValue: (selector, value, opts) => setDOMValue(kernel, selector, value, opts),
    getPageData: (path) => getPageData(kernel, path)
  });

  // exec 命令 - 执行任意 JavaScript
  kernel.registerCommand(meta.name, {
    name: 'exec',
    usage: 'exec <code>',
    description: 'Execute JavaScript code in page context (stealth mode).',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      // 过滤掉输出格式参数
      const code = argv.filter(a => a !== '--json' && a !== '-j' && a !== '--pretty').join(' ');
      if (!code.trim()) throw new Error('EXEC: missing code');
      
      const result = await execScript(kernel, code);
      return { ok: result.ok, cmd: 'EXEC', ...result };
    }
  });

  // query 命令 - DOM 查询
  kernel.registerCommand(meta.name, {
    name: 'query',
    usage: 'query <selector> [--all] [--extract prop1,prop2]',
    description: 'Query DOM elements and extract data.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const all = argv.includes('--all');
      
      let extract = null;
      const extractIdx = argv.indexOf('--extract');
      if (extractIdx !== -1 && argv[extractIdx + 1]) {
        extract = argv[extractIdx + 1].split(',').map(s => s.trim());
      }
      
      const selector = argv.filter(a => !a.startsWith('--') && a !== extract?.join(',')).join(' ');
      if (!selector.trim()) throw new Error('QUERY: missing selector');
      
      const result = await queryDOM(kernel, selector, { all, extract });
      return { ok: result.ok, cmd: 'QUERY', selector, ...result };
    }
  });

  // trigger 命令 - 触发事件
  kernel.registerCommand(meta.name, {
    name: 'trigger',
    usage: 'trigger <selector> <event>',
    description: 'Trigger DOM event on element.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      if (argv.length < 2) throw new Error('TRIGGER: missing selector or event');
      
      const eventType = argv.pop();
      const selector = argv.join(' ');
      
      const result = await triggerEvent(kernel, selector, eventType);
      return { ok: result.ok, cmd: 'TRIGGER', ...result };
    }
  });

  // setval 命令 - 设置值
  kernel.registerCommand(meta.name, {
    name: 'setval',
    usage: 'setval <selector> <value>',
    description: 'Set value of DOM element.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      if (argv.length < 2) throw new Error('SETVAL: missing selector or value');
      
      const value = argv.pop();
      const selector = argv.join(' ');
      
      const result = await setDOMValue(kernel, selector, value);
      return { ok: result.ok, cmd: 'SETVAL', ...result };
    }
  });

  // getdata 命令 - 获取页面数据
  kernel.registerCommand(meta.name, {
    name: 'getdata',
    usage: 'getdata <path>',
    description: 'Get page global variable (e.g., window.someData).',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const path = argv.join('.');
      if (!path.trim()) throw new Error('GETDATA: missing path');
      
      const result = await getPageData(kernel, path);
      return { ok: result.ok, cmd: 'GETDATA', path, ...result };
    }
  });

  // inject 命令 - 注入持久化脚本
  kernel.registerCommand(meta.name, {
    name: 'inject',
    usage: 'inject <code>',
    description: 'Inject script to run on every page load.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const code = argv.join(' ');
      if (!code.trim()) throw new Error('INJECT: missing code');
      
      const result = await injectScript(kernel, code);
      return { ok: result.ok, cmd: 'INJECT', ...result };
    }
  });
}

async function onUnload(kernel) {}

module.exports = {
  meta,
  onLoad,
  onUnload
};
