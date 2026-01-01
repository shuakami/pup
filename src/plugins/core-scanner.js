'use strict';

/**
 * core-scanner plugin:
 * - Uses CDP Accessibility (AXTree) + DOM queries to discover actionable nodes.
 * - Produces stable element IDs for current scan.
 * - Provides scanning services to other plugins.
 *
 * This replaces the old visual/DOM-only injector scan with an Accessibility-first approach.
 */

const { toStr } = require('../utils/strings');
const { withTimeout, sleep } = require('../utils/async');
const { pMap } = require('../utils/promise-pool');

const meta = {
  name: 'core-scanner',
  description: 'AXTree-based scanner for actionable elements (high precision)',
  cliOptions: [
    { flags: '--filter <text>', description: 'Filter output by substring (type/text/value)' }
  ]
};

const ACTIONABLE_ROLES = new Set([
  'button', 'link', 'checkbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'switch', 'tab', 'option', 'radio', 'slider', 'spinbutton', 'textbox', 'combobox',
  'listbox', 'searchbox', 'treeitem', 'gridcell', 'row', 'listitem'
]);

const ACTIONABLE_CONTROL_TYPES = new Set([
  'button', 'link', 'checkbox', 'radio', 'textbox', 'combobox', 'listbox', 'menuitem',
  'tab', 'option', 'slider', 'spinbutton'
]);

// 语义类型别名映射 - 搜索 "input" 时也能找到 textbox/combobox/searchbox 等
const TYPE_ALIASES = {
  'input': ['textbox', 'combobox', 'searchbox', 'input', 'textarea', 'spinbutton'],
  'textbox': ['textbox', 'combobox', 'searchbox', 'input', 'textarea'],
  'text': ['textbox', 'combobox', 'searchbox', 'input', 'textarea'],
  'search': ['searchbox', 'combobox', 'textbox'],
  'button': ['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio'],
  'btn': ['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio'],
  'link': ['link'],
  'checkbox': ['checkbox', 'switch', 'menuitemcheckbox'],
  'check': ['checkbox', 'switch', 'menuitemcheckbox'],
  'radio': ['radio', 'menuitemradio'],
  'select': ['combobox', 'listbox', 'select'],
  'dropdown': ['combobox', 'listbox', 'select'],
  'menu': ['menuitem', 'menuitemcheckbox', 'menuitemradio'],
  'tab': ['tab'],
  'slider': ['slider', 'spinbutton'],
  'list': ['listbox', 'listitem', 'treeitem'],
};

/**
 * 展开类型别名 - 返回所有匹配的类型
 */
function expandTypeAliases(filterText) {
  const f = filterText.toLowerCase().trim();
  // 检查是否是类型别名
  if (TYPE_ALIASES[f]) {
    return TYPE_ALIASES[f];
  }
  return null;
}

function sanitizeText(s) {
  if (!s) return '';
  return String(s).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}

function isProbablyActionable(axNode) {
  if (!axNode || axNode.ignored) return false;

  const role = toStr(axNode.role && axNode.role.value).toLowerCase();
  const name = sanitizeText(axNode.name && axNode.name.value);
  const value = sanitizeText(axNode.value && axNode.value.value);
  const desc = sanitizeText(axNode.description && axNode.description.value);

  if (ACTIONABLE_ROLES.has(role)) return true;
  if (ACTIONABLE_CONTROL_TYPES.has(role)) return true;

  // Heuristic: focusable or clickable hints
  const props = Array.isArray(axNode.properties) ? axNode.properties : [];
  for (const p of props) {
    const pn = toStr(p && p.name).toLowerCase();
    const pv = p && p.value ? p.value.value : null;
    if (pn === 'focusable' && pv === true) return true;
    if (pn === 'editable' && pv === true) return true;
    if (pn === 'enabled' && pv === true && role) return true;
  }

  // text nodes not actionable
  if (!role) return false;

  // if it has a name and role suggests structure, still not necessarily actionable
  if (name && (role === 'heading' || role === 'statictext')) return false;

  // fallback: if it has value/desc and is focusable
  if ((value || desc) && props.some(p => toStr(p.name).toLowerCase() === 'focusable' && p.value && p.value.value === true)) {
    return true;
  }

  return false;
}

async function getViewportSize(kernel) {
  const page = await kernel.page();
  return await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
}

async function getLayoutMetrics(cdp) {
  try {
    const m = await cdp.send('Page.getLayoutMetrics', {}, { timeoutMs: 2500, label: 'Page.getLayoutMetrics' });
    return m;
  } catch {
    return null;
  }
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function computeClickablePointFromQuad(quad, viewportW, viewportH) {
  if (!Array.isArray(quad) || quad.length < 8) return null;

  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);

  const w = right - left;
  const h = bottom - top;
  if (w < 5 || h < 5) return null;

  const cx = clamp(left + w * 0.5, 0, viewportW - 1);
  const cy = clamp(top + h * 0.5, 0, viewportH - 1);

  return {
    x: Math.floor(cx),
    y: Math.floor(cy),
    rect: {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(w),
      height: Math.round(h)
    }
  };
}

async function domGetBoxModel(cdp, backendNodeId) {
  // Use a tight timeout to prevent hangs.
  const res = await cdp.send('DOM.getBoxModel', { backendNodeId }, { timeoutMs: 2500, label: 'DOM.getBoxModel' });
  if (!res || !res.model) return null;
  return res.model;
}

async function scanViewport(kernel) {
  const cdp = await kernel.cdp();
  await cdp.enable('Accessibility');
  await cdp.enable('DOM');
  await cdp.enable('Runtime');
  await cdp.enable('Page');

  const layout = await getLayoutMetrics(cdp);
  const vp = await getViewportSize(kernel);
  const viewportW = vp.w || 0;
  const viewportH = vp.h || 0;

  const maxElements = Number(kernel.config.MAX_SCAN_ELEMENTS || 800);

  const ax = await cdp.send('Accessibility.getFullAXTree', {}, { timeoutMs: 4000, label: 'Accessibility.getFullAXTree' });
  const nodes = Array.isArray(ax && ax.nodes) ? ax.nodes : [];

  const candidates = [];
  for (const n of nodes) {
    if (!isProbablyActionable(n)) continue;
    const backendDOMNodeId = n.backendDOMNodeId;
    if (!backendDOMNodeId) continue;

    const role = toStr(n.role && n.role.value).toLowerCase();
    const name = sanitizeText(n.name && n.name.value);
    const value = sanitizeText(n.value && n.value.value);
    const desc = sanitizeText(n.description && n.description.value);
    const text = name || desc || value || '';

    candidates.push({
      backendDOMNodeId: Number(backendDOMNodeId),
      role,
      text,
      value: value || null
    });

    if (candidates.length >= maxElements * 3) break; // avoid extreme trees
  }

  // Deduplicate by backendNodeId
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const k = String(c.backendDOMNodeId);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(c);
  }


// For each candidate, fetch box model to check viewport intersection.
// 性能优化：并发拉取 BoxModel，收集所有元素后按 y 坐标排序
const rawElements = [];
const truncated = unique.length > maxElements;

const CONCURRENCY = 8; // conservative; do NOT change timeouts/design
for (let offset = 0; offset < unique.length && rawElements.length < maxElements; offset += CONCURRENCY) {
  const batch = unique.slice(offset, offset + CONCURRENCY);

  const batchModels = await Promise.all(batch.map(async (c) => {
    try {
      const model = await domGetBoxModel(cdp, c.backendDOMNodeId);
      return { c, model };
    } catch {
      return null;
    }
  }));

  for (const item of batchModels) {
    if (!item || !item.model) continue;
    if (rawElements.length >= maxElements) break;

    const c = item.c;
    const model = item.model;

    // prefer border quad
    const quad = model.border || model.content;
    if (!quad || quad.length < 8) continue;

    // LayoutMetrics includes visualViewport offset; but quad is in CSS pixels in frame space.
    // We still keep x/y as best-effort; interaction computes exact points via JS later.
    const pt = computeClickablePointFromQuad(quad, viewportW, viewportH);
    if (!pt) continue;

    rawElements.push({
      type: c.role || 'element',
      role: c.role || null,
      text: c.text || '',
      x: pt.x,
      y: pt.y,
      w: pt.rect.width,
      h: pt.rect.height,
      value: c.value,
      checked: null,
      completed: null,
      backendDOMNodeId: c.backendDOMNodeId
    });
  }
}

// 按视觉位置排序，优先显示视口内完全可见的元素
// 1. 部分超出视口的元素（右边缘超出）排在后面
// 2. 按 y 坐标排序（页面顶部优先）
// 3. y 相同时按 x 排序（从左到右）
rawElements.sort((a, b) => {
  // 元素右边缘超出视口的排在后面
  const aOutside = (a.x + a.w / 2) > viewportW;
  const bOutside = (b.x + b.w / 2) > viewportW;
  if (aOutside !== bOutside) return aOutside ? 1 : -1;
  
  // 按 y 坐标排序
  if (a.y !== b.y) return a.y - b.y;
  // y 相同时按 x 排序
  return a.x - b.x;
});

// 标记同一行的小元素，用于显示时紧凑输出
// 每个元素保留独立 id，不合并
const ROW_THRESHOLD = 10; // y 坐标差值小于此值视为同一行
const MIN_ROW_ELEMENTS = 4; // 至少 4 个元素才标记为行
const MAX_ELEMENT_WIDTH = 150; // 宽度小于此值的元素才参与行标记

const elements = [];
let rowId = 0;
let i = 0;
while (i < rawElements.length) {
  const current = rawElements[i];
  
  // 检查是否可以形成行
  if (current.w < MAX_ELEMENT_WIDTH) {
    // 收集同一行的小元素
    const rowStart = i;
    let j = i + 1;
    while (j < rawElements.length) {
      const next = rawElements[j];
      if (Math.abs(next.y - current.y) < ROW_THRESHOLD && next.w < MAX_ELEMENT_WIDTH) {
        j++;
      } else {
        break;
      }
    }
    
    const rowLength = j - rowStart;
    // 如果同一行有足够多的小元素，标记它们
    if (rowLength >= MIN_ROW_ELEMENTS) {
      rowId++;
      for (let k = rowStart; k < j; k++) {
        elements.push({
          ...rawElements[k],
          id: elements.length + 1,
          _row: rowId,
          _rowPos: k - rowStart,
          _rowLen: rowLength
        });
      }
      i = j;
      continue;
    }
  }
  
  // 普通元素
  elements.push({
    ...current,
    id: elements.length + 1
  });
  i++;
}

  const page = await kernel.page();
  let title = '';
  let url = '';
  try { title = await page.title(); } catch {}
  try { url = toStr(page.url()); } catch {}

  const result = {
    title,
    url,
    viewport: { w: viewportW, h: viewportH },
    truncated: truncated || false,
    totalFound: candidates.length,
    elements
  };

  return result;
}

/**
 * DOM 增强扫描 - 获取更丰富的文本内容
 * 用于 listitem 等元素，AXTree 可能没有完整的文本
 */
async function enhanceWithDOM(kernel, elements) {
  const cdp = await kernel.cdp();
  await cdp.enable('DOM');
  await cdp.enable('Runtime');

  const list = Array.isArray(elements) ? elements : [];
  const CONCURRENCY = 3; // conservative; avoids overloading Runtime/DOM

  const enhanced = await pMap(list, async (el) => {
    // 如果已经有足够的文本，跳过
    if (el.text && el.text.length > 30) return el;

    // 只增强 listitem 和 generic 类型
    if (el.type !== 'listitem' && el.type !== 'generic') return el;

    try {
      // 使用 backendDOMNodeId 精确定位元素
      const resolved = await cdp.send('DOM.resolveNode', {
        backendNodeId: el.backendDOMNodeId
      }, { timeoutMs: 1500, label: 'DOM.resolveNode(enhance)' });

      if (!resolved || !resolved.object || !resolved.object.objectId) return el;

      const result = await cdp.send('Runtime.callFunctionOn', {
        objectId: resolved.object.objectId,
        functionDeclaration: `function() {
          try {
            const el = this;
            let text = '';

            // 查找产品标题
            const titleEl = el.querySelector('h2, h2 a, [data-cy="title-recipe"], .a-text-normal, .a-link-normal .a-text-normal');
            if (titleEl) {
              text = (titleEl.innerText || titleEl.textContent || '').trim();
            }

            // 查找价格
            const priceEl = el.querySelector('.a-price .a-offscreen, .a-price-whole');
            if (priceEl) {
              const price = (priceEl.textContent || '').trim();
              if (price && price.startsWith('$')) {
                text += text ? ' | ' + price : price;
              }
            }

            // 查找评分
            const ratingEl = el.querySelector('[aria-label*="out of 5"], .a-icon-alt');
            if (ratingEl) {
              const rating = ratingEl.getAttribute('aria-label') || '';
              const match = rating.match(/([\\d.]+) out of 5/);
              if (match) {
                text += text ? ' | ★' + match[1] : '★' + match[1];
              }
            }

            // 如果没有找到特定内容，使用 innerText 的前 80 字符
            if (!text) {
              text = (el.innerText || '').substring(0, 80).replace(/\\n+/g, ' ').trim();
            }

            return { ok: true, text: text.substring(0, 100) };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        }`,
        returnByValue: true
      }, { timeoutMs: 2000, label: 'enhance(callFunctionOn)' });

      const v = result && result.result ? result.result.value : null;
      if (v && v.ok && v.text) return { ...el, text: v.text };
      return el;
    } catch {
      return el;
    }
  }, { concurrency: CONCURRENCY, stopOnError: false });

  return enhanced;
}

async function scanAll(kernel) {
  const cdp = await kernel.cdp();
  await cdp.enable('Page');

  // Scroll to top
  const vp = await getViewportSize(kernel);
  const x = Math.floor((vp.w || 1) / 2);
  const y = Math.floor((vp.h || 1) / 2);

  for (let i = 0; i < 10; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -2000, pointerType: 'mouse' }, { timeoutMs: 3000, label: 'scrollTop' });
    await sleep(30);
  }
  await sleep(250);

  const all = [];
  const seenKeys = new Set();

  let noNew = 0;
  while (noNew < 4) {
    const before = all.length;
    const res = await scanViewport(kernel);

    for (const el of (res.elements || [])) {
      const key = `${el.type}|${(el.text || '').substring(0, 80)}|${el.value || ''}|${el.backendDOMNodeId || ''}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      all.push({ ...el, id: all.length + 1 });
    }

    if (all.length === before) noNew += 1;
    else noNew = 0;

    // scroll down
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x, y,
      deltaX: 0,
      deltaY: (vp.h || 800) * 0.7,
      pointerType: 'mouse'
    }, { timeoutMs: 3000, label: 'scrollDown' });

    await sleep(250);
  }

  // Return to top (best effort)
  for (let i = 0; i < 10; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -2000, pointerType: 'mouse' }, { timeoutMs: 3000, label: 'scrollTop2' });
    await sleep(30);
  }

  const page = await kernel.page();
  let title = '';
  let url = '';
  try { title = await page.title(); } catch {}
  try { url = toStr(page.url()); } catch {}

  return {
    title,
    url,
    viewport: { w: vp.w || 0, h: vp.h || 0 },
    elements: all
  };
}

let _lastScan = null;
let _idToMeta = new Map();

function indexScan(scanRes) {
  _lastScan = scanRes;
  _idToMeta = new Map();
  for (const el of (scanRes.elements || [])) {
    _idToMeta.set(el.id, el);
  }
}

async function findByText(kernel, text) {
  const q = sanitizeText(text).toLowerCase();
  if (!q) return null;
  const res = await scanViewport(kernel);
  indexScan(res);
  const matches = (res.elements || []).filter(e => (e.text || '').toLowerCase().includes(q));
  return matches.length ? matches[0] : null;
}

async function onLoad(kernel) {
  // expose service for other plugins
  kernel.provide(meta.name, 'scanner', {
    scan: async () => {
      const res = await scanViewport(kernel);
      indexScan(res);
      return res;
    },
    scanAll: async () => {
      const res = await scanAll(kernel);
      indexScan(res);
      return res;
    },
    findByText: async (text) => findByText(kernel, text),
    getLastScan: () => _lastScan,
    getNodeMeta: (id) => _idToMeta.get(Number(id)) || null
  });

  // command: scan
  kernel.registerCommand(meta.name, {
    name: 'scan',
    usage: 'scan [--filter <text>] [--limit <n>] [--no-empty] [--deep]',
    description: 'Scan current viewport for actionable elements (AXTree-based).',
    cliOptions: [
      { flags: '--filter <text>', description: 'Filter by type/text/value' },
      { flags: '--limit <n>', description: 'Limit output to N elements' },
      { flags: '--no-empty', description: 'Hide elements without text' },
      { flags: '--deep', description: 'Use DOM enhancement for richer text' }
    ],
    handler: async (ctx) => {
      const argv = Array.isArray(ctx.argv) ? ctx.argv : [];
      const filterIdx = argv.indexOf('--filter');
      const filter = filterIdx >= 0 ? sanitizeText(argv[filterIdx + 1]) : '';
      const limitIdx = argv.indexOf('--limit');
      const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : 0;
      const noEmpty = argv.includes('--no-empty');
      const deep = argv.includes('--deep');
      
      const res = await kernel.getService('scanner').scan();
      
      // DOM 增强 - 获取更丰富的文本
      if (deep && res.elements && res.elements.length > 0) {
        res.elements = await enhanceWithDOM(kernel, res.elements);
      }

      // 过滤空元素
      if (noEmpty) {
        res.elements = (res.elements || []).filter(e => {
          const text = (e.text || '').trim();
          const value = (e.value || '').trim();
          return text || value;
        });
      }

      if (filter) {
        const f = filter.toLowerCase();
        const typeAliases = expandTypeAliases(f);
        
        res.elements = (res.elements || []).filter(e => {
          // 如果是类型别名，检查元素类型是否在别名列表中
          if (typeAliases) {
            const elType = (e.type || '').toLowerCase();
            if (typeAliases.includes(elType)) return true;
          }
          // 普通文本匹配
          return (e.text && e.text.toLowerCase().includes(f)) ||
            (e.type && e.type.toLowerCase().includes(f)) ||
            (e.value && String(e.value).toLowerCase().includes(f));
        });
      }
      
      if (limit > 0 && res.elements && res.elements.length > limit) {
        res.truncated = true;
        res.totalFound = res.elements.length;
        res.elements = res.elements.slice(0, limit);
      }

      return { ok: true, cmd: 'SCAN', ...res };
    }
  });

  // command: scanall
  kernel.registerCommand(meta.name, {
    name: 'scanall',
    usage: 'scanall [--filter <text>] [--limit <n>]',
    description: 'Scan entire page by scrolling and accumulating elements.',
    cliOptions: [
      { flags: '--filter <text>', description: 'Filter by type/text/value' },
      { flags: '--limit <n>', description: 'Limit output to N elements' }
    ],
    handler: async (ctx) => {
      const argv = Array.isArray(ctx.argv) ? ctx.argv : [];
      const filterIdx = argv.indexOf('--filter');
      const filter = filterIdx >= 0 ? sanitizeText(argv[filterIdx + 1]) : '';
      const limitIdx = argv.indexOf('--limit');
      const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : 0;
      
      const res = await kernel.getService('scanner').scanAll();

      if (filter) {
        const f = filter.toLowerCase();
        const typeAliases = expandTypeAliases(f);
        
        res.elements = (res.elements || []).filter(e => {
          // 如果是类型别名，检查元素类型是否在别名列表中
          if (typeAliases) {
            const elType = (e.type || '').toLowerCase();
            if (typeAliases.includes(elType)) return true;
          }
          // 普通文本匹配
          return (e.text && e.text.toLowerCase().includes(f)) ||
            (e.type && e.type.toLowerCase().includes(f)) ||
            (e.value && String(e.value).toLowerCase().includes(f));
        });
      }
      
      if (limit > 0 && res.elements && res.elements.length > limit) {
        res.truncated = true;
        res.totalFound = res.elements.length;
        res.elements = res.elements.slice(0, limit);
      }

      return { ok: true, cmd: 'SCANALL', ...res };
    }
  });

  // command: find
  kernel.registerCommand(meta.name, {
    name: 'find',
    usage: 'find <text> [--limit <n>]',
    description: 'Quick scan and return matching elements by text.',
    cliOptions: [
      { flags: '--limit <n>', description: 'Limit output to N elements' }
    ],
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const limitIdx = argv.indexOf('--limit');
      const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : 0;
      
      // 过滤掉 --limit 和它的值
      const textParts = argv.filter((a, i) => {
        if (limitIdx < 0) return true; // 没有 --limit，保留所有
        return i !== limitIdx && i !== limitIdx + 1;
      });
      const q = sanitizeText(textParts.join(' '));
      if (!q) throw new Error('FIND: missing text');
      
      const res = await kernel.getService('scanner').scan();
      const f = q.toLowerCase();
      let matches = (res.elements || []).filter(e =>
        (e.text && e.text.toLowerCase().includes(f)) ||
        (e.value && String(e.value).toLowerCase().includes(f))
      );
      
      const totalFound = matches.length;
      if (limit > 0 && matches.length > limit) {
        matches = matches.slice(0, limit);
      }
      
      return { ok: true, cmd: 'FIND', query: q, totalFound, matches };
    }
  });
}

async function onUnload(kernel) {
  // Kernel cleanupPlugin will remove commands/services.
}

module.exports = {
  meta,
  onLoad,
  onUnload
};
