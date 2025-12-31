'use strict';

/**
 * page-extract plugin:
 * - 从页面提取结构化数据
 * - 支持常见网站的产品、文章等信息提取
 * - 使用 DOM 查询而非 AXTree
 */

const meta = {
  name: 'page-extract',
  description: 'Extract structured data from pages (products, articles, etc.)',
  cliOptions: []
};

// 网站特定的提取规则
const EXTRACTORS = {
  'amazon': {
    match: (url) => url.includes('amazon.com'),
    products: {
      container: '[data-component-type="s-search-result"], .s-result-item[data-asin]',
      title: 'h2 a span, h2 .a-text-normal',
      price: '.a-price .a-offscreen, .a-price-whole',
      rating: '.a-icon-alt',
      reviews: '.a-size-base.s-underline-text',
      link: 'h2 a'
    }
  },
  'ebay': {
    match: (url) => url.includes('ebay.com'),
    products: {
      container: 'li.s-item',
      title: '.s-item__title',
      price: '.s-item__price',
      link: '.s-item__link'
    }
  },
  'generic': {
    match: () => true,
    products: {
      container: '[class*="product"], [class*="item"]',
      title: 'h2, h3, [class*="title"]',
      price: '[class*="price"]',
      link: 'a[href]'
    }
  }
};

async function extractProducts(kernel, limit = 10) {
  const page = await kernel.page();
  const url = page.url();
  
  let extractor = null;
  for (const [name, ext] of Object.entries(EXTRACTORS)) {
    if (name !== 'generic' && ext.match(url)) {
      extractor = ext;
      break;
    }
  }
  if (!extractor) extractor = EXTRACTORS.generic;
  
  const rules = extractor.products;
  
  const products = await page.evaluate((rules, maxItems) => {
    const results = [];
    let containers = document.querySelectorAll(rules.container);
    
    // Fallback selectors
    if (containers.length === 0) {
      const fallbacks = ['li.s-item', '.srp-results li', '[class*="product-card"]'];
      for (const sel of fallbacks) {
        containers = document.querySelectorAll(sel);
        if (containers.length > 0) break;
      }
    }
    
    for (let i = 0; i < Math.min(containers.length, maxItems + 5); i++) {
      const el = containers[i];
      
      let title = '';
      const titleEl = el.querySelector(rules.title) || el.querySelector('h3, [class*="title"]');
      if (titleEl) title = (titleEl.innerText || '').trim();
      
      let price = '';
      const priceEl = el.querySelector(rules.price) || el.querySelector('[class*="price"]');
      if (priceEl) {
        price = (priceEl.innerText || '').trim();
        const m = price.match(/[\$€£][\d,.]+/);
        if (m) price = m[0];
      }
      
      let rating = '';
      if (rules.rating) {
        const ratingEl = el.querySelector(rules.rating);
        if (ratingEl) {
          const rt = ratingEl.getAttribute('aria-label') || ratingEl.innerText || '';
          const m = rt.match(/([\d.]+)\s*out of\s*5/i);
          if (m) rating = m[1];
        }
      }
      
      let link = '';
      const linkEl = el.querySelector(rules.link) || el.querySelector('a');
      if (linkEl) link = linkEl.href || '';
      
      if (title && title.length > 5 && !title.toLowerCase().includes('shop on ebay')) {
        results.push({
          id: results.length + 1,
          title: title.substring(0, 100),
          price: price || null,
          rating: rating || null,
          link: link || null
        });
      }
    }
    return results;
  }, rules, limit + 5);
  
  return products.slice(0, limit);
}


async function extractProductDetail(kernel) {
  const page = await kernel.page();
  const url = page.url();
  
  if (url.includes('amazon.com')) {
    return await page.evaluate(() => {
      const result = {};
      const titleEl = document.querySelector('#productTitle');
      if (titleEl) result.title = titleEl.innerText.trim();
      
      const priceEl = document.querySelector('.a-price .a-offscreen');
      if (priceEl) result.price = priceEl.textContent.trim();
      
      const ratingEl = document.querySelector('#acrPopover');
      if (ratingEl) {
        const m = (ratingEl.getAttribute('title') || '').match(/([\d.]+)/);
        if (m) result.rating = m[1];
      }
      
      const reviewsEl = document.querySelector('#acrCustomerReviewText');
      if (reviewsEl) {
        const m = (reviewsEl.innerText || '').match(/([\d,]+)/);
        if (m) result.reviews = m[1].replace(/,/g, '');
      }
      
      const availEl = document.querySelector('#availability span');
      if (availEl) result.availability = availEl.innerText.trim();
      
      const brandEl = document.querySelector('#bylineInfo');
      if (brandEl) result.brand = brandEl.innerText.trim();
      
      const features = [];
      document.querySelectorAll('#feature-bullets li span.a-list-item').forEach(el => {
        const t = el.innerText.trim();
        if (t && t.length > 10 && features.length < 5) features.push(t.substring(0, 100));
      });
      if (features.length) result.features = features;
      
      return result;
    });
  }
  
  return await page.evaluate(() => {
    const result = {};
    const titleEl = document.querySelector('h1');
    if (titleEl) result.title = titleEl.innerText.trim().substring(0, 200);
    const priceEl = document.querySelector('[class*="price"]');
    if (priceEl) {
      const m = priceEl.innerText.match(/[\$€£][\d,.]+/);
      if (m) result.price = m[0];
    }
    return result;
  });
}

async function onLoad(kernel) {
  kernel.registerCommand(meta.name, {
    name: 'extract',
    usage: 'extract [--limit <n>]',
    description: 'Extract product/item data from current page.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const limitIdx = argv.indexOf('--limit');
      const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : 10;
      
      const page = await kernel.page();
      const url = page.url();
      let title = '';
      try { title = await page.title(); } catch {}
      
      const products = await extractProducts(kernel, limit);
      
      return { ok: true, cmd: 'EXTRACT', title, url, count: products.length, items: products };
    }
  });
  
  kernel.registerCommand(meta.name, {
    name: 'detail',
    usage: 'detail',
    description: 'Extract product detail from current page.',
    handler: async () => {
      const page = await kernel.page();
      const url = page.url();
      const detail = await extractProductDetail(kernel);
      return { ok: true, cmd: 'DETAIL', url, ...detail };
    }
  });
}

async function onUnload() {}

module.exports = { meta, onLoad, onUnload };
