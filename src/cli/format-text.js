'use strict';

            const {
              cyan, green, yellow, red, magenta, blue, gray, white,
              brightCyan, bold, dim,
              formatDuration
            } = require('../utils/colors');

            function formatText(res, startTime) {
  if (!res || typeof res !== 'object') return String(res);

  const lines = [];
  const cmd = res.cmd || '';
  const duration = startTime ? formatDuration(Date.now() - startTime) : null;

  // Error case
  if (res.ok === false) {
    const err = res.error || {};
    const errMsg = typeof err === 'string' ? err : (err.message || 'Unknown error');
    lines.push(`${red('[-]')} ${red(errMsg)}`);
    if (err.code) lines.push(`    ${gray('code:')} ${yellow(err.code)}`);
    return lines.join('\n');
  }

  // Success header with duration
  const durationStr = duration ? ` ${gray(duration)}` : '';

  // 超时警告
  if (res.timedOut) {
    lines.push(`${yellow('[!]')} ${bold(cyan(cmd))}${durationStr} ${yellow('(timed out)')}`);
    if (res.warning) lines.push(`    ${yellow(res.warning)}`);
  } else {
    lines.push(`${green('[+]')} ${bold(cyan(cmd))}${durationStr}`);
  }

  // Page info
  if (res.title) lines.push(`    ${gray('title')} ${white(res.title)}`);
  if (res.url) lines.push(`    ${gray('url')} ${blue(res.url.length > 60 ? res.url.substring(0, 60) + '...' : res.url)}`);

  // 白屏警告
  if (res.isBlank) {
    lines.push(`    ${red('[!]')} ${red('blank page detected')} ${gray(`(${res.blankReason || 'unknown'})`)}`);
    if (res.blankDetails) {
      lines.push(`    ${gray('    text:')} ${yellow(res.blankDetails.textLength)} ${gray('chars, html:')} ${yellow(res.blankDetails.htmlLength)} ${gray('chars, visible:')} ${yellow(res.blankDetails.visibleElements)} ${gray('elements')}`);
    }
    lines.push(`    ${yellow('    hint: try reload, or the page may require JavaScript/login')}`);
  }

  // 错误页面警告
  if (res.isError) {
    lines.push(`    ${red('[!]')} ${red('error page detected')}`);
    if (res.errorText) lines.push(`    ${gray('    ')}${yellow(res.errorText)}`);
  }

  // Partial scan indicator
  if (res.partialScan) {
    lines.push(`    ${yellow('◆')} ${yellow('partial scan')} ${gray(`(${res.elementCount || 0} elements found)`)}`);
  }

  // Navigation
  if (res.newTab) lines.push(`    ${green('[+]')} ${green('new tab')}`);
  if (res.newUrl) lines.push(`    ${gray('>')} ${blue(res.newUrl.length > 60 ? res.newUrl.substring(0, 60) + '...' : res.newUrl)}`);
  if (res.navigated) lines.push(`    ${cyan('>')} ${cyan('navigated')}`);
  if (res.direction) lines.push(`    ${gray('direction')} ${cyan(res.direction)}`);

  // Redirect chain (multi-hop redirects)
  if (res.redirectChain && res.redirectChain.length > 1) {
    lines.push(`    ${yellow('[!]')} ${yellow(`${res.hopCount}-hop redirect`)}`);
    res.redirectChain.forEach((url, i) => {
      const prefix = i === 0 ? 'hop 1' : i === res.redirectChain.length - 1 ? 'final' : `hop ${i + 1}`;
      const truncUrl = url.length > 55 ? url.substring(0, 55) + '...' : url;
      lines.push(`    ${gray(prefix + ':')} ${i === res.redirectChain.length - 1 ? cyan(truncUrl) : dim(truncUrl)}`);
    });
  }

  // Domain change detection
  if (res.domainChanged) {
    lines.push(`    ${yellow('[!]')} ${yellow('domain changed')} ${dim(res.originalDomain)} ${gray('->')} ${cyan(res.finalDomain)}`);
  }

  // Redirect to home detection
  if (res.redirectedToHome) {
    lines.push(`    ${yellow('[!]')} ${yellow('redirected to homepage')} ${gray('(possible 404)')}`);
  }

  // Redirect detection
  if (res.redirected) {
    lines.push(`    ${yellow('[!]')} ${yellow('redirected')} ${gray('reason:')} ${red(res.redirectReason || 'unknown')}`);
    if (res.redirectFrom) lines.push(`    ${gray('from:')} ${dim(res.redirectFrom.substring(0, 60))}${res.redirectFrom.length > 60 ? '...' : ''}`);
  }
  if (res.is404) {
    lines.push(`    ${red('[!]')} ${red('404 page detected')}${res.errorTitle ? ` ${dim('title:')} ${dim(res.errorTitle.substring(0, 40))}` : ''}`);
  }

  // Final URL/title (if different from newUrl)
  if (res.finalUrl && res.finalUrl !== res.newUrl && !res.redirectChain) {
    lines.push(`    ${gray('final:')} ${cyan(res.finalUrl.length > 55 ? res.finalUrl.substring(0, 55) + '...' : res.finalUrl)}`);
  }
  if (res.finalTitle && res.is404) {
    lines.push(`    ${gray('title:')} ${dim(res.finalTitle.substring(0, 50))}`);
  }

  // Wait command
  if (res.waited !== undefined) {
    lines.push(`    ${gray('waited')} ${cyan(res.waited + 'ms')}`);
  }

  // Click/action specific (from interaction commands)
  if (res.action && res.id !== undefined) {
    let coords = '';
    if (res.x !== undefined && res.y !== undefined) {
      coords = ` ${gray('at')} ${dim(`(${res.x}, ${res.y})`)}`;
    }
    lines.push(`    ${magenta(res.action)} ${gray('id:')}${yellow(res.id)}${coords}`);
    if (res.typed) lines.push(`    ${gray('typed')} ${dim('"')}${white(res.typed)}${dim('"')}`);
  }

  // EXEC/QUERY command results
  if (cmd === 'EXEC' || cmd === 'QUERY' || cmd === 'GETDATA') {
    if (res.result !== undefined) {
      const resultStr = typeof res.result === 'object' ? JSON.stringify(res.result, null, 2) : String(res.result);
      if (resultStr.includes('\n')) {
        lines.push(`    ${gray('result')} ${dim('(')}${cyan(res.type || 'value')}${dim(')')}`);
        for (const line of resultStr.split('\n').slice(0, 20)) {
          lines.push(`    ${white(line)}`);
        }
      } else {
        lines.push(`    ${gray('result')} ${white(resultStr)} ${dim('(')}${cyan(res.type || 'value')}${dim(')')}`);
      }
    }
    if (res.count !== undefined) {
      lines.push(`    ${gray('count')} ${yellow(res.count)}`);
    }
    if (res.items && Array.isArray(res.items)) {
      for (const item of res.items.slice(0, 10)) {
        const parts = Object.entries(item).map(([k, v]) => `${gray(k + ':')} ${white(String(v).substring(0, 40))}`);
        lines.push(`    ${dim('•')} ${parts.join(' ')}`);
      }
      if (res.items.length > 10) {
        lines.push(`    ${dim(`... and ${res.items.length - 10} more`)}`);
      }
    }
    if (res.selector) lines.push(`    ${gray('selector')} ${dim(res.selector)}`);
    if (res.path) lines.push(`    ${gray('path')} ${dim(res.path)}`);
  }

  // TRIGGER/SETVAL command results
  if (cmd === 'TRIGGER') {
    if (res.eventType) lines.push(`    ${gray('event')} ${cyan(res.eventType)}`);
    if (res.selector) lines.push(`    ${gray('selector')} ${dim(res.selector)}`);
  }
  if (cmd === 'SETVAL') {
    if (res.value !== undefined) lines.push(`    ${gray('value')} ${white(res.value)}`);
    if (res.selector) lines.push(`    ${gray('selector')} ${dim(res.selector)}`);
  }

  // INJECT command results
  if (cmd === 'INJECT') {
    if (res.identifier) lines.push(`    ${gray('id')} ${yellow(res.identifier)}`);
    if (res.message) lines.push(`    ${gray('message')} ${dim(res.message)}`);
  }

  // ========== DevTools Commands ==========

  // COOKIES command
  if (cmd === 'COOKIES') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);
    if (res.cookies && Array.isArray(res.cookies)) {
      lines.push(`    ${cyan('◆')} ${cyan(res.count || res.cookies.length)} ${gray('cookies')}`);
      for (const c of res.cookies.slice(0, 15)) {
        const secure = c.secure ? green('S') : '';
        const httpOnly = c.httpOnly ? yellow('H') : '';
        const sameSite = c.sameSite ? dim(`[${c.sameSite}]`) : '';
        const val = (c.value || '').substring(0, 30);
        lines.push(`    ${dim('•')} ${white(c.name)} ${gray('=')} ${dim(val)}${val.length >= 30 ? '...' : ''} ${secure}${httpOnly} ${sameSite}`);
        lines.push(`      ${gray('domain:')} ${dim(c.domain)} ${gray('path:')} ${dim(c.path)}`);
      }
      if (res.cookies.length > 15) {
        lines.push(`    ${dim(`... and ${res.cookies.length - 15} more`)}`);
      }
    }
    if (res.name) lines.push(`    ${gray('name')} ${white(res.name)}`);
    if (res.value !== undefined) lines.push(`    ${gray('value')} ${dim(res.value)}`);
  }

  // STORAGE command
  if (cmd === 'STORAGE') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);
    if (res.type) lines.push(`    ${gray('type')} ${magenta(res.type + 'Storage')}`);
    if (res.storage && typeof res.storage === 'object') {
      const keys = Object.keys(res.storage);
      lines.push(`    ${cyan('◆')} ${cyan(res.count || keys.length)} ${gray('items')}`);
      for (const key of keys.slice(0, 15)) {
        const val = String(res.storage[key] || '').substring(0, 50);
        lines.push(`    ${dim('•')} ${white(key)} ${gray('=')} ${dim(val)}${val.length >= 50 ? '...' : ''}`);
      }
      if (keys.length > 15) {
        lines.push(`    ${dim(`... and ${keys.length - 15} more`)}`);
      }
    }
    if (res.key) lines.push(`    ${gray('key')} ${white(res.key)}`);
    if (res.value !== undefined && res.action !== 'list') lines.push(`    ${gray('value')} ${dim(String(res.value).substring(0, 60))}`);
  }

  // DOM command
  if (cmd === 'DOM') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);
    if (res.depth) lines.push(`    ${gray('depth')} ${yellow(res.depth)}`);
    if (res.query) lines.push(`    ${gray('query')} ${dim(res.query)}`);
    if (res.selector) lines.push(`    ${gray('selector')} ${dim(res.selector)}`);
    if (res.count !== undefined) lines.push(`    ${gray('found')} ${yellow(res.count)} ${gray('nodes')}`);
    if (res.nodeIds && Array.isArray(res.nodeIds)) {
      lines.push(`    ${gray('nodeIds')} ${dim(res.nodeIds.slice(0, 10).join(', '))}${res.nodeIds.length > 10 ? '...' : ''}`);
    }
    if (res.html) {
      const htmlPreview = res.html.substring(0, 200).replace(/\n/g, ' ');
      lines.push(`    ${gray('html')} ${dim(htmlPreview)}${res.html.length > 200 ? '...' : ''}`);
    }
    if (res.root) {
      lines.push(`    ${cyan('◆')} ${gray('DOM tree loaded')}`);
      if (res.root.nodeName) lines.push(`    ${gray('root')} ${white(res.root.nodeName)}`);
      if (res.root.childNodeCount) lines.push(`    ${gray('children')} ${yellow(res.root.childNodeCount)}`);
    }
  }

  // PERF command - 性能分析
  if (cmd === 'PERF' || cmd === 'PERF-LOAD') {
    // Reload indicator
    if (res.reloaded) {
      lines.push(`    ${green('+')} ${green('Fresh measurement (page reloaded)')}`);
    } else if (cmd === 'PERF') {
      lines.push(`    ${yellow('!')} ${dim('Cached data - use --reload for fresh measurement')}`);
    }
    if (res.cacheCleared) {
      lines.push(`    ${green('+')} ${green('Cache cleared')}`);
    }
    if (res.totalLoadTime) {
      lines.push(`    ${cyan('◆')} ${gray('Total Load Time:')} ${cyan(res.totalLoadTime + 'ms')}`);
    }
    // Core Web Vitals
    if (res.vitals) {
      lines.push(`    ${cyan('◆')} ${gray('Core Web Vitals')}`);
      const v = res.vitals;
      if (v.lcp) {
        const grade = v.lcp.grade === 'good' ? green('good') : v.lcp.grade === 'needs-improvement' ? yellow('needs-improvement') : red('poor');
        lines.push(`    ${dim('•')} ${white('LCP')}  ${cyan(v.lcp.value + 'ms')} ${grade}`);
      }
      if (v.fcp) {
        const grade = v.fcp.grade === 'good' ? green('good') : v.fcp.grade === 'needs-improvement' ? yellow('needs-improvement') : red('poor');
        lines.push(`    ${dim('•')} ${white('FCP')}  ${cyan(v.fcp.value + 'ms')} ${grade}`);
      }
      if (v.cls) {
        const grade = v.cls.grade === 'good' ? green('good') : v.cls.grade === 'needs-improvement' ? yellow('needs-improvement') : red('poor');
        lines.push(`    ${dim('•')} ${white('CLS')}  ${cyan(v.cls.value)} ${grade}`);
      }
      if (v.ttfb) {
        const grade = v.ttfb.grade === 'good' ? green('good') : v.ttfb.grade === 'needs-improvement' ? yellow('needs-improvement') : red('poor');
        lines.push(`    ${dim('•')} ${white('TTFB')} ${cyan(v.ttfb.value + 'ms')} ${grade}`);
      }
    }
    // Load timing
    if (res.loadTiming) {
      lines.push(`    ${cyan('◆')} ${gray('Load Timing')}`);
      lines.push(`    ${dim('•')} ${white('DOM Interactive')}    ${cyan(res.loadTiming.domInteractive + 'ms')}`);
      lines.push(`    ${dim('•')} ${white('DOM Content Loaded')} ${cyan(res.loadTiming.domContentLoaded + 'ms')}`);
      lines.push(`    ${dim('•')} ${white('Load Complete')}      ${cyan(res.loadTiming.load + 'ms')}`);
    }
    // Network timing (for PERF-LOAD)
    if (res.network && res.network.timing) {
      const t = res.network.timing;
      lines.push(`    ${cyan('◆')} ${gray('Network Timing')}`);
      if (t.redirect > 0) lines.push(`    ${dim('•')} ${white('Redirect')}    ${cyan(t.redirect + 'ms')}`);
      if (t.dns > 0) lines.push(`    ${dim('•')} ${white('DNS Lookup')}  ${cyan(t.dns + 'ms')}`);
      if (t.tcp > 0) lines.push(`    ${dim('•')} ${white('TCP Connect')} ${cyan(t.tcp + 'ms')}`);
      lines.push(`    ${dim('•')} ${white('TTFB')}         ${t.ttfb > 800 ? red(t.ttfb + 'ms') : cyan(t.ttfb + 'ms')}`);
      lines.push(`    ${dim('•')} ${white('Download')}     ${cyan(t.download + 'ms')}`);
      lines.push(`    ${dim('•')} ${white('DOM Parsing')}  ${cyan(t.domParsing + 'ms')}`);
    }
    // Resources
    if (res.resources) {
      const r = res.resources;
      const sizeStr = r.totalSize > 1024 * 1024 ? `${(r.totalSize / 1024 / 1024).toFixed(2)}MB` : `${(r.totalSize / 1024).toFixed(1)}KB`;
      lines.push(`    ${cyan('◆')} ${gray('Resources:')} ${yellow(r.total)} ${gray('total,')} ${magenta(sizeStr)}`);
      if (r.byType) {
        for (const [type, stat] of Object.entries(r.byType)) {
          const size = stat.size > 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${stat.size}B`;
          lines.push(`    ${dim('•')} ${white(type.padEnd(10))} ${yellow(stat.count)} ${gray('files,')} ${dim(size)}`);
        }
      }
    }
    // Network resources (for PERF-LOAD)
    if (res.network && res.network.resourceCount && !res.resources) {
      const n = res.network;
      const sizeStr = n.totalSize > 1024 * 1024 ? `${(n.totalSize / 1024 / 1024).toFixed(2)}MB` : `${(n.totalSize / 1024).toFixed(1)}KB`;
      lines.push(`    ${cyan('◆')} ${gray('Resources:')} ${yellow(n.resourceCount)} ${gray('total,')} ${magenta(sizeStr)}`);
      if (n.byType) {
        for (const [type, stat] of Object.entries(n.byType)) {
          const size = stat.size > 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${stat.size}B`;
          lines.push(`    ${dim('•')} ${white(type.padEnd(10))} ${yellow(stat.count)} ${gray('files,')} ${dim(size)}`);
        }
      }
    }
    // Long tasks
    if (res.longTasks && res.longTasks.count > 0) {
      lines.push(`    ${red('!')} ${gray('Long Tasks:')} ${red(res.longTasks.count)} ${gray('blocking,')} ${red(res.longTasks.totalTime.toFixed(0) + 'ms')} ${gray('total')}`);
    }
    // Memory
    if (res.memory) {
      const used = (res.memory.used / 1024 / 1024).toFixed(1);
      const total = (res.memory.total / 1024 / 1024).toFixed(1);
      lines.push(`    ${cyan('◆')} ${gray('Memory:')} ${cyan(used + 'MB')} ${gray('/')} ${dim(total + 'MB')}`);
    }
    // Slow resources
    if (res.slowResources && res.slowResources.length > 0) {
      lines.push(`    ${yellow('!')} ${gray('Slow Resources (>500ms):')}`);
      for (const r of res.slowResources.slice(0, 8)) {
        const size = r.size > 1024 ? `${(r.size / 1024).toFixed(1)}KB` : r.size > 0 ? `${r.size}B` : '';
        lines.push(`    ${dim('•')} ${red(r.duration + 'ms')} ${white(r.name.substring(0, 40))} ${dim(r.type)} ${dim(size)}`);
      }
    }
    // Legacy metrics format
    if (res.metrics && typeof res.metrics === 'object') {
      lines.push(`    ${cyan('◆')} ${gray('performance metrics')}`);
      const important = ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'Frames', 'LayoutCount', 'RecalcStyleCount', 'ScriptDuration', 'TaskDuration'];
      for (const key of important) {
        if (res.metrics[key] !== undefined) {
          let val = res.metrics[key];
          let formatted = String(val);
          if (key.includes('Size')) formatted = `${(val / 1024 / 1024).toFixed(2)} MB`;
          else if (key.includes('Duration')) formatted = `${(val * 1000).toFixed(2)} ms`;
          lines.push(`    ${dim('•')} ${white(key)} ${gray('=')} ${cyan(formatted)}`);
        }
      }
    }
  }

  // PERF-JS command - JS 执行分析
  if (cmd === 'PERF-JS') {
    lines.push(`    ${cyan('◆')} ${gray('Profiled')} ${cyan(res.duration + 'ms')} ${gray('/')} ${yellow(res.sampleCount)} ${gray('samples')}`);
    if (res.hotFunctions && res.hotFunctions.length > 0) {
      lines.push(`    ${yellow('!')} ${gray('Hot Functions (by self time):')}`);
      for (const f of res.hotFunctions.slice(0, 15)) {
        const pct = parseFloat(f.percentage) > 5 ? red(f.percentage + '%') : parseFloat(f.percentage) > 1 ? yellow(f.percentage + '%') : dim(f.percentage + '%');
        lines.push(`    ${dim('•')} ${pct} ${cyan(f.selfTimeMs + 'ms')} ${white(f.name.substring(0, 30))} ${dim(f.file + ':' + f.line)}`);
      }
    }
    if (res.heavyCallStacks && res.heavyCallStacks.length > 0) {
      lines.push(`    ${magenta('◆')} ${gray('Heavy Call Stacks:')}`);
      for (const s of res.heavyCallStacks.slice(0, 5)) {
        lines.push(`    ${dim('•')} ${cyan(s.timeMs + 'ms')} ${dim(s.stack)}`);
      }
    }
  }

  // PERF-DETAIL command - 详细 CPU Profile
  if (cmd === 'PERF-DETAIL') {
    lines.push(`    ${cyan('◆')} ${gray('Profiled')} ${cyan(res.duration + 'ms')} ${gray('/')} ${yellow(res.sampleCount)} ${gray('samples')}`);
    if (res.filePattern !== 'all') lines.push(`    ${gray('filter:')} ${dim(res.filePattern)}`);
    if (res.files && res.files.length > 0) {
      lines.push(`    ${yellow('!')} ${gray('Hot Files:')}`);
      for (const f of res.files) {
        lines.push(`    ${magenta('◆')} ${white(f.file)} ${cyan(f.totalTimeMs + 'ms')}`);
        for (const l of f.hotLines.slice(0, 5)) {
          const timeColor = parseFloat(l.timeMs) > 10 ? red : parseFloat(l.timeMs) > 1 ? yellow : dim;
          lines.push(`      ${dim('L' + l.line + ':' + l.col)} ${timeColor(l.timeMs + 'ms')} ${dim(l.func.substring(0, 25))} ${gray('(' + l.hits + ' hits)')}`);
        }
      }
    }
  }

  // PERF-TRACE command - Timeline 追踪
  if (cmd === 'PERF-TRACE') {
    lines.push(`    ${cyan('◆')} ${gray('Traced')} ${cyan(res.duration + 'ms')} ${gray('/')} ${yellow(res.eventCount)} ${gray('events')}`);
    if (res.breakdown) {
      const b = res.breakdown;
      lines.push(`    ${yellow('!')} ${gray('Time Breakdown:')}`);
      const scriptPct = parseFloat(b.scripting.percentage);
      const renderPct = parseFloat(b.rendering.percentage);
      lines.push(`    ${dim('•')} ${white('Scripting')}  ${scriptPct > 50 ? red(b.scripting.timeMs + 'ms') : cyan(b.scripting.timeMs + 'ms')} ${dim('(' + b.scripting.percentage + '%)')}`);
      lines.push(`    ${dim('•')} ${white('Rendering')}  ${renderPct > 30 ? yellow(b.rendering.timeMs + 'ms') : cyan(b.rendering.timeMs + 'ms')} ${dim('(' + b.rendering.percentage + '%)')}`);
      lines.push(`    ${dim('•')} ${white('Painting')}   ${cyan(b.painting.timeMs + 'ms')} ${dim('(' + b.painting.percentage + '%)')}`);
      lines.push(`    ${dim('•')} ${white('Loading')}    ${cyan(b.loading.timeMs + 'ms')} ${dim('(' + b.loading.percentage + '%)')}`);
      if (b.scripting.slowEvents && b.scripting.slowEvents.length > 0) {
        lines.push(`    ${red('!')} ${gray('Slow Script Events:')}`);
        for (const e of b.scripting.slowEvents) {
          lines.push(`      ${dim('•')} ${red(e.durationMs + 'ms')} ${white(e.name)}`);
        }
      }
    }
    if (res.bottleneck) {
      const color = res.bottleneck === 'Balanced' ? green : res.bottleneck.includes('JavaScript') ? red : yellow;
      lines.push(`    ${magenta('◆')} ${gray('Bottleneck:')} ${color(res.bottleneck)}`);
    }
  }

  // PERF-ANALYZE command - AI 专用超详细分析
  if (cmd === 'PERF-ANALYZE') {
    if (res.summary) {
      lines.push(`    ${cyan('◆')} ${gray('Profiled')} ${cyan(res.duration + 'ms')} ${gray('/')} ${yellow(res.summary.sampleCount)} ${gray('samples')}`);
      lines.push(`    ${gray('    locations:')} ${white(res.summary.uniqueLocations)} ${gray('files:')} ${white(res.summary.filesAnalyzed)}`);
    }
    
    // Issues
    if (res.issues && res.issues.length > 0) {
      lines.push(`    ${red('!')} ${red('Performance Issues Found:')}`);
      for (const issue of res.issues) {
        const sev = issue.severity === 'high' ? red('[HIGH]') : issue.severity === 'medium' ? yellow('[MED]') : dim('[LOW]');
        lines.push(`    ${sev} ${white(issue.type)}: ${dim(issue.description)}`);
        if (issue.location) {
          lines.push(`      ${gray('at')} ${cyan(issue.location.file + ':' + issue.location.line + ':' + issue.location.column)}`);
        }
        lines.push(`      ${gray('fix:')} ${dim(issue.suggestion)}`);
      }
    }
    
    // Hotspots
    if (res.hotspots && res.hotspots.length > 0) {
      lines.push(`    ${yellow('◆')} ${gray('Hot Files:')}`);
      for (const f of res.hotspots.slice(0, 10)) {
        const pct = parseFloat(f.percentage);
        const pctColor = pct > 10 ? red : pct > 5 ? yellow : dim;
        lines.push(`    ${magenta('▸')} ${white(f.file)} ${cyan(f.totalTimeMs + 'ms')} ${pctColor('(' + f.percentage + '%)')}`);
        for (const loc of f.locations.slice(0, 5)) {
          const locPct = parseFloat(loc.percentage);
          const locColor = locPct > 5 ? red : locPct > 1 ? yellow : dim;
          lines.push(`      ${dim('L' + loc.line + ':' + loc.column)} ${locColor(loc.selfTimeMs + 'ms')} ${white(loc.functionName.substring(0, 30))} ${gray('(' + loc.hits + 'x)')}`);
        }
      }
    }
    
    // Call Stacks
    if (res.callStacks && res.callStacks.length > 0) {
      lines.push(`    ${magenta('◆')} ${gray('Heavy Call Stacks:')}`);
      for (const s of res.callStacks.slice(0, 5)) {
        lines.push(`    ${dim('▸')} ${cyan(s.timeMs + 'ms')} ${dim('(' + s.percentage + '%)')} ${gray('depth:' + s.depth)}`);
        // 显示调用栈（从底部到顶部，最多5帧）
        const frames = s.frames.slice(-5);
        for (let i = 0; i < frames.length; i++) {
          const f = frames[i];
          const indent = '      ' + '  '.repeat(i);
          const isLast = i === frames.length - 1;
          const marker = isLast ? red('→') : dim('│');
          lines.push(`${indent}${marker} ${white(f.fn.substring(0, 25))} ${dim(f.file + ':' + f.line)}`);
        }
      }
    }
    
    // Source Snippets
    if (res.sourceSnippets && res.sourceSnippets.length > 0) {
      lines.push(`    ${cyan('◆')} ${gray('Source Code Snippets:')}`);
      for (const snip of res.sourceSnippets.slice(0, 3)) {
        lines.push(`    ${magenta('▸')} ${white(snip.functionName)} ${dim('at')} ${cyan(snip.file + ':' + snip.lineNumber)}`);
        for (const line of snip.snippet) {
          const marker = line.isHotLine ? red('→') : dim(' ');
          const lineNum = dim(String(line.lineNumber).padStart(4));
          const code = line.isHotLine ? yellow(line.code) : dim(line.code);
          lines.push(`      ${marker}${lineNum} ${code}`);
        }
      }
    }
  }

  // PERF-MEMORY command - 内存分析
  if (cmd === 'PERF-MEMORY') {
    if (res.gcForced) lines.push(`    ${yellow('!')} ${yellow('GC forced before analysis')}`);
    
    // Heap
    if (res.heap) {
      lines.push(`    ${cyan('◆')} ${gray('JS Heap:')} ${cyan(res.heap.usedMB + 'MB')} ${gray('/')} ${dim(res.heap.totalMB + 'MB')}`);
    }
    
    // Counts
    if (res.counts) {
      const c = res.counts;
      lines.push(`    ${cyan('◆')} ${gray('Counts:')}`);
      lines.push(`    ${dim('•')} ${white('DOM Nodes')}      ${c.nodes > 1500 ? red(c.nodes) : c.nodes > 800 ? yellow(c.nodes) : green(c.nodes)}`);
      lines.push(`    ${dim('•')} ${white('Documents')}      ${cyan(c.documents)}`);
      lines.push(`    ${dim('•')} ${white('Frames')}         ${c.frames > 5 ? yellow(c.frames) : cyan(c.frames)}`);
      lines.push(`    ${dim('•')} ${white('Event Listeners')} ${c.jsEventListeners > 500 ? red(c.jsEventListeners) : cyan(c.jsEventListeners)}`);
      lines.push(`    ${dim('•')} ${white('Layout Objects')} ${cyan(c.layoutObjects)}`);
    }
    
    // DOM breakdown
    if (res.dom && res.dom.byTag) {
      lines.push(`    ${cyan('◆')} ${gray('DOM by Tag (top 10):')}`);
      const tags = Object.entries(res.dom.byTag).slice(0, 10);
      for (const [tag, count] of tags) {
        lines.push(`    ${dim('•')} ${white(tag.padEnd(12))} ${yellow(count)}`);
      }
    }
    
    // Issues
    if (res.issues && res.issues.length > 0) {
      lines.push(`    ${red('!')} ${red('Memory Issues:')}`);
      for (const issue of res.issues) {
        const sev = issue.severity === 'high' ? red('[HIGH]') : issue.severity === 'medium' ? yellow('[MED]') : dim('[LOW]');
        lines.push(`    ${sev} ${white(issue.type)} ${gray('count:')} ${yellow(issue.count)}`);
        lines.push(`      ${gray('fix:')} ${dim(issue.suggestion)}`);
      }
    }
  }

  // PERF-NETWORK command - 网络性能分析
  if (cmd === 'PERF-NETWORK') {
    // Reload indicator
    if (res.reloaded) {
      lines.push(`    ${green('+')} ${green('Fresh measurement (page reloaded)')}`);
    } else {
      lines.push(`    ${yellow('!')} ${dim('Cached data - use --reload for fresh measurement')}`);
    }
    // Stats
    if (res.stats) {
      const s = res.stats;
      const sizeStr = s.totalSize > 1024 * 1024 ? `${(s.totalSize / 1024 / 1024).toFixed(2)}MB` : `${(s.totalSize / 1024).toFixed(1)}KB`;
      lines.push(`    ${cyan('◆')} ${gray('Resources:')} ${yellow(s.total)} ${gray('total,')} ${magenta(sizeStr)}`);
      lines.push(`    ${gray('    blocking:')} ${s.blocking > 0 ? red(s.blocking) : green(s.blocking)} ${gray('cached:')} ${green(s.cached)}`);
    }
    
    // Timing
    if (res.timing) {
      lines.push(`    ${cyan('◆')} ${gray('Page Timing:')}`);
      lines.push(`    ${dim('•')} ${white('TTFB')}              ${cyan(Math.round(res.timing.ttfb) + 'ms')}`);
      lines.push(`    ${dim('•')} ${white('DOM Interactive')}   ${cyan(Math.round(res.timing.domInteractive) + 'ms')}`);
      lines.push(`    ${dim('•')} ${white('DOM Content Loaded')} ${cyan(Math.round(res.timing.domContentLoaded) + 'ms')}`);
      lines.push(`    ${dim('•')} ${white('Load')}              ${cyan(Math.round(res.timing.load) + 'ms')}`);
    }

    
    // Critical Path
    if (res.criticalPath && res.criticalPath.length > 0) {
      lines.push(`    ${red('!')} ${gray('Critical Path (render-blocking):')}`);
      for (const r of res.criticalPath.slice(0, 10)) {
        const blocking = r.blocking ? red('[B]') : dim('   ');
        lines.push(`    ${blocking} ${dim(r.startTime + 'ms')} ${white(r.name)} ${dim(r.type)} ${cyan(r.duration + 'ms')}`);
      }
    }
    
    // Slowest
    if (res.slowest && res.slowest.length > 0) {
      lines.push(`    ${yellow('!')} ${gray('Slowest Resources:')}`);
      for (const r of res.slowest.slice(0, 8)) {
        const size = r.size > 1024 ? `${(r.size / 1024).toFixed(1)}KB` : r.size > 0 ? `${r.size}B` : '';
        lines.push(`    ${dim('•')} ${red(r.duration + 'ms')} ${white(r.name)} ${dim(r.type)} ${dim(size)}`);
      }
    }
    
    // Largest
    if (res.largest && res.largest.length > 0) {
      lines.push(`    ${magenta('!')} ${gray('Largest Resources:')}`);
      for (const r of res.largest.slice(0, 5)) {
        if (r.size > 0) {
          const size = r.size > 1024 * 1024 ? `${(r.size / 1024 / 1024).toFixed(2)}MB` : `${(r.size / 1024).toFixed(1)}KB`;
          lines.push(`    ${dim('•')} ${magenta(size)} ${white(r.name)} ${dim(r.type)}`);
        }
      }
    }
  }

  // PERF-LONGTASKS command - Long Tasks 分析
  if (cmd === 'PERF-LONGTASKS') {
    if (!res.supported) {
      lines.push(`    ${red('!')} ${red('Long Task API not supported in this browser')}`);
    } else {
      // Summary
      if (res.summary) {
        const s = res.summary;
        const countColor = s.count > 10 ? red : s.count > 5 ? yellow : green;
        lines.push(`    ${cyan('◆')} ${gray('Monitored')} ${cyan(res.duration + 'ms')} ${gray('threshold:')} ${yellow(res.threshold + 'ms')}`);
        lines.push(`    ${gray('    tasks:')} ${countColor(s.count)} ${gray('blocking time:')} ${s.totalBlockingTime > 300 ? red(s.totalBlockingTime + 'ms') : yellow(s.totalBlockingTime + 'ms')}`);
        if (s.count > 0) {
          lines.push(`    ${gray('    avg:')} ${cyan(s.avgDuration + 'ms')} ${gray('max:')} ${s.maxDuration > 100 ? red(s.maxDuration + 'ms') : yellow(s.maxDuration + 'ms')}`);
        }
      }
      
      // By Source
      if (res.bySource && res.bySource.length > 0) {
        lines.push(`    ${yellow('!')} ${gray('By Source:')}`);
        for (const s of res.bySource) {
          lines.push(`    ${dim('•')} ${white(s.source.substring(0, 35))} ${gray('×')}${yellow(s.count)} ${cyan(s.totalTime + 'ms')}`);
        }
      }
      
      // Individual Tasks
      if (res.tasks && res.tasks.length > 0) {
        lines.push(`    ${magenta('◆')} ${gray('Long Tasks:')}`);
        for (const t of res.tasks.slice(0, 10)) {
          const durColor = t.duration > 100 ? red : yellow;
          lines.push(`    ${dim('•')} ${dim('@' + t.startTime + 'ms')} ${durColor(t.duration + 'ms')} ${dim(t.source)}`);
        }
      }
      
      if (res.summary && res.summary.count === 0) {
        lines.push(`    ${green('+')} ${green('No long tasks detected - main thread is responsive')}`);
      }
    }
  }

  // RESOURCES command
  if (cmd === 'RESOURCES') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);
    if (res.frameTree) {
      const frame = res.frameTree.frame;
      if (frame) {
        lines.push(`    ${cyan('◆')} ${gray('frame')} ${white(frame.id?.substring(0, 16) || 'main')}`);
        lines.push(`    ${gray('url')} ${blue((frame.url || '').substring(0, 60))}`);
        lines.push(`    ${gray('origin')} ${dim(frame.securityOrigin || '')}`);
      }
      const resources = res.frameTree.resources || [];
      if (resources.length) {
        lines.push(`    ${cyan('◆')} ${cyan(resources.length)} ${gray('resources')}`);
        const byType = {};
        for (const r of resources) {
          byType[r.type] = (byType[r.type] || 0) + 1;
        }
        for (const [type, count] of Object.entries(byType)) {
          lines.push(`    ${dim('•')} ${white(type)} ${gray('×')} ${yellow(count)}`);
        }
      }
      const childFrames = res.frameTree.childFrames || [];
      if (childFrames.length) {
        lines.push(`    ${gray('childFrames')} ${yellow(childFrames.length)}`);
      }
    }
    if (res.content) {
      const preview = res.content.substring(0, 200).replace(/\n/g, ' ');
      lines.push(`    ${gray('content')} ${dim(preview)}${res.content.length > 200 ? '...' : ''}`);
    }
  }

  // EMULATE command
  if (cmd === 'EMULATE') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);
    if (res.device) lines.push(`    ${gray('device')} ${magenta(res.device)}`);
    if (res.width && res.height) lines.push(`    ${gray('viewport')} ${yellow(res.width)}${gray('×')}${yellow(res.height)}`);
    if (res.mobile !== undefined) lines.push(`    ${gray('mobile')} ${res.mobile ? green('yes') : dim('no')}`);
    if (res.userAgent) lines.push(`    ${gray('ua')} ${dim(res.userAgent.substring(0, 60))}${res.userAgent.length > 60 ? '...' : ''}`);
    if (res.latitude !== undefined) lines.push(`    ${gray('geo')} ${cyan(res.latitude)}, ${cyan(res.longitude)}`);
  }

  // DEBUG command
  if (cmd === 'DEBUG') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);
    if (res.debuggerId) lines.push(`    ${gray('debuggerId')} ${dim(res.debuggerId)}`);
    if (res.breakpointId) lines.push(`    ${gray('breakpointId')} ${yellow(res.breakpointId)}`);
    if (res.url) lines.push(`    ${gray('url')} ${dim(res.url)}`);
    if (res.line !== undefined) lines.push(`    ${gray('line')} ${yellow(res.line)}`);
    if (res.locations && Array.isArray(res.locations)) {
      for (const loc of res.locations.slice(0, 3)) {
        lines.push(`    ${dim('•')} ${gray('scriptId:')} ${dim(loc.scriptId)} ${gray('line:')} ${yellow(loc.lineNumber)}`);
      }
    }
  }

  // CACHE command
  if (cmd === 'CACHE') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);
  }

  // CDP command (raw)
  if (cmd === 'CDP') {
    if (res.method) lines.push(`    ${gray('method')} ${magenta(res.method)}`);
    if (res.result !== undefined) {
      const resultStr = typeof res.result === 'object' ? JSON.stringify(res.result, null, 2) : String(res.result);
      if (resultStr.length > 500) {
        lines.push(`    ${gray('result')} ${dim(resultStr.substring(0, 500))}...`);
      } else if (resultStr.includes('\n')) {
        lines.push(`    ${gray('result')}`);
        for (const line of resultStr.split('\n').slice(0, 20)) {
          lines.push(`    ${dim(line)}`);
        }
      } else {
        lines.push(`    ${gray('result')} ${dim(resultStr)}`);
      }
    }
  }

  // NETWORK command
  if (cmd === 'NETWORK') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);
    if (res.requests && Array.isArray(res.requests)) {
      lines.push(`    ${cyan('◆')} ${cyan(res.count || res.requests.length)}${gray('/')}${dim(res.total || res.requests.length)} ${gray('requests')}`);
      for (const r of res.requests.slice(0, 25)) {
        if (r.status !== undefined) {
          // XHR/Fetch 请求
          const status = r.status ? (r.status >= 400 ? red(r.status) : r.status >= 300 ? yellow(r.status) : green(r.status)) : gray('...');
          const method = magenta((r.method || 'GET').padEnd(4));
          const type = dim((r.type || '').padEnd(5));
          const urlShort = (r.url || '').substring(0, 55);
          const duration = r.duration ? gray(`${r.duration}ms`) : '';
          lines.push(`    ${dim('•')} ${status} ${method} ${type} ${white(urlShort)}${r.url?.length > 55 ? '...' : ''} ${duration}`);
          if (r.response) {
            const preview = r.response.substring(0, 80).replace(/\n/g, ' ');
            lines.push(`      ${gray('resp:')} ${dim(preview)}${r.response.length > 80 ? '...' : ''}`);
          }
        } else {
          // Performance API 请求
          const type = dim((r.type || '').padEnd(6));
          const size = r.size ? yellow(`${Math.round(r.size/1024)}KB`) : gray('--');
          const duration = r.duration ? gray(`${r.duration}ms`) : '';
          const urlShort = (r.name || '').substring(0, 55);
          lines.push(`    ${dim('•')} ${type} ${size} ${white(urlShort)}${r.name?.length > 55 ? '...' : ''} ${duration}`);
        }
      }
      if (res.requests.length > 25) {
        lines.push(`    ${dim(`... and ${res.requests.length - 25} more`)}`);
      }
    }
  }

  // SCRIPTS command
  if (cmd === 'SCRIPTS') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);
    if (res.scripts && Array.isArray(res.scripts)) {
      lines.push(`    ${cyan('◆')} ${cyan(res.count || res.scripts.length)} ${gray('scripts')}`);
      for (const s of res.scripts.slice(0, 20)) {
        const src = s.src || '(inline)';
        const srcShort = src.substring(0, 65);
        const info = s.inline ? yellow(`${s.length} chars`) : (s.async ? dim('async') : s.defer ? dim('defer') : '');
        lines.push(`    ${dim('•')} ${yellow(`[${s.id}]`)} ${white(srcShort)}${src.length > 65 ? '...' : ''} ${info}`);
      }
    }
    // 搜索结果
    if (res.matches && Array.isArray(res.matches)) {
      lines.push(`    ${cyan('◆')} ${cyan(res.count)} ${gray('matches for')} ${white(res.query)}`);
      for (const m of res.matches.slice(0, 20)) {
        const loc = m.type === 'inline' ? `inline[${m.index}]:${m.line}` : `${m.url?.split('/').pop()}:${m.line}`;
        lines.push(`    ${dim('•')} ${yellow(loc)}`);
        lines.push(`      ${dim(m.preview)}`);
      }
    }
    // 源代码
    if (res.source) {
      lines.push(`    ${gray('type')} ${cyan(res.type)} ${res.url ? gray('url: ') + dim(res.url) : res.index !== undefined ? gray('index: ') + yellow(res.index) : ''}`);
      lines.push(`    ${gray('length')} ${yellow(res.length)} ${gray('chars')}`);
      const sourceLines = res.source.substring(0, 800).split('\n').slice(0, 15);
      lines.push(`    ${gray('source')}`);
      for (let i = 0; i < sourceLines.length; i++) {
        lines.push(`    ${dim((i+1).toString().padStart(3))} ${dim(sourceLines[i].substring(0, 80))}`);
      }
      if (res.source.length > 800) lines.push(`    ${dim('...')}`);
    }
  }

  // HOOK command
  if (cmd === 'HOOK') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);
    if (res.funcPath) lines.push(`    ${gray('function')} ${magenta(res.funcPath)}`);
  }

  // VAR command
  if (cmd === 'VAR') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);
    if (res.path) lines.push(`    ${gray('path')} ${magenta(res.path)}`);
    if (res.type) lines.push(`    ${gray('type')} ${cyan(res.type)}${res.subtype ? dim('/' + res.subtype) : ''}`);
    if (res.value !== undefined) {
      const valStr = typeof res.value === 'object' ? JSON.stringify(res.value, null, 2) : String(res.value);
      if (valStr.length > 200 || valStr.includes('\n')) {
        lines.push(`    ${gray('value')}`);
        for (const line of valStr.split('\n').slice(0, 15)) {
          lines.push(`    ${dim(line.substring(0, 80))}`);
        }
      } else {
        lines.push(`    ${gray('value')} ${white(valStr)}`);
      }
    }
    if (res.description && res.value === undefined) {
      lines.push(`    ${gray('desc')} ${dim(res.description)}`);
    }
    // 属性列表
    if (res.properties && Array.isArray(res.properties)) {
      lines.push(`    ${cyan('◆')} ${cyan(res.count)} ${gray('properties')}`);
      for (const p of res.properties.slice(0, 20)) {
        const val = p.value !== undefined ? white(String(p.value).substring(0, 40)) : dim(p.description || '');
        lines.push(`    ${dim('•')} ${yellow(p.name)} ${gray(':')} ${cyan(p.type || '?')} ${val}`);
      }
    }
  }

  // BREAKON command
  if (cmd === 'BREAKON') {
    if (res.type) lines.push(`    ${gray('type')} ${cyan(res.type)}`);
    if (res.url) lines.push(`    ${gray('url')} ${dim(res.url)}`);
    if (res.event) lines.push(`    ${gray('event')} ${magenta(res.event)}`);
  }

  // MEDIA command
  if (cmd === 'MEDIA') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);

    // 媒体列表
    if (res.media && Array.isArray(res.media)) {
      lines.push(`    ${cyan('◆')} ${cyan(res.count || res.media.length)} ${gray('media elements')}`);
      for (const m of res.media) {
        const status = m.playing ? green('PLAYING') : m.paused ? yellow('PAUSED') : red('STOPPED');
        const muted = m.muted ? red(' [MUTED]') : '';
        const time = `${Math.floor(m.currentTime / 60)}:${String(Math.floor(m.currentTime % 60)).padStart(2, '0')}/${Math.floor(m.duration / 60)}:${String(Math.floor(m.duration % 60)).padStart(2, '0')}`;
        const vol = m.muted ? red('0%') : green(Math.round(m.volume * 100) + '%');
        lines.push(`    ${dim('•')} ${magenta(m.type)}[${yellow(m.index)}] ${status}${muted} ${gray(time)} ${gray('vol:')}${vol}`);
        if (m.src) {
          const srcShort = m.src.length > 60 ? m.src.substring(0, 60) + '...' : m.src;
          lines.push(`      ${gray('src:')} ${dim(srcShort)}`);
        }
        if (m.width && m.height) lines.push(`      ${gray('size:')} ${dim(m.width + 'x' + m.height)}`);
      }
    }

    // 媒体 URL 列表
    if (res.urls && Array.isArray(res.urls) && res.action === 'urls') {
      for (const item of res.urls) {
        lines.push(`    ${magenta(item.type)}[${yellow(item.index)}]`);
        for (const s of item.sources || []) {
          const urlShort = s.url.length > 70 ? s.url.substring(0, 70) + '...' : s.url;
          lines.push(`      ${dim('•')} ${gray(s.type + ':')} ${white(urlShort)}`);
          if (s.mime) lines.push(`        ${gray('mime:')} ${dim(s.mime)}`);
        }
      }
    }

    // 网络媒体 URL
    if (res.urls && Array.isArray(res.urls) && res.action === 'network') {
      lines.push(`    ${cyan('◆')} ${cyan(res.count)} ${gray('media URLs from network')}`);
      for (const u of res.urls.slice(0, 20)) {
        const urlShort = u.url.length > 60 ? u.url.substring(0, 60) + '...' : u.url;
        const size = u.size ? yellow(Math.round(u.size / 1024) + 'KB') : '';
        lines.push(`    ${dim('•')} ${magenta(u.type)} ${white(urlShort)} ${size}`);
      }
      if (res.urls.length > 20) lines.push(`    ${dim(`... and ${res.urls.length - 20} more`)}`);
    }

    // 详细信息
    if (res.action === 'info' && res.type) {
      const status = res.playing ? green('PLAYING') : res.paused ? yellow('PAUSED') : red('STOPPED');
      lines.push(`    ${magenta(res.type)}[${yellow(res.index)}] ${status}`);
      lines.push(`    ${gray('time')} ${white(res.currentTime?.toFixed(1))}${gray('/')}${dim(res.duration?.toFixed(1) || '?')}${gray('s')} ${gray('rate:')}${cyan(res.playbackRate + 'x')}`);
      lines.push(`    ${gray('volume')} ${res.muted ? red('MUTED') : green(Math.round(res.volume * 100) + '%')}`);
      lines.push(`    ${gray('state')} ${dim(res.readyStateText)} ${gray('/')} ${dim(res.networkStateText)}`);
      if (res.videoWidth) lines.push(`    ${gray('resolution')} ${cyan(res.videoWidth + 'x' + res.videoHeight)}`);
      if (res.currentSrc) {
        const srcShort = res.currentSrc.length > 60 ? res.currentSrc.substring(0, 60) + '...' : res.currentSrc;
        lines.push(`    ${gray('src')} ${dim(srcShort)}`);
      }
      if (res.error) lines.push(`    ${red('error')} ${red(res.error.message || 'code:' + res.error.code)}`);
    }

    // 控制操作结果
    if (res.action && ['play', 'forceplay', 'pause', 'mute', 'unmute', 'volume', 'seek', 'rate'].includes(res.action)) {
      if (res.paused !== undefined) lines.push(`    ${gray('paused')} ${res.paused ? yellow('true') : green('false')}`);
      if (res.muted !== undefined) lines.push(`    ${gray('muted')} ${res.muted ? red('true') : green('false')}`);
      if (res.volume !== undefined) lines.push(`    ${gray('volume')} ${green(Math.round(res.volume * 100) + '%')}`);
      if (res.currentTime !== undefined) lines.push(`    ${gray('time')} ${cyan(res.currentTime.toFixed(1) + 's')}`);
      if (res.playbackRate !== undefined) lines.push(`    ${gray('rate')} ${cyan(res.playbackRate + 'x')}`);
      if (res.warning) lines.push(`    ${yellow('!')} ${yellow(res.warning)}`);
    }
  }

  // UPLOAD command
  if (cmd === 'UPLOAD') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);
    if (res.file) lines.push(`    ${gray('file')} ${white(res.file)}`);
    if (res.fileName) lines.push(`    ${gray('name')} ${cyan(res.fileName)}`);
    if (res.size !== undefined) lines.push(`    ${gray('size')} ${yellow(Math.round(res.size / 1024) + 'KB')}`);
    if (res.selector) lines.push(`    ${gray('selector')} ${dim(res.selector)}`);
    if (res.files && Array.isArray(res.files)) {
      lines.push(`    ${cyan('◆')} ${cyan(res.count)} ${gray('files uploaded')}`);
      for (const f of res.files) {
        lines.push(`    ${dim('•')} ${white(f.name)} ${yellow(Math.round(f.size / 1024) + 'KB')}`);
      }
    }
  }

  // DOWNLOAD command
  if (cmd === 'DOWNLOAD') {
    if (res.action) lines.push(`    ${gray('action')} ${cyan(res.action)}`);
    if (res.path) lines.push(`    ${gray('path')} ${white(res.path)}`);
    if (res.url) lines.push(`    ${gray('url')} ${blue(res.url.length > 60 ? res.url.substring(0, 60) + '...' : res.url)}`);
    if (res.filename) lines.push(`    ${gray('filename')} ${cyan(res.filename)}`);

    // 下载链接列表
    if (res.links && Array.isArray(res.links)) {
      lines.push(`    ${cyan('◆')} ${cyan(res.count)} ${gray('download links')}`);
      for (const link of res.links.slice(0, 15)) {
        const type = link.type === 'download-attr' ? green('[D]') : yellow('[F]');
        const ext = link.ext ? dim(link.ext) : '';
        const href = (link.href || '').substring(0, 50);
        lines.push(`    ${dim('•')} ${type} ${white(href)}${link.href?.length > 50 ? '...' : ''} ${ext}`);
        if (link.text) lines.push(`      ${gray('text:')} ${dim(link.text)}`);
      }
      if (res.links.length > 15) lines.push(`    ${dim(`... and ${res.links.length - 15} more`)}`);
    }

    // file input 列表
    if (res.inputs && Array.isArray(res.inputs)) {
      lines.push(`    ${cyan('◆')} ${cyan(res.count)} ${gray('file inputs')}`);
      for (const input of res.inputs) {
        const multi = input.multiple ? green('[M]') : '';
        const disabled = input.disabled ? red('[X]') : '';
        const name = input.name || input.id || `input[${input.index}]`;
        lines.push(`    ${dim('•')} ${yellow(`[${input.index}]`)} ${white(name)} ${multi}${disabled}`);
        lines.push(`      ${gray('accept:')} ${dim(input.accept)} ${gray('files:')} ${cyan(input.files)}`);
      }
    }
  }

  // DEBUG command - 调试元素位置和点击目标
  if (cmd === 'DEBUG') {
    if (res.targetId) lines.push(`    ${gray('target id')} ${yellow(res.targetId)}`);
    if (res.targetNode) {
      lines.push(`    ${gray('target node')}`);
      lines.push(`      ${gray('role:')} ${cyan(res.targetNode.role || 'unknown')}`);
      lines.push(`      ${gray('text:')} ${dim(res.targetNode.text || '(empty)')}`);
      lines.push(`      ${gray('backendNodeId:')} ${yellow(res.targetNode.backendDOMNodeId || 'N/A')}`);
    }
    if (res.computedPoint) {
      const vp = res.computedPoint.inViewport ? green('in viewport') : red('OUT OF VIEWPORT');
      lines.push(`    ${gray('computed point')} ${cyan(`(${res.computedPoint.x}, ${res.computedPoint.y})`)} ${vp}`);
    }
    if (res.computedRect) {
      const r = res.computedRect;
      lines.push(`    ${gray('computed rect')} ${dim(`left:${r.left} top:${r.top} ${r.width}x${r.height}`)}`);
    }
    if (res.elementAtPoint) {
      const el = res.elementAtPoint;
      if (el.found) {
        lines.push(`    ${cyan('◆')} ${gray('element at click point')}`);
        lines.push(`      ${gray('tag:')} ${white(el.tag)} ${el.id ? `${gray('id:')} ${yellow(el.id)}` : ''}`);
        if (el.className) lines.push(`      ${gray('class:')} ${dim(el.className)}`);
        if (el.text) lines.push(`      ${gray('text:')} ${dim(el.text)}`);
        if (el.path) lines.push(`      ${gray('path:')} ${dim(el.path)}`);
        if (el.rect) {
          const r = el.rect;
          lines.push(`      ${gray('rect:')} ${dim(`left:${r.left} top:${r.top} ${r.width}x${r.height}`)}`);
        }
      } else {
        lines.push(`    ${red('[!]')} ${red('no element found at click point')}`);
      }
    }
    if (res.clicked) {
      lines.push(`    ${green('>')} ${green('clicked')}`);
    }
  }

  // Generic message fallback
  if (res.message && !['COOKIES', 'STORAGE', 'INJECT'].includes(cmd)) {
    lines.push(`    ${gray('message')} ${dim(res.message)}`);
  }

  // IP Info
  if (res.ip && res.health) {
    const scoreColor = res.health.score >= 80 ? green : res.health.score >= 60 ? cyan : res.health.score >= 40 ? yellow : red;
    lines.push(`    ${gray('ip')} ${white(res.ip)}`);
    lines.push(`    ${gray('health')} ${scoreColor(res.health.score)} ${gray('/')} ${dim('100')} ${gray(`(${res.health.level})`)}`);

    if (res.location) {
      const loc = res.location;
      const parts = [loc.city, loc.region, loc.country].filter(Boolean);
      lines.push(`    ${gray('location')} ${white(parts.join(', '))}`);
      if (loc.timezone) lines.push(`    ${gray('timezone')} ${dim(loc.timezone)}`);
      if (loc.coordinates) lines.push(`    ${gray('coords')} ${dim(loc.coordinates)}`);
    }

    if (res.org) lines.push(`    ${gray('org')} ${dim(res.org)}`);

    if (res.risk) {
      const r = res.risk;
      const flags = [];
      if (r.vpn) flags.push(yellow('VPN'));
      if (r.proxy) flags.push(yellow('Proxy'));
      if (flags.length) lines.push(`    ${gray('flags')} ${flags.join(', ')}`);
      if (r.riskScore > 0) lines.push(`    ${gray('risk')} ${r.riskScore > 50 ? red(r.riskScore) : yellow(r.riskScore)}`);
      if (r.type && r.type !== 'unknown') lines.push(`    ${gray('type')} ${dim(r.type)}`);
      if (r.provider) lines.push(`    ${gray('provider')} ${dim(r.provider)}`);
    }
  }

  // Extract results (products/items)
  if (res.items && Array.isArray(res.items)) {
    lines.push(`    ${cyan('◆')} ${cyan(res.count || res.items.length)} ${gray('items extracted')}`);
    lines.push('');

    for (const item of res.items) {
      const id = yellow(`[${String(item.id).padStart(2)}]`);
      const title = white((item.title || '').substring(0, 50));
      const price = item.price ? green(item.price) : gray('--');
      const rating = item.rating ? `${yellow('★' + item.rating)}` : '';
      const reviews = item.reviews ? gray(`(${item.reviews})`) : '';

      lines.push(`    ${id} ${title}`);
      lines.push(`        ${gray('price')} ${price} ${rating} ${reviews}`);
    }
  }

  // Product detail (from detail command)
  if (res.cmd === 'DETAIL' && res.title) {
    lines.push(`    ${cyan('◆')} ${gray('product detail')}`);
    lines.push(`    ${gray('title')} ${white(res.title.substring(0, 60))}`);
    if (res.price) lines.push(`    ${gray('price')} ${green(res.price)}`);
    if (res.rating) lines.push(`    ${gray('rating')} ${yellow('★' + res.rating)} ${res.reviews ? gray(`(${res.reviews} reviews)`) : ''}`);
    if (res.availability) lines.push(`    ${gray('stock')} ${res.availability.includes('In Stock') ? green(res.availability) : yellow(res.availability)}`);
    if (res.brand) lines.push(`    ${gray('brand')} ${dim(res.brand)}`);
    if (res.seller) lines.push(`    ${gray('seller')} ${dim(res.seller)}`);
    if (res.features && res.features.length) {
      lines.push(`    ${gray('features')}`);
      for (const f of res.features.slice(0, 3)) {
        lines.push(`      ${dim('•')} ${dim(f.substring(0, 70))}`);
      }
    }
  }

  // DO command result
  if (res.result && res.result.action) {
    const r = res.result;
    let coords = '';
    if (r.x !== undefined && r.y !== undefined) {
      coords = ` ${gray('at')} ${dim(`(${r.x}, ${r.y})`)}`;
    }
    lines.push(`    ${magenta(r.action)} ${gray('id:')}${yellow(r.id)}${coords}`);
    if (r.typed) lines.push(`    ${gray('typed')} ${dim('"')}${white(r.typed)}${dim('"')}`);
  }

  // Viewport
  if (res.viewport && !res.elements) {
    lines.push(`    ${gray('viewport')} ${dim(`${res.viewport.w}x${res.viewport.h}`)}`);
  }

  // Tabs
  if (res.tabs && Array.isArray(res.tabs)) {
    lines.push(`    ${magenta('◆')} ${magenta(res.tabs.length)} ${gray('tabs')}`);
    for (const tab of res.tabs) {
      const marker = tab.active ? green('>') : gray(' ');
      const title = (tab.title || '').substring(0, 35);
      const id = yellow(`[${tab.id}]`);
      lines.push(`    ${marker} ${id} ${white(title)}`);
    }
  }

  // Tab operations
  if (res.closed !== undefined) {
    lines.push(`    ${gray('closed')} ${yellow(res.closed)} ${gray('remaining')} ${green(res.remaining)}`);
  }

  // Scan results - elements
  if (res.elements && Array.isArray(res.elements)) {
    const total = res.totalFound || res.elements.length;
    const truncNote = res.truncated ? ` ${gray(`(${total} total)`)}` : '';
    lines.push(`    ${cyan('◆')} ${cyan(res.elements.length)} ${gray('elements')}${truncNote} ${gray('in')} ${dim(`${res.viewport?.w || '?'}x${res.viewport?.h || '?'}`)}`);
    lines.push('');

    // 按行分组显示
    let i = 0;
    while (i < res.elements.length) {
      const el = res.elements[i];
      
      // 检查是否是行的开始
      if (el._row && el._rowPos === 0) {
        // 收集同一行的所有元素
        const rowEls = [el];
        let j = i + 1;
        while (j < res.elements.length && res.elements[j]._row === el._row) {
          rowEls.push(res.elements[j]);
          j++;
        }
        
        // 紧凑格式：每个元素显示 [id]"text"，不省略
        const parts = rowEls.map(e => {
          const id = yellow(`[${String(e.id).padStart(3)}]`);
          const text = (e.text || '').substring(0, 8);
          return `${id}${dim('"')}${white(text)}${dim('"')}`;
        });
        lines.push(`    ${gray('row')} ${parts.join(' ')}`);
        
        i = j;
      } else {
        // 普通元素 - 完整格式
        const id = yellow(`[${String(el.id).padStart(3)}]`);
        const type = cyan((el.type || 'element').padEnd(8));
        const text = (el.text || '').substring(0, 45).replace(/\n/g, ' ');
        const completed = el.completed === true ? ` ${green('[+]')}` : '';
        const value = el.value ? ` ${gray(`val="${el.value.substring(0, 12)}"`)}` : '';
        lines.push(`    ${id} ${type} ${dim('"')}${white(text)}${dim('"')}${value}${completed}`);
        i++;
      }
    }
  }

  // Find matches (for find command, not SCRIPTS)
  if (res.matches && Array.isArray(res.matches) && cmd !== 'SCRIPTS') {
    lines.push(`    ${cyan('◆')} ${cyan(res.matches.length)} ${gray('matches')}`);
    for (const el of res.matches) {
      const id = yellow(`[${String(el.id).padStart(3)}]`);
      const type = cyan((el.type || 'element').padEnd(8));
      const text = (el.text || '').substring(0, 45).replace(/\n/g, ' ');
      lines.push(`    ${id} ${type} ${dim('"')}${white(text)}${dim('"')}`);
    }
  }

  // Batch results - 递归格式化每个命令的完整输出
  if (cmd === 'BATCH' && res.results && Array.isArray(res.results)) {
    for (const r of res.results) {
      if (r.ok && r.result) {
        // 递归调用 formatText 来格式化每个子命令的结果
        const subOutput = formatText(r.result, r.duration ? Date.now() - r.duration : null);
        lines.push(subOutput);
      } else if (!r.ok) {
        lines.push(`${red('[-]')} ${red(r.error || 'failed')}`);
        if (r.cmd) lines.push(`    ${gray('cmd:')} ${cyan(r.cmd)}`);
      }
      lines.push(''); // 空行分隔
    }
  }

  // ============================================
  // FALLBACK: 通用格式化未知命令的结果
  // ============================================
  // 如果 lines 只有 header（cmd + url/title），说明没有特定格式化
  // 自动格式化 summary、tasks、points 等常见字段
  if (lines.length <= 3) {
    // summary 对象 - 常用于统计信息
    if (res.summary && typeof res.summary === 'object') {
      const s = res.summary;
      const parts = [];
      if (s.total !== undefined) parts.push(`${gray('total:')} ${cyan(s.total)}`);
      if (s.pending !== undefined) parts.push(`${gray('pending:')} ${yellow(s.pending)}`);
      if (s.complete !== undefined) parts.push(`${gray('complete:')} ${green(s.complete)}`);
      if (s.pendingPoints !== undefined) parts.push(`${gray('points:')} ${magenta(s.pendingPoints)}`);
      if (parts.length) lines.push(`    ${parts.join(' ')}`);
      
      // 其他 summary 字段
      for (const [k, v] of Object.entries(s)) {
        if (!['total', 'pending', 'complete', 'pendingPoints'].includes(k)) {
          lines.push(`    ${gray(k + ':')} ${white(String(v))}`);
        }
      }
    }
    
    // points 对象 - 积分信息
    if (res.points && typeof res.points === 'object') {
      const p = res.points;
      if (p.total !== undefined) lines.push(`    ${gray('total')} ${green(p.total.toLocaleString())}`);
      if (p.today !== undefined) lines.push(`    ${gray('today')} ${cyan('+' + p.today)}`);
      if (p.streak !== undefined && p.streak > 0) lines.push(`    ${gray('streak')} ${yellow(p.streak + ' days')}`);
    }
    
    // tasks 数组 - 任务列表
    if (res.tasks && Array.isArray(res.tasks) && res.tasks.length > 0) {
      lines.push('');
      for (const t of res.tasks) {
        const status = t.status === 'complete' ? green('[✓]') : yellow('[○]');
        const pts = t.points ? (t.status === 'complete' ? dim(`${t.points}`) : magenta(`${t.points}`)) : '';
        const title = (t.title || '').substring(0, 50);
        const type = t.type && t.type !== 'unknown' ? dim(`(${t.type})`) : '';
        lines.push(`    ${status} ${white(title)} ${pts} ${type}`);
      }
    }
    
    // 通用数组字段
    for (const [key, val] of Object.entries(res)) {
      if (Array.isArray(val) && val.length > 0 && !['tasks', 'elements', 'matches', 'results', 'tabs', 'items', 'urls', 'links', 'inputs', 'scripts', 'requests', 'properties', 'media', 'files', 'features', 'redirectChain'].includes(key)) {
        lines.push(`    ${cyan('◆')} ${cyan(val.length)} ${gray(key)}`);
        for (const item of val.slice(0, 10)) {
          if (typeof item === 'object') {
            const parts = Object.entries(item).slice(0, 4).map(([k, v]) => `${gray(k + ':')} ${white(String(v).substring(0, 30))}`);
            lines.push(`    ${dim('•')} ${parts.join(' ')}`);
          } else {
            lines.push(`    ${dim('•')} ${white(String(item).substring(0, 60))}`);
          }
        }
        if (val.length > 10) lines.push(`    ${dim(`... and ${val.length - 10} more`)}`);
      }
    }
    
    // 通用对象字段（排除已处理的）
    const skipKeys = new Set(['ok', 'cmd', 'url', 'title', 'summary', 'points', 'tasks', 'elements', 'matches', 'results', 'tabs', 'items', 'urls', 'links', 'inputs', 'scripts', 'requests', 'properties', 'media', 'files', 'features', 'redirectChain', 'viewport', 'timedOut', 'warning', 'newTab', 'newUrl', 'navigated', 'direction', 'redirected', 'is404', 'isBlank', 'isError', 'domainChanged', 'redirectedToHome', 'finalUrl', 'finalTitle', 'action', 'id', 'x', 'y', 'typed', 'result', 'type', 'count', 'selector', 'path', 'message', 'ip', 'health', 'location', 'org', 'risk', 'partialScan', 'totalFound', 'truncated', 'hopCount', 'originalDomain', 'finalDomain', 'blankReason', 'blankDetails', 'errorText', 'redirectFrom', 'redirectReason', 'errorTitle']);
    
    for (const [key, val] of Object.entries(res)) {
      if (skipKeys.has(key)) continue;
      if (val === null || val === undefined) continue;
      if (typeof val === 'object' && !Array.isArray(val)) {
        // 嵌套对象
        lines.push(`    ${gray(key + ':')}`);
        for (const [k, v] of Object.entries(val)) {
          if (v !== null && v !== undefined) {
            lines.push(`      ${gray(k + ':')} ${white(String(v).substring(0, 50))}`);
          }
        }
      } else if (!Array.isArray(val)) {
        // 简单值
        lines.push(`    ${gray(key)} ${white(String(val).substring(0, 60))}`);
      }
    }
  }

  return lines.join('\n');
}

            module.exports = {
              formatText
            };
