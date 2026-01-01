'use strict';

const config = require('./config');

const INJECTOR_SCRIPT = `(() => {
  try {
    const TOP_WIN = window;
    const TOP_DOC = document;
    const MAX_ELEMENTS = ${Number.isFinite(config.MAX_SCAN_ELEMENTS) ? config.MAX_SCAN_ELEMENTS : 800};

    const ACTIONABLE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS']);
    const ACTIONABLE_ROLES = new Set([
      'button', 'link', 'checkbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 
      'switch', 'tab', 'option', 'radio', 'slider', 'spinbutton', 'textbox', 'combobox',
      'listbox', 'searchbox', 'treeitem', 'gridcell', 'row', 'listitem'
    ]);

    function viewportSize(win, doc) {
      const w = (win && typeof win.innerWidth === 'number') ? win.innerWidth : (doc && doc.documentElement ? doc.documentElement.clientWidth : 0);
      const h = (win && typeof win.innerHeight === 'number') ? win.innerHeight : (doc && doc.documentElement ? doc.documentElement.clientHeight : 0);
      return { w: Math.max(0, w), h: Math.max(0, h) };
    }

    function clamp(n, min, max) {
      return Math.min(max, Math.max(min, n));
    }

    function cleanText(s) {
      if (!s) return '';
      return String(s).replace(/\\s+/g, ' ').trim();
    }

    function safeComputedStyle(el) {
      try {
        const win = el && el.ownerDocument ? el.ownerDocument.defaultView : null;
        if (!win || !win.getComputedStyle) return null;
        return win.getComputedStyle(el);
      } catch {
        return null;
      }
    }

    function isHiddenByStyle(el, style) {
      if (!el) return true;
      if (el.hidden) return true;
      if (!style) return false;
      if (style.display === 'none') return true;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
      const op = Number(style.opacity);
      if (!Number.isNaN(op) && op <= 0.01) return true;
      if (style.pointerEvents === 'none') return true;
      return false;
    }

    function isDisabled(el) {
      try {
        if (!el) return true;
        if (typeof el.disabled === 'boolean' && el.disabled) return true;
        const ariaDisabled = el.getAttribute && el.getAttribute('aria-disabled');
        if (ariaDisabled && String(ariaDisabled).toLowerCase() === 'true') return true;
        return false;
      } catch {
        return false;
      }
    }

    function roleOf(el) {
      try {
        const r = el.getAttribute && el.getAttribute('role');
        return r ? String(r).toLowerCase().trim() : '';
      } catch {
        return '';
      }
    }

    function isActionable(el) {
      if (!el || !el.tagName) return false;
      const tag = el.tagName.toUpperCase();
      const role = roleOf(el);

      if (ACTIONABLE_TAGS.has(tag)) {
        if (tag === 'A') {
          const href = el.getAttribute && el.getAttribute('href');
          if (href && cleanText(href)) return true;
          if (role === 'link') return true;
          if (typeof el.tabIndex === 'number' && el.tabIndex >= 0) return true;
          const onclickAttr = el.getAttribute && el.getAttribute('onclick');
          if (onclickAttr && cleanText(onclickAttr)) return true;
          const style = safeComputedStyle(el);
          if (style && style.cursor === 'pointer') return true;
          return false;
        }
        if (tag === 'INPUT') {
          const type = (el.getAttribute && el.getAttribute('type')) ? String(el.getAttribute('type')).toLowerCase() : (el.type ? String(el.type).toLowerCase() : '');
          if (type === 'hidden') return false;
          return true;
        }
        return true;
      }

      if (role && ACTIONABLE_ROLES.has(role)) return true;

      try {
        if (el.isContentEditable) return true;
      } catch {
        // ignore
      }

      // Check for tabindex making element focusable/interactive
      const tabindex = el.getAttribute && el.getAttribute('tabindex');
      if (tabindex !== null && tabindex !== '-1') {
        const style = safeComputedStyle(el);
        if (style && style.cursor === 'pointer') return true;
        // Elements with tabindex >= 0 and some text/aria-label are likely interactive
        if (typeof el.tabIndex === 'number' && el.tabIndex >= 0) {
          const al = el.getAttribute && el.getAttribute('aria-label');
          const text = cleanText(el.innerText || '');
          if ((al && cleanText(al)) || text) return true;
        }
      }

      // heuristic: pointer cursor + tabindex or aria-label/title
      const style = safeComputedStyle(el);
      if (style && style.cursor === 'pointer') {
        if (tabindex && cleanText(tabindex)) return true;
        if (typeof el.tabIndex === 'number' && el.tabIndex >= 0) return true;
        const al = el.getAttribute && el.getAttribute('aria-label');
        const ti = el.getAttribute && el.getAttribute('title');
        if ((al && cleanText(al)) || (ti && cleanText(ti))) return true;
        // Also check for text content with pointer cursor
        const text = cleanText(el.innerText || '');
        if (text && text.length < 200) return true;
      }

      // attribute onclick heuristic
      const onclickAttr = el.getAttribute && el.getAttribute('onclick');
      if (onclickAttr && cleanText(onclickAttr)) return true;

      // Check for common interactive class patterns
      const className = el.className ? String(el.className) : '';
      if (className && /\b(clickable|selectable|interactive|btn|button)\b/i.test(className)) {
        return true;
      }

      // Custom elements with href-like data attributes (YouTube, etc.)
      if (tag.includes('-')) {
        // Web Component - check for common interactive patterns
        const href = el.getAttribute && (el.getAttribute('href') || el.getAttribute('data-href'));
        if (href && cleanText(href)) return true;
        // Check if it has a nested <a> as first meaningful child
        try {
          const firstLink = el.querySelector('a[href]');
          if (firstLink) {
            const linkRect = firstLink.getBoundingClientRect();
            const elRect = el.getBoundingClientRect();
            // If the link covers most of the element, consider the element actionable
            if (linkRect.width > elRect.width * 0.5 && linkRect.height > elRect.height * 0.5) {
              return true;
            }
          }
        } catch {}
      }

      // Elements with data-* navigation attributes
      const dataHref = el.getAttribute && el.getAttribute('data-href');
      const dataUrl = el.getAttribute && el.getAttribute('data-url');
      const dataLink = el.getAttribute && el.getAttribute('data-link');
      if ((dataHref && cleanText(dataHref)) || (dataUrl && cleanText(dataUrl)) || (dataLink && cleanText(dataLink))) {
        return true;
      }

      // Check for data-symbol, data-name (common in financial/search UIs)
      const dataSymbol = el.getAttribute && el.getAttribute('data-symbol');
      const dataName = el.getAttribute && el.getAttribute('data-name');
      const dataId = el.getAttribute && el.getAttribute('data-id');
      const dataValue = el.getAttribute && el.getAttribute('data-value');
      if ((dataSymbol && cleanText(dataSymbol)) || (dataName && cleanText(dataName)) || 
          (dataId && cleanText(dataId)) || (dataValue && cleanText(dataValue))) {
        // Only if it looks interactive (has some text or is reasonably sized)
        const text = cleanText(el.innerText || '');
        if (text && text.length < 200) return true;
      }

      // Check for aria-haspopup or aria-expanded (interactive elements)
      const hasPopup = el.getAttribute && el.getAttribute('aria-haspopup');
      const expanded = el.getAttribute && el.getAttribute('aria-expanded');
      if (hasPopup || expanded !== null) {
        return true;
      }

      return false;
    }

    function classify(el) {
      const tag = el.tagName ? el.tagName.toUpperCase() : '';
      const role = roleOf(el);

      if (role) {
        if (role === 'button') return 'button';
        if (role === 'link') return 'link';
        if (role === 'checkbox' || role === 'switch' || role === 'radio') return 'checkbox';
        if (role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio') return 'menuitem';
        if (role === 'tab') return 'tab';
        if (role === 'option' || role === 'listitem' || role === 'treeitem') return 'option';
        if (role === 'row' || role === 'gridcell') return 'row';
        if (role === 'listbox' || role === 'combobox') return 'select';
        if (role === 'textbox' || role === 'searchbox') return 'input';
        if (role === 'slider' || role === 'spinbutton') return 'input';
      }

      if (tag === 'A') return 'link';
      if (tag === 'BUTTON') return 'button';
      if (tag === 'SELECT') return 'select';
      if (tag === 'TEXTAREA') return 'textarea';
      if (tag === 'SUMMARY') return 'button';
      if (tag === 'DETAILS') return 'button';
      if (tag === 'INPUT') {
        const type = (el.getAttribute && el.getAttribute('type')) ? String(el.getAttribute('type')).toLowerCase() : (el.type ? String(el.type).toLowerCase() : '');
        if (type === 'checkbox' || type === 'radio') return 'checkbox';
        return 'input';
      }
      if (el.isContentEditable) return 'editable';
      
      // Custom elements - try to determine type from content/attributes
      if (tag.includes('-')) {
        const href = el.getAttribute && (el.getAttribute('href') || el.getAttribute('data-href'));
        if (href) return 'link';
        const hasNestedLink = el.querySelector && el.querySelector('a[href]');
        if (hasNestedLink) return 'link';
      }
      
      return 'element';
    }

    function extractLabel(el) {
      try {
        // aria-label takes highest priority (most semantic)
        const aria = el.getAttribute && el.getAttribute('aria-label');
        if (aria && cleanText(aria)) return cleanText(aria);

        // prefer element-provided text
        let t = cleanText(el.innerText || '');
        if (t) return t;

        // textContent as fallback (includes hidden text)
        t = cleanText(el.textContent || '');
        if (t) return t;

        const title = el.getAttribute && el.getAttribute('title');
        if (title && cleanText(title)) return cleanText(title);

        const placeholder = el.getAttribute && el.getAttribute('placeholder');
        if (placeholder && cleanText(placeholder)) return cleanText(placeholder);

        const alt = el.getAttribute && el.getAttribute('alt');
        if (alt && cleanText(alt)) return cleanText(alt);

        // associated <label> for inputs
        if (el.labels && el.labels.length) {
          const lbl = cleanText(el.labels[0].innerText || el.labels[0].textContent || '');
          if (lbl) return lbl;
        }

        // input value as last resort (e.g., submit button)
        if (typeof el.value !== 'undefined') {
          const v = cleanText(el.value);
          if (v) return v;
        }

        // For links, try to extract meaningful text from href
        if (el.tagName === 'A' && el.href) {
          const href = String(el.href);
          // Extract last path segment
          try {
            const url = new URL(href);
            const path = url.pathname;
            const segments = path.split('/').filter(s => s);
            if (segments.length > 0) {
              const last = segments[segments.length - 1];
              // Clean up the segment (remove file extensions, decode)
              const cleaned = decodeURIComponent(last).replace(/\\.[a-z]+$/i, '').replace(/[-_]/g, ' ');
              if (cleaned && cleaned.length > 2 && cleaned.length < 50) {
                return cleaned;
              }
            }
          } catch {}
        }

        return '';
      } catch {
        return '';
      }
    }

    function isWithinTarget(target, topEl) {
      if (!target || !topEl) return false;
      if (topEl === target) return true;
      try {
        if (target.contains && target.contains(topEl)) return true;
      } catch {}
      // shadow DOM: topEl might be in a (possibly closed) shadow root whose host is target
      try {
        const root = topEl.getRootNode ? topEl.getRootNode() : null;
        if (root && root.host && root.host === target) return true;
      } catch {}
      // open shadow root containment
      try {
        if (target.shadowRoot && target.shadowRoot.contains(topEl)) return true;
      } catch {}
      return false;
    }

    function intersectsViewport(globalRect, topW, topH) {
      const left = globalRect.left;
      const top = globalRect.top;
      const right = globalRect.left + globalRect.width;
      const bottom = globalRect.top + globalRect.height;
      return !(right <= 0 || bottom <= 0 || left >= topW || top >= topH);
    }

    function visibleRectIntersection(globalRect, topW, topH) {
      const left = clamp(globalRect.left, 0, topW);
      const top = clamp(globalRect.top, 0, topH);
      const right = clamp(globalRect.left + globalRect.width, 0, topW);
      const bottom = clamp(globalRect.top + globalRect.height, 0, topH);
      const w = Math.max(0, right - left);
      const h = Math.max(0, bottom - top);
      return { left, top, right, bottom, w, h };
    }

    function generateSamplePoints(intersection) {
      const { left, top, right, bottom, w, h } = intersection;
      if (w < 1 || h < 1) return [];

      const xs = [0.5, 0.25, 0.75].map((r) => left + w * r);
      const ys = [0.5, 0.25, 0.75].map((r) => top + h * r);

      const points = [];
      for (const y of ys) {
        for (const x of xs) {
          points.push({ x: Math.floor(x), y: Math.floor(y) });
        }
      }

      // also include near-corner insets (helps with sticky overlays)
      const inset = 2;
      points.push({ x: Math.floor(clamp(left + inset, 0, right - 1)), y: Math.floor(clamp(top + inset, 0, bottom - 1)) });
      points.push({ x: Math.floor(clamp(right - inset, 0, right - 1)), y: Math.floor(clamp(top + inset, 0, bottom - 1)) });
      points.push({ x: Math.floor(clamp(left + inset, 0, right - 1)), y: Math.floor(clamp(bottom - inset, 0, bottom - 1)) });
      points.push({ x: Math.floor(clamp(right - inset, 0, right - 1)), y: Math.floor(clamp(bottom - inset, 0, bottom - 1)) });

      // dedupe
      const seen = new Set();
      const uniq = [];
      for (const p of points) {
        const k = p.x + ',' + p.y;
        if (seen.has(k)) continue;
        seen.add(k);
        uniq.push(p);
      }
      return uniq;
    }

    function isTopLayerAtPoint(targetEl, targetDoc, globalX, globalY, iframeChain) {
      // Verify each iframe in the chain is top-most at the point (in its parent doc),
      // then verify the target element is top-most at the point (in its own doc).
      try {
        let currentDoc = TOP_DOC;
        let offsetX = 0;
        let offsetY = 0;

        for (const iframeEl of iframeChain) {
          if (!iframeEl || !iframeEl.getBoundingClientRect) return false;
          const localX = globalX - offsetX;
          const localY = globalY - offsetY;
          const topAtPoint = currentDoc.elementFromPoint(localX, localY);
          if (topAtPoint !== iframeEl) return false;
          const r = iframeEl.getBoundingClientRect();
          offsetX += r.left;
          offsetY += r.top;
          const nextDoc = iframeEl.contentDocument;
          if (!nextDoc) return false;
          currentDoc = nextDoc;
        }

        const localX = globalX - offsetX;
        const localY = globalY - offsetY;
        const topInDoc = targetDoc.elementFromPoint(localX, localY);
        return isWithinTarget(targetEl, topInDoc);
      } catch {
        return false;
      }
    }

    function computeGlobalRect(el, offsetX, offsetY) {
      const r = el.getBoundingClientRect();
      return { left: offsetX + r.left, top: offsetY + r.top, width: r.width, height: r.height };
    }

    function tryFindClickablePoint(el, doc, globalRect, iframeChain, topW, topH) {
      if (!intersectsViewport(globalRect, topW, topH)) return null;
      const inter = visibleRectIntersection(globalRect, topW, topH);
      if (inter.w < 5 || inter.h < 5) return null;
      const points = generateSamplePoints(inter);
      for (const p of points) {
        if (p.x < 0 || p.y < 0 || p.x >= topW || p.y >= topH) continue;
        if (isTopLayerAtPoint(el, doc, p.x, p.y, iframeChain)) return p;
      }
      return null;
    }

    function traverseDocument(doc, win, offsetX, offsetY, iframeChain, out) {
      if (!doc || !doc.documentElement) return;
      const root = doc.documentElement;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
      let node = walker.currentNode;

      while (node) {
        const el = node;

        // Collect actionable items
        if (isActionable(el) && !isDisabled(el)) {
          const style = safeComputedStyle(el);
          const globalRect = computeGlobalRect(el, offsetX, offsetY);
          if (globalRect.width >= 5 && globalRect.height >= 5 && !isHiddenByStyle(el, style)) {
            const topSize = viewportSize(TOP_WIN, TOP_DOC);
            if (intersectsViewport(globalRect, topSize.w, topSize.h)) {
              const point = tryFindClickablePoint(el, doc, globalRect, iframeChain, topSize.w, topSize.h);
              if (point) {
                const text = extractLabel(el);
                const type = classify(el);
                let value = null;
                let checked = null;
                let completed = null;
                try {
                  // Get value from input/textarea directly
                  if (type === 'input' || type === 'textarea' || type === 'editable' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    if (typeof el.value !== 'undefined') value = String(el.value);
                  }
                  // For combobox/select, try to find nested input or get value
                  if (type === 'select' && value === null) {
                    const nestedInput = el.querySelector && el.querySelector('input');
                    if (nestedInput && typeof nestedInput.value !== 'undefined') {
                      value = String(nestedInput.value);
                    } else if (typeof el.value !== 'undefined') {
                      value = String(el.value);
                    }
                  }
                } catch {}
                try {
                  if (type === 'checkbox' || (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'checkbox')) {
                    if (typeof el.checked === 'boolean') checked = !!el.checked;
                  }
                } catch {}
                // Check for completion status (Microsoft Rewards specific)
                try {
                  // Look for SkypeCircleCheck icon or "已获得的积分" aria-label
                  const checkIcon = el.querySelector && el.querySelector('.mee-icon-SkypeCircleCheck, [aria-label*="已获得"], [aria-label*="完成"]');
                  if (checkIcon) {
                    completed = true;
                  } else {
                    // Also check aria-label on nested elements
                    const ariaLabels = el.querySelectorAll && el.querySelectorAll('[aria-label]');
                    if (ariaLabels) {
                      for (const labeled of ariaLabels) {
                        const al = labeled.getAttribute('aria-label') || '';
                        if (al.includes('已获得') || al.includes('完成')) {
                          completed = true;
                          break;
                        }
                      }
                    }
                  }
                  // Check for "将获得" which means NOT completed
                  if (!completed) {
                    const pendingIcon = el.querySelector && el.querySelector('[aria-label*="将获得"]');
                    if (pendingIcon) {
                      completed = false;
                    }
                  }
                } catch {}
                out.push({
                  el,
                  iframeChain: iframeChain.slice(),
                  type,
                  text,
                  x: point.x,
                  y: point.y,
                  w: Math.round(globalRect.width),
                  h: Math.round(globalRect.height),
                  value,
                  checked,
                  completed,
                  _sortY: globalRect.top,
                  _sortX: globalRect.left
                });
              }
            }
          }
        }

        // ShadowRoot traversal
        try {
          if (el.shadowRoot) {
            traverseShadowRoot(el.shadowRoot, doc, offsetX, offsetY, iframeChain, out);
          }
        } catch {}

        // Iframe traversal (same-origin only)
        try {
          const tag = el.tagName ? el.tagName.toUpperCase() : '';
          if (tag === 'IFRAME' || tag === 'FRAME') {
            const childDoc = el.contentDocument;
            const childWin = el.contentWindow;
            if (childDoc && childWin) {
              const r = el.getBoundingClientRect();
              const childOffsetX = offsetX + r.left;
              const childOffsetY = offsetY + r.top;
              const nextChain = iframeChain.concat([el]);
              traverseDocument(childDoc, childWin, childOffsetX, childOffsetY, nextChain, out);
            }
          }
        } catch {
          // cross-origin; ignore
        }

        node = walker.nextNode();
      }
    }

    function traverseShadowRoot(shadowRoot, doc, offsetX, offsetY, iframeChain, out) {
      if (!shadowRoot) return;
      const walker = doc.createTreeWalker(shadowRoot, NodeFilter.SHOW_ELEMENT, null, false);
      let node = walker.currentNode;

      while (node) {
        const el = node;

        if (isActionable(el) && !isDisabled(el)) {
          const style = safeComputedStyle(el);
          const globalRect = computeGlobalRect(el, offsetX, offsetY);
          if (globalRect.width >= 5 && globalRect.height >= 5 && !isHiddenByStyle(el, style)) {
            const topSize = viewportSize(TOP_WIN, TOP_DOC);
            if (intersectsViewport(globalRect, topSize.w, topSize.h)) {
              const point = tryFindClickablePoint(el, doc, globalRect, iframeChain, topSize.w, topSize.h);
              if (point) {
                const text = extractLabel(el);
                const type = classify(el);
                let value = null;
                let checked = null;
                try {
                  // Get value from input/textarea directly
                  if (type === 'input' || type === 'textarea' || type === 'editable' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    if (typeof el.value !== 'undefined') value = String(el.value);
                  }
                  // For combobox/select, try to find nested input or get value
                  if (type === 'select' && value === null) {
                    const nestedInput = el.querySelector && el.querySelector('input');
                    if (nestedInput && typeof nestedInput.value !== 'undefined') {
                      value = String(nestedInput.value);
                    } else if (typeof el.value !== 'undefined') {
                      value = String(el.value);
                    }
                  }
                } catch {}
                try {
                  if (type === 'checkbox' || (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'checkbox')) {
                    if (typeof el.checked === 'boolean') checked = !!el.checked;
                  }
                } catch {}
                // Check for completion status (Microsoft Rewards specific)
                let completed = null;
                try {
                  // Look for SkypeCircleCheck icon or "已获得的积分" aria-label
                  const checkIcon = el.querySelector && el.querySelector('.mee-icon-SkypeCircleCheck, [aria-label*="已获得"], [aria-label*="完成"]');
                  if (checkIcon) {
                    completed = true;
                  } else {
                    // Also check aria-label on nested elements
                    const ariaLabels = el.querySelectorAll && el.querySelectorAll('[aria-label]');
                    if (ariaLabels) {
                      for (const labeled of ariaLabels) {
                        const al = labeled.getAttribute('aria-label') || '';
                        if (al.includes('已获得') || al.includes('完成')) {
                          completed = true;
                          break;
                        }
                      }
                    }
                  }
                  // Check for "将获得" which means NOT completed
                  if (!completed) {
                    const pendingIcon = el.querySelector && el.querySelector('[aria-label*="将获得"]');
                    if (pendingIcon) {
                      completed = false;
                    }
                  }
                } catch {}
                out.push({
                  el,
                  iframeChain: iframeChain.slice(),
                  type,
                  text,
                  x: point.x,
                  y: point.y,
                  w: Math.round(globalRect.width),
                  h: Math.round(globalRect.height),
                  value,
                  checked,
                  completed,
                  _sortY: globalRect.top,
                  _sortX: globalRect.left
                });
              }
            }
          }
        }

        try {
          if (el.shadowRoot) {
            traverseShadowRoot(el.shadowRoot, doc, offsetX, offsetY, iframeChain, out);
          }
        } catch {}

        try {
          const tag = el.tagName ? el.tagName.toUpperCase() : '';
          if (tag === 'IFRAME' || tag === 'FRAME') {
            const childDoc = el.contentDocument;
            const childWin = el.contentWindow;
            if (childDoc && childWin) {
              const r = el.getBoundingClientRect();
              const childOffsetX = offsetX + r.left;
              const childOffsetY = offsetY + r.top;
              const nextChain = iframeChain.concat([el]);
              traverseDocument(childDoc, childWin, childOffsetX, childOffsetY, nextChain, out);
            }
          }
        } catch {}

        node = walker.nextNode();
      }
    }

    function buildRegistry(sortedItems) {
      const nl = {
        version: 1,
        createdAt: Date.now(),
        url: String(location.href || ''),
        nodes: [],
        frames: [],
        meta: [],
        getNode(id) {
          return (this.nodes && this.nodes[id]) ? this.nodes[id] : null;
        },
        getFrameChain(id) {
          return (this.frames && this.frames[id]) ? this.frames[id] : [];
        },
        scrollToId(id) {
          try {
            const el = this.getNode(id);
            if (!el) return { ok: false, error: 'unknown_id' };
            const chain = this.getFrameChain(id);
            for (const iframeEl of chain) {
              try { iframeEl.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
            }
            try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
          }
        },
        focusId(id) {
          try {
            const el = this.getNode(id);
            if (!el) return { ok: false, error: 'unknown_id' };
            try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch {} }
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
          }
        },
        computePoint(id) {
          try {
            const el = this.getNode(id);
            if (!el) return { ok: false, error: 'unknown_id' };
            const chain = this.getFrameChain(id);

            // Compute offsets dynamically (resilient to scrolling)
            let offsetX = 0;
            let offsetY = 0;
            let currentDoc = TOP_DOC;

            for (const iframeEl of chain) {
              const topAtPoint = null; // placeholder variable to keep structure identical; not used here
              if (!iframeEl || !iframeEl.getBoundingClientRect) return { ok: false, error: 'stale_iframe_chain' };
              const r = iframeEl.getBoundingClientRect();
              offsetX += r.left;
              offsetY += r.top;
              const nextDoc = iframeEl.contentDocument;
              if (!nextDoc) return { ok: false, error: 'cross_origin_or_detached_iframe' };
              currentDoc = nextDoc;
            }

            const style = safeComputedStyle(el);
            if (isHiddenByStyle(el, style)) return { ok: false, error: 'hidden' };

            const globalRect = computeGlobalRect(el, offsetX, offsetY);
            if (globalRect.width < 5 || globalRect.height < 5) return { ok: false, error: 'too_small' };

            const topSize = viewportSize(TOP_WIN, TOP_DOC);
            if (!intersectsViewport(globalRect, topSize.w, topSize.h)) return { ok: false, error: 'offscreen' };

            const p = tryFindClickablePoint(el, currentDoc, globalRect, chain, topSize.w, topSize.h);
            if (!p) return { ok: false, error: 'obscured' };

            return {
              ok: true,
              x: p.x,
              y: p.y,
              rect: {
                left: Math.round(globalRect.left),
                top: Math.round(globalRect.top),
                width: Math.round(globalRect.width),
                height: Math.round(globalRect.height)
              }
            };
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
          }
        }
      };

      // Populate registry (1-based IDs)
      for (let i = 0; i < sortedItems.length; i++) {
        const id = i + 1;
        const it = sortedItems[i];
        nl.nodes[id] = it.el;
        nl.frames[id] = it.iframeChain || [];
        nl.meta[id] = {
          type: it.type,
          text: it.text,
          x: it.x,
          y: it.y,
          w: it.w,
          h: it.h,
          value: it.value,
          checked: it.checked,
          completed: it.completed
        };
      }

      return nl;
    }

    function scan() {
      const topSize = viewportSize(TOP_WIN, TOP_DOC);
      const raw = [];
      traverseDocument(TOP_DOC, TOP_WIN, 0, 0, [], raw);

      raw.sort((a, b) => {
        if (a._sortY !== b._sortY) return a._sortY - b._sortY;
        if (a._sortX !== b._sortX) return a._sortX - b._sortX;
        return (a.w * a.h) - (b.w * b.h);
      });

      // Deduplicate elements at same click point
      // Keep the most specific element (smallest area, or better type)
      const TYPE_PRIORITY = { 'link': 5, 'button': 5, 'input': 6, 'select': 6, 'textarea': 6, 'checkbox': 5, 'tab': 4, 'option': 4, 'menuitem': 4, 'row': 3, 'editable': 5, 'element': 1 };
      const deduped = [];
      const seenPoints = new Map(); // key: "x,y" -> best item
      const seenTexts = new Map(); // key: "text" -> best item (for nearby elements)
      
      for (const item of raw) {
        const key = item.x + ',' + item.y;
        const existing = seenPoints.get(key);
        
        if (!existing) {
          // Check if we have a similar text nearby (within 50px)
          const textKey = (item.text || '').substring(0, 50).toLowerCase().trim();
          if (textKey && textKey.length > 3) {
            const textExisting = seenTexts.get(textKey);
            if (textExisting) {
              const dx = Math.abs(item.x - textExisting.x);
              const dy = Math.abs(item.y - textExisting.y);
              if (dx < 50 && dy < 50) {
                // Skip this duplicate text element
                continue;
              }
            }
            seenTexts.set(textKey, item);
          }
          
          seenPoints.set(key, item);
          deduped.push(item);
        } else {
          // Compare and keep the better one
          const existingPriority = TYPE_PRIORITY[existing.type] || 1;
          const newPriority = TYPE_PRIORITY[item.type] || 1;
          const existingArea = existing.w * existing.h;
          const newArea = item.w * item.h;
          
          // Prefer: higher type priority, then smaller area, then more text
          let replace = false;
          if (newPriority > existingPriority) {
            replace = true;
          } else if (newPriority === existingPriority) {
            if (newArea < existingArea * 0.8) {
              replace = true;
            } else if (Math.abs(newArea - existingArea) < existingArea * 0.2) {
              // Similar size, prefer one with more meaningful text
              const existingTextLen = (existing.text || '').length;
              const newTextLen = (item.text || '').length;
              if (newTextLen > existingTextLen && newTextLen < 100) {
                replace = true;
              }
            }
          }
          
          if (replace) {
            // Replace in deduped array
            const idx = deduped.indexOf(existing);
            if (idx !== -1) {
              deduped[idx] = item;
            }
            seenPoints.set(key, item);
          }
        }
      }

      const truncated = deduped.length > MAX_ELEMENTS;
      const sliced = truncated ? deduped.slice(0, MAX_ELEMENTS) : deduped;
      const nl = buildRegistry(sliced);
      TOP_WIN.__neuralLink = nl;

      const elements = [];
      for (let i = 0; i < sliced.length; i++) {
        const id = i + 1;
        const m = nl.meta[id];
        elements.push({
          id,
          type: m.type,
          text: m.text,
          x: m.x,
          y: m.y,
          w: m.w,
          h: m.h,
          value: m.value,
          checked: m.checked,
          completed: m.completed
        });
      }

      return {
        title: String(document.title || ''),
        url: String(location.href || ''),
        viewport: { w: topSize.w, h: topSize.h },
        truncated,
        totalFound: raw.length,
        dedupedCount: deduped.length,
        elements
      };
    }

    return scan();
  } catch (e) {
    return {
      title: (typeof document !== 'undefined' && document && document.title) ? String(document.title) : '',
      url: (typeof location !== 'undefined' && location && location.href) ? String(location.href) : '',
      elements: [],
      error: String((e && e.message) || e)
    };
  }
})()`;

module.exports = {
  INJECTOR_SCRIPT
};
