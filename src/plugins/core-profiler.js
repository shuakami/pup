 'use strict';

/**
 * core-profiler: 网站性能分析插件
 * 
 * 渐进式命令:
 * - perf: 快速性能概览 (Core Web Vitals, 资源加载)
 * - perf-js: JS 执行分析 (函数耗时, 热点函数)
 * - perf-detail: 详细 CPU Profile (可定位到每一行)
 * - perf-trace: 完整 Timeline 追踪
 * 
 * 使用 CDP 的 Profiler, Performance, Runtime 域
 */

const meta = {
  name: 'core-profiler',
  description: 'Website performance profiling and bottleneck analysis',
  cliOptions: []
};

/**
 * 格式化字节数
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

/**
 * 格式化时间
 */
function formatTime(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * 获取 Core Web Vitals 和基础性能指标
 */
async function getPerformanceMetrics(page) {
  return await page.evaluate(() => {
    const perf = window.performance;
    const timing = perf.timing || {};
    const nav = perf.getEntriesByType('navigation')[0] || {};
    
    // Core Web Vitals
    const vitals = {
      // Largest Contentful Paint
      lcp: null,
      // First Input Delay (需要用户交互)
      fid: null,
      // Cumulative Layout Shift
      cls: null,
      // First Contentful Paint
      fcp: null,
      // Time to First Byte
      ttfb: null
    };
    
    // LCP
    const lcpEntries = perf.getEntriesByType('largest-contentful-paint');
    if (lcpEntries.length > 0) {
      vitals.lcp = lcpEntries[lcpEntries.length - 1].startTime;
    }
    
    // FCP
    const paintEntries = perf.getEntriesByType('paint');
    for (const entry of paintEntries) {
      if (entry.name === 'first-contentful-paint') {
        vitals.fcp = entry.startTime;
      }
    }
    
    // CLS
    let clsValue = 0;
    const clsEntries = perf.getEntriesByType('layout-shift');
    for (const entry of clsEntries) {
      if (!entry.hadRecentInput) {
        clsValue += entry.value;
      }
    }
    vitals.cls = clsValue;
    
    // TTFB
    if (nav.responseStart) {
      vitals.ttfb = nav.responseStart;
    }
    
    // 资源统计
    const resources = perf.getEntriesByType('resource');
    const resourceStats = {
      total: resources.length,
      totalSize: 0,
      byType: {}
    };
    
    for (const r of resources) {
      const type = r.initiatorType || 'other';
      if (!resourceStats.byType[type]) {
        resourceStats.byType[type] = { count: 0, size: 0, time: 0 };
      }
      resourceStats.byType[type].count++;
      resourceStats.byType[type].size += r.transferSize || 0;
      resourceStats.byType[type].time += r.duration || 0;
      resourceStats.totalSize += r.transferSize || 0;
    }
    
    // 页面加载时间
    const loadTiming = {
      domContentLoaded: nav.domContentLoadedEventEnd || (timing.domContentLoadedEventEnd ? timing.domContentLoadedEventEnd - timing.navigationStart : 0),
      load: nav.loadEventEnd > 0 ? nav.loadEventEnd : (timing.loadEventEnd && timing.loadEventEnd > timing.navigationStart ? timing.loadEventEnd - timing.navigationStart : null),
      domInteractive: nav.domInteractive || (timing.domInteractive ? timing.domInteractive - timing.navigationStart : 0)
    };
    
    // 长任务
    const longTasks = perf.getEntriesByType('longtask') || [];
    const longTaskStats = {
      count: longTasks.length,
      totalTime: longTasks.reduce((sum, t) => sum + t.duration, 0),
      longest: longTasks.length > 0 ? Math.max(...longTasks.map(t => t.duration)) : 0
    };
    
    return {
      vitals,
      loadTiming,
      resourceStats,
      longTaskStats,
      memory: perf.memory ? {
        usedJSHeapSize: perf.memory.usedJSHeapSize,
        totalJSHeapSize: perf.memory.totalJSHeapSize,
        jsHeapSizeLimit: perf.memory.jsHeapSizeLimit
      } : null
    };
  });
}

/**
 * 获取慢资源列表
 */
async function getSlowResources(page, threshold = 500) {
  return await page.evaluate((threshold) => {
    const resources = performance.getEntriesByType('resource');
    return resources
      .filter(r => r.duration > threshold)
      .map(r => ({
        name: r.name.split('/').pop().split('?')[0] || r.name,
        url: r.name,
        type: r.initiatorType,
        duration: r.duration,
        size: r.transferSize
      }))
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 20);
  }, threshold);
}


/**
 * 启动 CPU Profiler 并收集数据
 */
async function collectCPUProfile(cdp, durationMs = 3000, enableDebugger = false) {
  await cdp.enable('Profiler');
  await cdp.enable('Runtime');
  
  // 如果需要获取源码，启用 Debugger
  if (enableDebugger) {
    await cdp.enable('Debugger');
    try {
      await cdp.send('Debugger.enable');
    } catch {}
  }
  
  // 确保 Profiler 已启用
  try {
    await cdp.send('Profiler.enable');
  } catch {}
  
  // 设置采样间隔 (微秒) - 更高精度
  try {
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  } catch {}
  
  // 开始 profiling
  await cdp.send('Profiler.start');
  
  // 等待指定时间
  await new Promise(r => setTimeout(r, durationMs));
  
  // 停止并获取 profile
  const { profile } = await cdp.send('Profiler.stop');
  
  return profile;
}

/**
 * 分析 CPU Profile，找出热点函数
 */
function analyzeCPUProfile(profile) {
  const nodes = profile.nodes || [];
  const samples = profile.samples || [];
  const timeDeltas = profile.timeDeltas || [];
  
  // 构建节点映射
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }
  
  // 统计每个函数的采样次数
  const functionStats = new Map();
  
  for (let i = 0; i < samples.length; i++) {
    const nodeId = samples[i];
    const delta = timeDeltas[i] || 0;
    const node = nodeMap.get(nodeId);
    if (!node) continue;
    
    const cf = node.callFrame;
    const key = `${cf.functionName || '(anonymous)'}@${cf.url || 'native'}:${cf.lineNumber || 0}:${cf.columnNumber || 0}`;
    
    if (!functionStats.has(key)) {
      functionStats.set(key, {
        functionName: cf.functionName || '(anonymous)',
        url: cf.url || 'native',
        lineNumber: cf.lineNumber || 0,
        columnNumber: cf.columnNumber || 0,
        scriptId: cf.scriptId || '',
        selfTime: 0,
        hitCount: 0
      });
    }
    
    const stat = functionStats.get(key);
    stat.selfTime += delta;
    stat.hitCount++;
  }
  
  // 转换为数组并排序
  const hotFunctions = Array.from(functionStats.values())
    .filter(f => f.selfTime > 0)
    .sort((a, b) => b.selfTime - a.selfTime)
    .slice(0, 30);
  
  // 计算总时间
  const totalTime = timeDeltas.reduce((sum, d) => sum + d, 0);
  
  // 计算百分比
  for (const f of hotFunctions) {
    f.percentage = totalTime > 0 ? (f.selfTime / totalTime * 100) : 0;
    f.selfTimeMs = f.selfTime / 1000; // 转换为毫秒
  }
  
  return {
    totalTimeMs: totalTime / 1000,
    sampleCount: samples.length,
    hotFunctions
  };
}

/**
 * 获取简化的调用栈信息（用于 perf-js）
 */
function getCallStacks(profile, minTime = 500) {
  const nodes = profile.nodes || [];
  const samples = profile.samples || [];
  const timeDeltas = profile.timeDeltas || [];
  
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }
  
  // 构建调用栈统计
  const stackStats = new Map();
  
  for (let i = 0; i < samples.length; i++) {
    const nodeId = samples[i];
    const delta = timeDeltas[i] || 0;
    
    // 构建调用栈（从叶子到根，取最近5帧）
    const stack = [];
    let currentId = nodeId;
    while (currentId && stack.length < 10) {
      const node = nodeMap.get(currentId);
      if (!node) break;
      
      const cf = node.callFrame;
      if (cf.url || cf.functionName) {
        stack.push({
          name: cf.functionName || '(anonymous)',
          url: cf.url || '',
          line: cf.lineNumber || 0
        });
      }
      currentId = node.parent;
    }
    
    if (stack.length === 0) continue;
    
    const stackKey = stack.map(s => `${s.name}:${s.line}`).join('|');
    if (!stackStats.has(stackKey)) {
      stackStats.set(stackKey, { stack, time: 0, count: 0 });
    }
    const stat = stackStats.get(stackKey);
    stat.time += delta;
    stat.count++;
  }
  
  // 过滤并排序
  const totalTime = timeDeltas.reduce((sum, d) => sum + d, 0);
  return Array.from(stackStats.values())
    .filter(s => s.time >= minTime)
    .sort((a, b) => b.time - a.time)
    .slice(0, 30)
    .map(s => ({
      stack: s.stack,
      timeMs: s.time / 1000,
      count: s.count,
      percentage: totalTime > 0 ? (s.time / totalTime * 100).toFixed(2) : 0
    }));
}

/**
 * 获取完整的调用栈信息（从根到叶子）
 */
function getFullCallStacks(profile, minTime = 500) {
  const nodes = profile.nodes || [];
  const samples = profile.samples || [];
  const timeDeltas = profile.timeDeltas || [];
  
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }
  
  // 构建调用栈统计
  const stackStats = new Map();
  
  for (let i = 0; i < samples.length; i++) {
    const nodeId = samples[i];
    const delta = timeDeltas[i] || 0;
    
    // 构建完整调用栈（从根到叶子）
    const stack = [];
    let currentId = nodeId;
    while (currentId) {
      const node = nodeMap.get(currentId);
      if (!node) break;
      
      const cf = node.callFrame;
      stack.unshift({
        functionName: cf.functionName || '(anonymous)',
        url: cf.url || '',
        scriptId: cf.scriptId || '',
        lineNumber: cf.lineNumber || 0,
        columnNumber: cf.columnNumber || 0
      });
      currentId = node.parent;
    }
    
    // 过滤掉纯 native 的栈
    const hasUserCode = stack.some(f => f.url && !f.url.includes('native'));
    if (!hasUserCode && stack.length > 2) continue;
    
    const stackKey = stack.map(s => `${s.functionName}@${s.url}:${s.lineNumber}:${s.columnNumber}`).join('|');
    if (!stackStats.has(stackKey)) {
      stackStats.set(stackKey, { stack, time: 0, count: 0 });
    }
    const stat = stackStats.get(stackKey);
    stat.time += delta;
    stat.count++;
  }
  
  // 过滤并排序
  return Array.from(stackStats.values())
    .filter(s => s.time >= minTime)
    .sort((a, b) => b.time - a.time)
    .slice(0, 50)
    .map(s => ({
      stack: s.stack,
      timeMs: s.time / 1000,
      timeMicros: s.time,
      count: s.count,
      percentage: (s.time / timeDeltas.reduce((sum, d) => sum + d, 0) * 100).toFixed(2)
    }));
}


/**
 * 收集 Performance Timeline 追踪
 */
async function collectTrace(cdp, page, durationMs = 3000) {
  const events = [];
  
  // 监听追踪事件
  const handler = (params) => {
    if (params.value) {
      events.push(...params.value);
    }
  };
  
  cdp.on('Tracing.dataCollected', handler);
  
  await cdp.enable('Tracing');
  
  // 开始追踪
  await cdp.send('Tracing.start', {
    categories: [
      'devtools.timeline',
      'v8.execute',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-v8.cpu_profiler'
    ].join(','),
    options: 'sampling-frequency=10000'
  });
  
  // 触发一些活动 (滚动页面)
  try {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 2);
      setTimeout(() => window.scrollTo(0, 0), 500);
    });
  } catch {}
  
  await new Promise(r => setTimeout(r, durationMs));
  
  // 停止追踪
  await cdp.send('Tracing.end');
  
  // 等待数据收集完成
  await new Promise(r => setTimeout(r, 500));
  
  cdp.off('Tracing.dataCollected', handler);
  
  return events;
}

/**
 * 分析 Timeline 事件
 */
function analyzeTraceEvents(events) {
  const categories = {
    scripting: { time: 0, count: 0, events: [] },
    rendering: { time: 0, count: 0, events: [] },
    painting: { time: 0, count: 0, events: [] },
    loading: { time: 0, count: 0, events: [] },
    other: { time: 0, count: 0, events: [] }
  };
  
  const scriptingEvents = ['FunctionCall', 'EvaluateScript', 'V8.Execute', 'v8.compile'];
  const renderingEvents = ['Layout', 'RecalculateStyles', 'UpdateLayerTree'];
  const paintingEvents = ['Paint', 'CompositeLayers', 'RasterTask'];
  const loadingEvents = ['ParseHTML', 'ResourceSendRequest', 'ResourceReceiveResponse'];
  
  for (const event of events) {
    if (!event.dur) continue;
    
    const name = event.name || '';
    const durMs = event.dur / 1000;
    
    let category = 'other';
    if (scriptingEvents.some(e => name.includes(e))) category = 'scripting';
    else if (renderingEvents.some(e => name.includes(e))) category = 'rendering';
    else if (paintingEvents.some(e => name.includes(e))) category = 'painting';
    else if (loadingEvents.some(e => name.includes(e))) category = 'loading';
    
    categories[category].time += durMs;
    categories[category].count++;
    
    if (durMs > 5) {
      categories[category].events.push({
        name,
        duration: durMs,
        args: event.args
      });
    }
  }
  
  // 排序每个类别的事件
  for (const cat of Object.values(categories)) {
    cat.events.sort((a, b) => b.duration - a.duration);
    cat.events = cat.events.slice(0, 10);
  }
  
  return categories;
}

/**
 * 获取 JS 堆内存快照摘要
 */
async function getHeapStats(cdp) {
  await cdp.enable('HeapProfiler');
  
  const stats = await cdp.send('HeapProfiler.getHeapObjectStatistics');
  
  return stats;
}


async function onLoad(kernel) {
  
  // ========================================
  // perf: 快速性能概览
  // ========================================
  kernel.registerCommand(meta.name, {
    name: 'perf',
    usage: 'perf [--reload] [--slow <ms>]',
    description: 'Quick performance overview: Core Web Vitals, resource stats, long tasks. Use --reload for accurate fresh page metrics.',
    cliOptions: [
      { flags: '--reload', description: 'Hard reload page before measuring (recommended for accurate results)' },
      { flags: '--slow <ms>', description: 'Threshold for slow resources (default: 500ms)' }
    ],
    handler: async (ctx) => {
      const page = await kernel.page();
      let url = page.url();
      
      const shouldReload = ctx.argv.includes('--reload');
      const slowThreshold = parseInt(ctx.argv.find(a => /^\d+$/.test(a))) || 500;
      
      // 如果需要刷新，执行硬刷新并等待加载完成
      if (shouldReload) {
        // 清除缓存并硬刷新
        const cdp = await kernel.cdp();
        await cdp.enable('Network');
        await cdp.send('Network.clearBrowserCache');
        
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        url = page.url();
        
        // 等待一小段时间让 performance entries 稳定
        await new Promise(r => setTimeout(r, 1000));
      }
      
      const metrics = await getPerformanceMetrics(page);
      const slowResources = await getSlowResources(page, slowThreshold);
      
      // 评估性能等级
      const grades = {
        lcp: metrics.vitals.lcp ? (metrics.vitals.lcp < 2500 ? 'good' : metrics.vitals.lcp < 4000 ? 'needs-improvement' : 'poor') : 'n/a',
        fcp: metrics.vitals.fcp ? (metrics.vitals.fcp < 1800 ? 'good' : metrics.vitals.fcp < 3000 ? 'needs-improvement' : 'poor') : 'n/a',
        cls: metrics.vitals.cls !== null ? (metrics.vitals.cls < 0.1 ? 'good' : metrics.vitals.cls < 0.25 ? 'needs-improvement' : 'poor') : 'n/a',
        ttfb: metrics.vitals.ttfb ? (metrics.vitals.ttfb < 800 ? 'good' : metrics.vitals.ttfb < 1800 ? 'needs-improvement' : 'poor') : 'n/a'
      };
      
      return {
        ok: true,
        cmd: 'PERF',
        url,
        reloaded: shouldReload,
        vitals: {
          lcp: metrics.vitals.lcp ? { value: Math.round(metrics.vitals.lcp), grade: grades.lcp } : null,
          fcp: metrics.vitals.fcp ? { value: Math.round(metrics.vitals.fcp), grade: grades.fcp } : null,
          cls: metrics.vitals.cls !== null ? { value: metrics.vitals.cls.toFixed(3), grade: grades.cls } : null,
          ttfb: metrics.vitals.ttfb ? { value: Math.round(metrics.vitals.ttfb), grade: grades.ttfb } : null
        },
        loadTiming: {
          domInteractive: Math.round(metrics.loadTiming.domInteractive),
          domContentLoaded: Math.round(metrics.loadTiming.domContentLoaded),
          load: Math.round(metrics.loadTiming.load)
        },
        resources: {
          total: metrics.resourceStats.total,
          totalSize: metrics.resourceStats.totalSize,
          byType: metrics.resourceStats.byType
        },
        longTasks: metrics.longTaskStats,
        memory: metrics.memory ? {
          used: metrics.memory.usedJSHeapSize,
          total: metrics.memory.totalJSHeapSize,
          limit: metrics.memory.jsHeapSizeLimit
        } : null,
        slowResources: slowResources.map(r => ({
          name: r.name,
          type: r.type,
          duration: Math.round(r.duration),
          size: r.size
        }))
      };
    }
  });

  // ========================================
  // perf-load: 页面加载性能测量（硬刷新 + 完整测量）
  // ========================================
  kernel.registerCommand(meta.name, {
    name: 'perf-load',
    usage: 'perf-load [url] [--no-cache]',
    description: 'Measure fresh page load performance. Reloads page and captures all metrics.',
    cliOptions: [
      { flags: '--no-cache', description: 'Clear browser cache before loading (default: true)' }
    ],
    handler: async (ctx) => {
      const page = await kernel.page();
      const cdp = await kernel.cdp();
      
      // 获取目标 URL
      let targetUrl = ctx.argv.find(a => a.startsWith('http://') || a.startsWith('https://'));
      if (!targetUrl) {
        targetUrl = page.url();
      }
      
      const clearCache = !ctx.argv.includes('--keep-cache');
      
      // 清除缓存
      if (clearCache) {
        await cdp.enable('Network');
        await cdp.send('Network.clearBrowserCache');
        await cdp.send('Network.clearBrowserCookies');
      }
      
      // 记录开始时间
      const loadStart = Date.now();
      
      // 导航到页面
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      // 额外等待网络稳定
      await new Promise(r => setTimeout(r, 2000));
      
      const loadEnd = Date.now();
      const totalLoadTime = loadEnd - loadStart;
      
      // 等待 performance entries 稳定
      await new Promise(r => setTimeout(r, 300));
      
      // 获取所有性能指标
      const metrics = await getPerformanceMetrics(page);
      const slowResources = await getSlowResources(page, 500);
      
      // 获取网络统计
      const networkStats = await page.evaluate(() => {
        const resources = performance.getEntriesByType('resource');
        const nav = performance.getEntriesByType('navigation')[0] || {};
        
        let totalSize = 0;
        let totalDuration = 0;
        const byType = {};
        
        for (const r of resources) {
          totalSize += r.transferSize || 0;
          totalDuration = Math.max(totalDuration, r.responseEnd);
          const type = r.initiatorType || 'other';
          if (!byType[type]) byType[type] = { count: 0, size: 0 };
          byType[type].count++;
          byType[type].size += r.transferSize || 0;
        }
        
        return {
          resourceCount: resources.length,
          totalSize,
          totalDuration,
          byType,
          navigation: {
            redirectTime: nav.redirectEnd - nav.redirectStart,
            dnsTime: nav.domainLookupEnd - nav.domainLookupStart,
            tcpTime: nav.connectEnd - nav.connectStart,
            ttfb: nav.responseStart - nav.requestStart,
            downloadTime: nav.responseEnd - nav.responseStart,
            domParsing: nav.domInteractive - nav.responseEnd,
            domContentLoaded: nav.domContentLoadedEventEnd - nav.domContentLoadedEventStart,
            loadEvent: nav.loadEventEnd - nav.loadEventStart
          }
        };
      });
      
      // 评估性能等级
      const grades = {
        lcp: metrics.vitals.lcp ? (metrics.vitals.lcp < 2500 ? 'good' : metrics.vitals.lcp < 4000 ? 'needs-improvement' : 'poor') : 'n/a',
        fcp: metrics.vitals.fcp ? (metrics.vitals.fcp < 1800 ? 'good' : metrics.vitals.fcp < 3000 ? 'needs-improvement' : 'poor') : 'n/a',
        cls: metrics.vitals.cls !== null ? (metrics.vitals.cls < 0.1 ? 'good' : metrics.vitals.cls < 0.25 ? 'needs-improvement' : 'poor') : 'n/a',
        ttfb: metrics.vitals.ttfb ? (metrics.vitals.ttfb < 800 ? 'good' : metrics.vitals.ttfb < 1800 ? 'needs-improvement' : 'poor') : 'n/a'
      };
      
      return {
        ok: true,
        cmd: 'PERF-LOAD',
        url: targetUrl,
        cacheCleared: clearCache,
        totalLoadTime,
        vitals: {
          lcp: metrics.vitals.lcp ? { value: Math.round(metrics.vitals.lcp), grade: grades.lcp } : null,
          fcp: metrics.vitals.fcp ? { value: Math.round(metrics.vitals.fcp), grade: grades.fcp } : null,
          cls: metrics.vitals.cls !== null ? { value: metrics.vitals.cls.toFixed(3), grade: grades.cls } : null,
          ttfb: metrics.vitals.ttfb ? { value: Math.round(metrics.vitals.ttfb), grade: grades.ttfb } : null
        },
        loadTiming: {
          domInteractive: Math.round(metrics.loadTiming.domInteractive),
          domContentLoaded: Math.round(metrics.loadTiming.domContentLoaded),
          load: Math.round(metrics.loadTiming.load)
        },
        network: {
          resourceCount: networkStats.resourceCount,
          totalSize: networkStats.totalSize,
          byType: networkStats.byType,
          timing: {
            redirect: Math.round(networkStats.navigation.redirectTime),
            dns: Math.round(networkStats.navigation.dnsTime),
            tcp: Math.round(networkStats.navigation.tcpTime),
            ttfb: Math.round(networkStats.navigation.ttfb),
            download: Math.round(networkStats.navigation.downloadTime),
            domParsing: Math.round(networkStats.navigation.domParsing)
          }
        },
        longTasks: metrics.longTaskStats,
        memory: metrics.memory ? {
          used: metrics.memory.usedJSHeapSize,
          total: metrics.memory.totalJSHeapSize
        } : null,
        slowResources: slowResources.slice(0, 10).map(r => ({
          name: r.name,
          type: r.type,
          duration: Math.round(r.duration),
          size: r.size
        }))
      };
    }
  });

  // ========================================
  // perf-js: JS 执行分析
  // ========================================
  kernel.registerCommand(meta.name, {
    name: 'perf-js',
    usage: 'perf-js [--duration <ms>] [--interact]',
    description: 'JavaScript execution profiling: hot functions, call stacks',
    cliOptions: [
      { flags: '--duration <ms>', description: 'Profiling duration (default: 3000ms)' },
      { flags: '--interact', description: 'Trigger page interactions during profiling' }
    ],
    handler: async (ctx) => {
      const page = await kernel.page();
      const cdp = await kernel.cdp();
      const url = page.url();
      
      const duration = parseInt(ctx.argv.find(a => /^\d+$/.test(a))) || 3000;
      const interact = ctx.argv.includes('--interact');
      
      // 如果需要交互，在 profiling 期间触发一些操作
      if (interact) {
        setTimeout(async () => {
          try {
            await page.evaluate(() => {
              window.scrollTo(0, document.body.scrollHeight);
              setTimeout(() => window.scrollTo(0, 0), 500);
            });
          } catch {}
        }, 500);
      }
      
      const profile = await collectCPUProfile(cdp, duration);
      const analysis = analyzeCPUProfile(profile);
      const callStacks = getCallStacks(profile, 500);
      
      return {
        ok: true,
        cmd: 'PERF-JS',
        url,
        duration: duration,
        totalTimeMs: analysis.totalTimeMs.toFixed(2),
        sampleCount: analysis.sampleCount,
        hotFunctions: analysis.hotFunctions.slice(0, 20).map(f => ({
          name: f.functionName,
          file: f.url ? f.url.split('/').pop().split('?')[0] : 'native',
          line: f.lineNumber,
          selfTimeMs: f.selfTimeMs.toFixed(2),
          percentage: f.percentage.toFixed(1),
          hits: f.hitCount
        })),
        heavyCallStacks: callStacks.slice(0, 10).map(s => ({
          timeMs: s.timeMs.toFixed(2),
          count: s.count,
          stack: s.stack.slice(-5).map(f => `${f.name}:${f.line}`).join(' <- ')
        }))
      };
    }
  });


  // ========================================
  // perf-detail: 详细 CPU Profile
  // ========================================
  kernel.registerCommand(meta.name, {
    name: 'perf-detail',
    usage: 'perf-detail [--duration <ms>] [--file <pattern>]',
    description: 'Detailed CPU profile with line-level breakdown',
    cliOptions: [
      { flags: '--duration <ms>', description: 'Profiling duration (default: 5000ms)' },
      { flags: '--file <pattern>', description: 'Filter by filename pattern' }
    ],
    handler: async (ctx) => {
      const page = await kernel.page();
      const cdp = await kernel.cdp();
      const url = page.url();
      
      const duration = parseInt(ctx.argv.find(a => /^\d+$/.test(a))) || 5000;
      const filePatternIdx = ctx.argv.indexOf('--file');
      const filePattern = filePatternIdx >= 0 ? ctx.argv[filePatternIdx + 1] : null;
      
      // 触发页面活动
      setTimeout(async () => {
        try {
          await page.evaluate(() => {
            // 滚动
            window.scrollTo(0, document.body.scrollHeight);
            setTimeout(() => window.scrollTo(0, 0), 1000);
            // 触发一些事件
            document.dispatchEvent(new Event('mousemove'));
          });
        } catch {}
      }, 500);
      
      const profile = await collectCPUProfile(cdp, duration);
      
      // 详细分析每个函数
      const nodes = profile.nodes || [];
      const samples = profile.samples || [];
      const timeDeltas = profile.timeDeltas || [];
      
      const nodeMap = new Map();
      for (const node of nodes) {
        nodeMap.set(node.id, node);
      }
      
      // 按文件和行号统计
      const lineStats = new Map();
      
      for (let i = 0; i < samples.length; i++) {
        const nodeId = samples[i];
        const delta = timeDeltas[i] || 0;
        const node = nodeMap.get(nodeId);
        if (!node) continue;
        
        const cf = node.callFrame;
        if (!cf.url) continue;
        
        // 过滤文件
        if (filePattern && !cf.url.includes(filePattern)) continue;
        
        const fileKey = cf.url.split('/').pop().split('?')[0];
        const lineKey = `${fileKey}:${cf.lineNumber}:${cf.columnNumber}`;
        
        if (!lineStats.has(lineKey)) {
          lineStats.set(lineKey, {
            file: fileKey,
            url: cf.url,
            line: cf.lineNumber,
            column: cf.columnNumber,
            functionName: cf.functionName || '(anonymous)',
            selfTime: 0,
            hitCount: 0
          });
        }
        
        const stat = lineStats.get(lineKey);
        stat.selfTime += delta;
        stat.hitCount++;
      }
      
      // 按文件分组
      const byFile = new Map();
      for (const stat of lineStats.values()) {
        if (!byFile.has(stat.file)) {
          byFile.set(stat.file, { file: stat.file, url: stat.url, totalTime: 0, lines: [] });
        }
        const fileStat = byFile.get(stat.file);
        fileStat.totalTime += stat.selfTime;
        fileStat.lines.push(stat);
      }
      
      // 排序
      const fileResults = Array.from(byFile.values())
        .sort((a, b) => b.totalTime - a.totalTime)
        .slice(0, 15);
      
      for (const f of fileResults) {
        f.totalTimeMs = (f.totalTime / 1000).toFixed(2);
        f.lines.sort((a, b) => b.selfTime - a.selfTime);
        f.lines = f.lines.slice(0, 10).map(l => ({
          line: l.line,
          col: l.column,
          func: l.functionName,
          timeMs: (l.selfTime / 1000).toFixed(2),
          hits: l.hitCount
        }));
      }
      
      const totalTime = timeDeltas.reduce((sum, d) => sum + d, 0);
      
      return {
        ok: true,
        cmd: 'PERF-DETAIL',
        url,
        duration,
        totalTimeMs: (totalTime / 1000).toFixed(2),
        sampleCount: samples.length,
        filePattern: filePattern || 'all',
        files: fileResults.map(f => ({
          file: f.file,
          totalTimeMs: f.totalTimeMs,
          hotLines: f.lines
        }))
      };
    }
  });

  // ========================================
  // perf-trace: 完整 Timeline 追踪
  // ========================================
  kernel.registerCommand(meta.name, {
    name: 'perf-trace',
    usage: 'perf-trace [--duration <ms>]',
    description: 'Full timeline trace: scripting, rendering, painting breakdown',
    cliOptions: [
      { flags: '--duration <ms>', description: 'Trace duration (default: 3000ms)' }
    ],
    handler: async (ctx) => {
      const page = await kernel.page();
      const cdp = await kernel.cdp();
      const url = page.url();
      
      const duration = parseInt(ctx.argv.find(a => /^\d+$/.test(a))) || 3000;
      
      const events = await collectTrace(cdp, page, duration);
      const analysis = analyzeTraceEvents(events);
      
      const totalTime = Object.values(analysis).reduce((sum, c) => sum + c.time, 0);
      
      return {
        ok: true,
        cmd: 'PERF-TRACE',
        url,
        duration,
        eventCount: events.length,
        totalTimeMs: totalTime.toFixed(2),
        breakdown: {
          scripting: {
            timeMs: analysis.scripting.time.toFixed(2),
            percentage: totalTime > 0 ? (analysis.scripting.time / totalTime * 100).toFixed(1) : 0,
            count: analysis.scripting.count,
            slowEvents: analysis.scripting.events.slice(0, 5).map(e => ({
              name: e.name,
              durationMs: e.duration.toFixed(2)
            }))
          },
          rendering: {
            timeMs: analysis.rendering.time.toFixed(2),
            percentage: totalTime > 0 ? (analysis.rendering.time / totalTime * 100).toFixed(1) : 0,
            count: analysis.rendering.count,
            slowEvents: analysis.rendering.events.slice(0, 5).map(e => ({
              name: e.name,
              durationMs: e.duration.toFixed(2)
            }))
          },
          painting: {
            timeMs: analysis.painting.time.toFixed(2),
            percentage: totalTime > 0 ? (analysis.painting.time / totalTime * 100).toFixed(1) : 0,
            count: analysis.painting.count
          },
          loading: {
            timeMs: analysis.loading.time.toFixed(2),
            percentage: totalTime > 0 ? (analysis.loading.time / totalTime * 100).toFixed(1) : 0,
            count: analysis.loading.count
          }
        },
        bottleneck: totalTime > 0 ? (
          analysis.scripting.time > analysis.rendering.time * 2 ? 'JavaScript execution' :
          analysis.rendering.time > analysis.scripting.time * 2 ? 'Layout/Style recalculation' :
          analysis.painting.time > totalTime * 0.3 ? 'Painting/Compositing' :
          'Balanced'
        ) : 'Unknown'
      };
    }
  });

  // ========================================
  // perf-analyze: AI 专用超详细分析
  // ========================================
  kernel.registerCommand(meta.name, {
    name: 'perf-analyze',
    usage: 'perf-analyze [--duration <ms>] [--source]',
    description: 'AI-grade detailed performance analysis with full call stacks and source locations',
    cliOptions: [
      { flags: '--duration <ms>', description: 'Profiling duration (default: 5000ms)' },
      { flags: '--source', description: 'Include source code snippets for hot spots' }
    ],
    handler: async (ctx) => {
      const page = await kernel.page();
      const cdp = await kernel.cdp();
      const url = page.url();
      
      const duration = parseInt(ctx.argv.find(a => /^\d+$/.test(a))) || 5000;
      const includeSource = ctx.argv.includes('--source');
      
      // 触发页面活动
      const interactionPromise = (async () => {
        await new Promise(r => setTimeout(r, 300));
        try {
          await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight / 2);
            document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }));
          });
          await new Promise(r => setTimeout(r, 500));
          await page.evaluate(() => {
            window.scrollTo(0, 0);
          });
        } catch {}
      })();
      
      // 收集 CPU Profile
      const profile = await collectCPUProfile(cdp, duration, includeSource);
      await interactionPromise;
      
      const nodes = profile.nodes || [];
      const samples = profile.samples || [];
      const timeDeltas = profile.timeDeltas || [];
      const totalTime = timeDeltas.reduce((sum, d) => sum + d, 0);
      
      // 构建节点映射
      const nodeMap = new Map();
      for (const node of nodes) {
        nodeMap.set(node.id, node);
      }
      
      // 1. 按精确位置统计（文件:行:列）
      const locationStats = new Map();
      for (let i = 0; i < samples.length; i++) {
        const nodeId = samples[i];
        const delta = timeDeltas[i] || 0;
        const node = nodeMap.get(nodeId);
        if (!node) continue;
        
        const cf = node.callFrame;
        if (!cf.url || cf.url === 'native') continue;
        
        const locKey = `${cf.url}:${cf.lineNumber}:${cf.columnNumber}`;
        if (!locationStats.has(locKey)) {
          locationStats.set(locKey, {
            url: cf.url,
            file: cf.url.split('/').pop().split('?')[0],
            functionName: cf.functionName || '(anonymous)',
            lineNumber: cf.lineNumber,
            columnNumber: cf.columnNumber,
            scriptId: cf.scriptId,
            selfTime: 0,
            hitCount: 0
          });
        }
        const stat = locationStats.get(locKey);
        stat.selfTime += delta;
        stat.hitCount++;
      }
      
      // 2. 获取完整调用栈
      const callStacks = getFullCallStacks(profile, 100);
      
      // 3. 按文件聚合
      const fileStats = new Map();
      for (const loc of locationStats.values()) {
        if (!fileStats.has(loc.file)) {
          fileStats.set(loc.file, {
            file: loc.file,
            url: loc.url,
            totalTime: 0,
            locations: []
          });
        }
        const fs = fileStats.get(loc.file);
        fs.totalTime += loc.selfTime;
        fs.locations.push(loc);
      }
      
      // 排序
      const sortedFiles = Array.from(fileStats.values())
        .sort((a, b) => b.totalTime - a.totalTime)
        .slice(0, 20);
      
      for (const f of sortedFiles) {
        f.locations.sort((a, b) => b.selfTime - a.selfTime);
        f.percentage = totalTime > 0 ? (f.totalTime / totalTime * 100).toFixed(2) : 0;
        f.totalTimeMs = (f.totalTime / 1000).toFixed(3);
      }
      
      // 4. 获取源码片段（如果请求）
      let sourceSnippets = [];
      if (includeSource) {
        const topLocations = Array.from(locationStats.values())
          .sort((a, b) => b.selfTime - a.selfTime)
          .slice(0, 10);
        
        for (const loc of topLocations) {
          if (loc.scriptId) {
            try {
              const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId: loc.scriptId });
              if (scriptSource) {
                const lines = scriptSource.split('\n');
                const startLine = Math.max(0, loc.lineNumber - 3);
                const endLine = Math.min(lines.length, loc.lineNumber + 3);
                const snippet = lines.slice(startLine, endLine).map((line, i) => ({
                  lineNumber: startLine + i + 1,
                  code: line.substring(0, 200),
                  isHotLine: startLine + i + 1 === loc.lineNumber
                }));
                sourceSnippets.push({
                  file: loc.file,
                  functionName: loc.functionName,
                  lineNumber: loc.lineNumber,
                  columnNumber: loc.columnNumber,
                  selfTimeMs: (loc.selfTime / 1000).toFixed(3),
                  snippet
                });
              }
            } catch {}
          }
        }
      }
      
      // 5. 识别性能问题模式
      const issues = [];
      
      // 检测频繁 GC
      const gcTime = Array.from(locationStats.values())
        .filter(l => l.functionName.includes('garbage collector'))
        .reduce((sum, l) => sum + l.selfTime, 0);
      if (gcTime > totalTime * 0.05) {
        issues.push({
          type: 'excessive-gc',
          severity: 'high',
          description: `Garbage collection taking ${(gcTime / totalTime * 100).toFixed(1)}% of time`,
          suggestion: 'Reduce object allocations, reuse objects, check for memory leaks'
        });
      }
      
      // 检测单个函数占用过多
      const topFunc = Array.from(locationStats.values()).sort((a, b) => b.selfTime - a.selfTime)[0];
      if (topFunc && topFunc.selfTime > totalTime * 0.3) {
        issues.push({
          type: 'hot-function',
          severity: 'high',
          description: `Function "${topFunc.functionName}" at ${topFunc.file}:${topFunc.lineNumber} taking ${(topFunc.selfTime / totalTime * 100).toFixed(1)}% of time`,
          location: { file: topFunc.file, line: topFunc.lineNumber, column: topFunc.columnNumber },
          suggestion: 'Optimize this function or break it into smaller pieces'
        });
      }
      
      // 检测深调用栈
      const deepStacks = callStacks.filter(s => s.stack.length > 20);
      if (deepStacks.length > 0) {
        issues.push({
          type: 'deep-call-stack',
          severity: 'medium',
          description: `${deepStacks.length} call stacks with depth > 20`,
          suggestion: 'Consider flattening recursive calls or using iteration'
        });
      }
      
      return {
        ok: true,
        cmd: 'PERF-ANALYZE',
        url,
        duration,
        summary: {
          totalTimeMs: (totalTime / 1000).toFixed(2),
          sampleCount: samples.length,
          uniqueLocations: locationStats.size,
          filesAnalyzed: fileStats.size,
          issuesFound: issues.length
        },
        hotspots: sortedFiles.slice(0, 15).map(f => ({
          file: f.file,
          url: f.url,
          totalTimeMs: f.totalTimeMs,
          percentage: f.percentage,
          locations: f.locations.slice(0, 10).map(l => ({
            functionName: l.functionName,
            line: l.lineNumber,
            column: l.columnNumber,
            selfTimeMs: (l.selfTime / 1000).toFixed(3),
            hits: l.hitCount,
            percentage: totalTime > 0 ? (l.selfTime / totalTime * 100).toFixed(2) : 0
          }))
        })),
        callStacks: callStacks.slice(0, 20).map(s => ({
          timeMs: s.timeMs.toFixed(3),
          percentage: s.percentage,
          count: s.count,
          depth: s.stack.length,
          frames: s.stack.map(f => ({
            fn: f.functionName,
            file: f.url ? f.url.split('/').pop().split('?')[0] : 'native',
            line: f.lineNumber,
            col: f.columnNumber
          }))
        })),
        issues,
        sourceSnippets: includeSource ? sourceSnippets : undefined
      };
    }
  });

  // ========================================
  // perf-memory: 内存分析
  // ========================================
  kernel.registerCommand(meta.name, {
    name: 'perf-memory',
    usage: 'perf-memory [--gc]',
    description: 'Memory analysis: heap stats, DOM nodes, detached elements',
    cliOptions: [
      { flags: '--gc', description: 'Force garbage collection before analysis' }
    ],
    handler: async (ctx) => {
      const page = await kernel.page();
      const cdp = await kernel.cdp();
      const url = page.url();
      
      const forceGC = ctx.argv.includes('--gc');
      
      // 强制 GC
      if (forceGC) {
        await cdp.enable('HeapProfiler');
        try {
          await cdp.send('HeapProfiler.collectGarbage');
          await new Promise(r => setTimeout(r, 500));
        } catch {}
      }
      
      // 获取内存指标
      const metrics = await page.metrics();
      
      // 获取 DOM 统计
      const domStats = await page.evaluate(() => {
        const allNodes = document.querySelectorAll('*');
        const byTag = {};
        for (const node of allNodes) {
          const tag = node.tagName.toLowerCase();
          byTag[tag] = (byTag[tag] || 0) + 1;
        }
        
        // 检测潜在的内存问题
        const issues = [];
        
        // 大量 DOM 节点
        if (allNodes.length > 1500) {
          issues.push({
            type: 'excessive-dom',
            severity: allNodes.length > 3000 ? 'high' : 'medium',
            count: allNodes.length,
            suggestion: 'Consider virtual scrolling or lazy loading'
          });
        }
        
        // 大量事件监听器 (通过 getEventListeners 无法直接获取，用启发式方法)
        const elementsWithHandlers = document.querySelectorAll('[onclick], [onmouseover], [onmouseout], [onkeydown], [onkeyup], [onchange], [oninput]');
        if (elementsWithHandlers.length > 100) {
          issues.push({
            type: 'inline-handlers',
            severity: 'low',
            count: elementsWithHandlers.length,
            suggestion: 'Use event delegation instead of inline handlers'
          });
        }
        
        // 隐藏但存在的大量元素
        const hiddenElements = document.querySelectorAll('[style*="display: none"], [style*="visibility: hidden"], .hidden, [hidden]');
        if (hiddenElements.length > 200) {
          issues.push({
            type: 'hidden-elements',
            severity: 'low',
            count: hiddenElements.length,
            suggestion: 'Remove unused hidden elements from DOM'
          });
        }
        
        // iframe 数量
        const iframes = document.querySelectorAll('iframe');
        if (iframes.length > 5) {
          issues.push({
            type: 'many-iframes',
            severity: 'medium',
            count: iframes.length,
            suggestion: 'Each iframe creates separate JS context and memory'
          });
        }
        
        return {
          totalNodes: allNodes.length,
          byTag: Object.entries(byTag)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .reduce((o, [k, v]) => { o[k] = v; return o; }, {}),
          iframes: iframes.length,
          scripts: document.querySelectorAll('script').length,
          stylesheets: document.querySelectorAll('link[rel="stylesheet"], style').length,
          images: document.querySelectorAll('img').length,
          issues
        };
      });
      
      return {
        ok: true,
        cmd: 'PERF-MEMORY',
        url,
        gcForced: forceGC,
        heap: {
          used: metrics.JSHeapUsedSize,
          total: metrics.JSHeapTotalSize,
          usedMB: (metrics.JSHeapUsedSize / 1024 / 1024).toFixed(2),
          totalMB: (metrics.JSHeapTotalSize / 1024 / 1024).toFixed(2)
        },
        counts: {
          nodes: metrics.Nodes,
          documents: metrics.Documents,
          frames: metrics.Frames,
          jsEventListeners: metrics.JSEventListeners,
          layoutObjects: metrics.LayoutObjects
        },
        dom: domStats,
        issues: domStats.issues
      };
    }
  });

  // ========================================
  // perf-network: 网络性能分析
  // ========================================
  kernel.registerCommand(meta.name, {
    name: 'perf-network',
    usage: 'perf-network [--reload] [--blocking]',
    description: 'Network performance: waterfall analysis, blocking resources, critical path. Use --reload for accurate fresh page metrics.',
    cliOptions: [
      { flags: '--reload', description: 'Hard reload page before measuring (recommended)' },
      { flags: '--blocking', description: 'Show only render-blocking resources' }
    ],
    handler: async (ctx) => {
      const page = await kernel.page();
      let url = page.url();
      
      const shouldReload = ctx.argv.includes('--reload');
      const showBlocking = ctx.argv.includes('--blocking');
      
      // 如果需要刷新，执行硬刷新
      if (shouldReload) {
        const cdp = await kernel.cdp();
        await cdp.enable('Network');
        await cdp.send('Network.clearBrowserCache');
        
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        url = page.url();
        await new Promise(r => setTimeout(r, 1000));
      }
      
      const analysis = await page.evaluate((showBlocking) => {
        const resources = performance.getEntriesByType('resource');
        const nav = performance.getEntriesByType('navigation')[0] || {};
        
        // 分析每个资源
        const analyzed = resources.map(r => {
          const urlObj = new URL(r.name, location.href);
          const filename = urlObj.pathname.split('/').pop() || urlObj.hostname;
          
          // 判断是否阻塞渲染
          let blocking = false;
          let blockingReason = null;
          
          if (r.initiatorType === 'link') {
            // CSS 默认阻塞渲染
            if (r.name.includes('.css')) {
              blocking = true;
              blockingReason = 'render-blocking CSS';
            }
          } else if (r.initiatorType === 'script') {
            // 同步脚本阻塞解析
            if (r.startTime < nav.domContentLoadedEventStart) {
              blocking = true;
              blockingReason = 'parser-blocking script';
            }
          }
          
          // 计算各阶段时间
          const dns = r.domainLookupEnd - r.domainLookupStart;
          const tcp = r.connectEnd - r.connectStart;
          const ssl = r.secureConnectionStart > 0 ? r.connectEnd - r.secureConnectionStart : 0;
          const ttfb = r.responseStart - r.requestStart;
          const download = r.responseEnd - r.responseStart;
          
          return {
            name: filename.substring(0, 40),
            url: r.name,
            type: r.initiatorType,
            size: r.transferSize,
            duration: r.duration,
            startTime: r.startTime,
            blocking,
            blockingReason,
            timing: {
              dns: dns > 0 ? dns : 0,
              tcp: tcp > 0 ? tcp : 0,
              ssl: ssl > 0 ? ssl : 0,
              ttfb: ttfb > 0 ? ttfb : 0,
              download: download > 0 ? download : 0
            },
            // 是否来自缓存
            cached: r.transferSize === 0 && r.decodedBodySize > 0
          };
        });
        
        // 过滤
        let filtered = analyzed;
        if (showBlocking) {
          filtered = analyzed.filter(r => r.blocking);
        }
        
        // 按开始时间排序
        filtered.sort((a, b) => a.startTime - b.startTime);
        
        // 找出关键路径上的资源
        const criticalResources = analyzed
          .filter(r => r.blocking || r.startTime < nav.domContentLoadedEventStart)
          .sort((a, b) => a.startTime - b.startTime);
        
        // 统计
        const stats = {
          total: resources.length,
          blocking: analyzed.filter(r => r.blocking).length,
          cached: analyzed.filter(r => r.cached).length,
          totalSize: analyzed.reduce((sum, r) => sum + (r.size || 0), 0),
          totalDuration: Math.max(...analyzed.map(r => r.startTime + r.duration)) - Math.min(...analyzed.map(r => r.startTime)),
          byType: {}
        };
        
        for (const r of analyzed) {
          const t = r.type || 'other';
          if (!stats.byType[t]) stats.byType[t] = { count: 0, size: 0, time: 0 };
          stats.byType[t].count++;
          stats.byType[t].size += r.size || 0;
          stats.byType[t].time += r.duration || 0;
        }
        
        // 找出最慢的资源
        const slowest = [...analyzed]
          .sort((a, b) => b.duration - a.duration)
          .slice(0, 10);
        
        // 找出最大的资源
        const largest = [...analyzed]
          .sort((a, b) => (b.size || 0) - (a.size || 0))
          .slice(0, 10);
        
        return {
          stats,
          resources: filtered.slice(0, 50),
          criticalPath: criticalResources.slice(0, 20),
          slowest,
          largest,
          timing: {
            ttfb: nav.responseStart,
            domInteractive: nav.domInteractive,
            domContentLoaded: nav.domContentLoadedEventEnd,
            load: nav.loadEventEnd
          }
        };
      }, showBlocking);
      
      return {
        ok: true,
        cmd: 'PERF-NETWORK',
        url,
        reloaded: shouldReload,
        showBlocking,
        stats: analysis.stats,
        timing: analysis.timing,
        criticalPath: analysis.criticalPath.map(r => ({
          name: r.name,
          type: r.type,
          blocking: r.blocking,
          blockingReason: r.blockingReason,
          startTime: Math.round(r.startTime),
          duration: Math.round(r.duration)
        })),
        slowest: analysis.slowest.map(r => ({
          name: r.name,
          type: r.type,
          duration: Math.round(r.duration),
          size: r.size,
          timing: r.timing
        })),
        largest: analysis.largest.map(r => ({
          name: r.name,
          type: r.type,
          size: r.size,
          duration: Math.round(r.duration)
        }))
      };
    }
  });

  // ========================================
  // perf-longtasks: Long Tasks 详细分析
  // ========================================
  kernel.registerCommand(meta.name, {
    name: 'perf-longtasks',
    usage: 'perf-longtasks [--duration <ms>] [--threshold <ms>]',
    description: 'Monitor and analyze Long Tasks that block the main thread',
    cliOptions: [
      { flags: '--duration <ms>', description: 'Monitoring duration (default: 5000ms)' },
      { flags: '--threshold <ms>', description: 'Task duration threshold (default: 50ms)' }
    ],
    handler: async (ctx) => {
      const page = await kernel.page();
      const url = page.url();
      
      const duration = parseInt(ctx.argv.find(a => /^\d+$/.test(a))) || 5000;
      const thresholdIdx = ctx.argv.indexOf('--threshold');
      const threshold = thresholdIdx >= 0 ? parseInt(ctx.argv[thresholdIdx + 1]) || 50 : 50;
      
      // 在页面中设置 Long Task 观察器
      const tasks = await page.evaluate(async (duration, threshold) => {
        return new Promise((resolve) => {
          const longTasks = [];
          
          // 使用 PerformanceObserver 监听 Long Tasks
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.duration >= threshold) {
                longTasks.push({
                  name: entry.name,
                  startTime: entry.startTime,
                  duration: entry.duration,
                  attribution: entry.attribution ? entry.attribution.map(a => ({
                    name: a.name,
                    entryType: a.entryType,
                    containerType: a.containerType,
                    containerName: a.containerName,
                    containerId: a.containerId,
                    containerSrc: a.containerSrc
                  })) : []
                });
              }
            }
          });
          
          try {
            observer.observe({ entryTypes: ['longtask'] });
          } catch (e) {
            // Long Task API 可能不支持
            resolve({ supported: false, tasks: [] });
            return;
          }
          
          // 触发一些活动
          setTimeout(() => {
            window.scrollTo(0, document.body.scrollHeight / 2);
          }, 500);
          setTimeout(() => {
            window.scrollTo(0, 0);
          }, 1500);
          
          // 等待指定时间后收集结果
          setTimeout(() => {
            observer.disconnect();
            resolve({ supported: true, tasks: longTasks });
          }, duration);
        });
      }, duration, threshold);
      
      // 分析结果
      const totalBlockingTime = tasks.tasks.reduce((sum, t) => sum + (t.duration - 50), 0);
      
      // 按来源分组
      const bySource = {};
      for (const task of tasks.tasks) {
        const source = task.attribution?.[0]?.containerSrc || 
                       task.attribution?.[0]?.name || 
                       'unknown';
        if (!bySource[source]) {
          bySource[source] = { count: 0, totalTime: 0, tasks: [] };
        }
        bySource[source].count++;
        bySource[source].totalTime += task.duration;
        bySource[source].tasks.push(task);
      }
      
      return {
        ok: true,
        cmd: 'PERF-LONGTASKS',
        url,
        duration,
        threshold,
        supported: tasks.supported,
        summary: {
          count: tasks.tasks.length,
          totalBlockingTime: Math.round(totalBlockingTime),
          avgDuration: tasks.tasks.length > 0 
            ? Math.round(tasks.tasks.reduce((s, t) => s + t.duration, 0) / tasks.tasks.length)
            : 0,
          maxDuration: tasks.tasks.length > 0
            ? Math.round(Math.max(...tasks.tasks.map(t => t.duration)))
            : 0
        },
        bySource: Object.entries(bySource)
          .sort((a, b) => b[1].totalTime - a[1].totalTime)
          .slice(0, 10)
          .map(([source, data]) => ({
            source: source.split('/').pop() || source,
            count: data.count,
            totalTime: Math.round(data.totalTime)
          })),
        tasks: tasks.tasks
          .sort((a, b) => b.duration - a.duration)
          .slice(0, 20)
          .map(t => ({
            startTime: Math.round(t.startTime),
            duration: Math.round(t.duration),
            source: t.attribution?.[0]?.containerSrc?.split('/').pop() || 
                    t.attribution?.[0]?.name || 
                    'self'
          }))
      };
    }
  });
}

async function onUnload() {}

module.exports = {
  meta,
  onLoad,
  onUnload
};
