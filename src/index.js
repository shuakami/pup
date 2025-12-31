#!/usr/bin/env node
'use strict';

const path = require('path');
const readline = require('readline');

const config = require('./config');
const { Kernel } = require('./core/kernel');
const { PluginManager } = require('./core/plugin-manager');
const {
  cyan, green, yellow, red, magenta, blue, gray, white,
  brightCyan, bold, dim,
  formatDuration
} = require('./utils/colors');

function serializeError(err) {
  const message = (err && err.message) ? String(err.message) : String(err || 'Unknown error');
  const name = (err && err.name) ? String(err.name) : 'Error';
  const code = (err && err.code) ? String(err.code) : undefined;
  const out = { name, message };
  if (code) out.code = code;
  return out;
}

function pickCorrelation(req) {
  const keys = ['rpcId', 'reqId', 'requestId', 'corrId', 'correlationId', 'seq'];
  for (const k of keys) {
    if (req && Object.prototype.hasOwnProperty.call(req, k)) return req[k];
  }
  return null;
}

/**
 * Format result as colorful text output (Vite/Vitest style)
 */
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
  
  // Redirect detection
  if (res.redirected) {
    lines.push(`    ${yellow('[!]')} ${yellow('redirected')} ${gray('reason:')} ${red(res.redirectReason || 'unknown')}`);
    if (res.redirectFrom) lines.push(`    ${gray('from:')} ${dim(res.redirectFrom.substring(0, 60))}${res.redirectFrom.length > 60 ? '...' : ''}`);
  }
  if (res.is404) {
    lines.push(`    ${red('[!]')} ${red('404 page detected')}`);
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
  
  // PERF command
  if (cmd === 'PERF') {
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
      const otherKeys = Object.keys(res.metrics).filter(k => !important.includes(k)).slice(0, 5);
      if (otherKeys.length) {
        lines.push(`    ${dim(`... and ${Object.keys(res.metrics).length - important.length} more metrics`)}`);
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
    
    for (const el of res.elements) {
      const id = yellow(`[${String(el.id).padStart(3)}]`);
      const type = cyan((el.type || 'element').padEnd(8));
      const text = (el.text || '').substring(0, 45).replace(/\n/g, ' ');
      const completed = el.completed === true ? ` ${green('[+]')}` : '';
      const value = el.value ? ` ${gray(`val="${el.value.substring(0, 12)}"`)}` : '';
      lines.push(`    ${id} ${type} ${dim('"')}${white(text)}${dim('"')}${value}${completed}`);
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
  
  // Batch results
  if (res.results && Array.isArray(res.results)) {
    for (const r of res.results) {
      const status = r.ok ? green('[+]') : red('[-]');
      const cmdName = cyan(r.cmd || '?');
      if (r.ok && r.result) {
        const title = r.result.title ? ` ${gray(r.result.title.substring(0, 30))}` : '';
        lines.push(`    ${status} ${cmdName}${title}`);
      } else if (!r.ok) {
        lines.push(`    ${status} ${cmdName} ${red(r.error || 'failed')}`);
      } else {
        lines.push(`    ${status} ${cmdName}`);
      }
    }
  }
  
  return lines.join('\n');
}

/**
 * Output policy:
 * - --json / -j: compact JSONL (for programmatic use)
 * - --pretty: JSON pretty printed
 * - default: colorful text format (Vite style)
 */
function makeWriter(argv) {
  const JSON_LINE = argv.includes('--json') || argv.includes('-j');
  const PRETTY_JSON = argv.includes('--pretty');

  return (obj, startTime) => {
    if (JSON_LINE) {
      process.stdout.write(`${JSON.stringify(obj)}\n`);
    } else if (PRETTY_JSON) {
      process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
    } else {
      // Default: colorful text format
      process.stdout.write(`${formatText(obj, startTime)}\n`);
    }
  };
}

/**
 * Determine CLI mode:
 * - if first non-flag token exists => CLI command mode
 * - else => REPL mode
 */
function hasCommand(args) {
  return args.some((a) => a && !String(a).startsWith('-'));
}

// Banner (minimal, Vite-style)
function printBanner() {
  console.log('');
  console.log(`  ${bold(brightCyan('◆'))} ${bold('Pup')} ${gray('v1.0.0')}`);
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const writeLine = makeWriter(args);
  const isJsonMode = args.includes('--json') || args.includes('-j') || args.includes('--pretty');

  const binName = 'pup';

  // Boot kernel + plugins
  const kernel = new Kernel(config);
  const plugins = new PluginManager(kernel, path.join(__dirname, 'plugins'));
  
  // Show spinner during plugin loading (only in non-JSON mode)
  let loadError = null;
  try {
    await plugins.loadAll();
  } catch (e) {
    loadError = e;
  }
  
  // Only show plugin loading status on error
  if (loadError) {
    console.error(`${red('[-]')} ${red('Failed to load plugins:')} ${loadError.message}`);
    process.exit(1);
  }

  // Enable hot reload in long-running mode (REPL/dev).
  kernel.enableHotReload(plugins, path.join(__dirname, 'plugins'));

  // Help
  if (args.includes('-h') || args.includes('--help') || args[0] === 'help') {
    printBanner();
    process.stdout.write(buildColorfulHelp(plugins, binName));
    process.stdout.write('\n');
    await plugins.unloadAll().catch(() => {});
    await kernel.shutdown().catch(() => {});
    process.exit(0);
  }

  // CLI mode
  if (hasCommand(args)) {
    const cmd = String(args[0]).trim().toLowerCase();
    const argv = args.slice(1);
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

  // REPL mode (JSON per line)
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  let chain = Promise.resolve();

  rl.on('line', (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;

    chain = chain.then(async () => {
      let req;
      try {
        req = JSON.parse(trimmed);
      } catch {
        writeLine({ ok: false, error: { name: 'ParseError', message: 'Invalid JSON line' } });
        return;
      }

      const corr = pickCorrelation(req);
      const startTime = Date.now();

      try {
        const cmdRaw = (req && req.cmd) ? String(req.cmd) : '';
        const cmd = cmdRaw.trim().toUpperCase();

        let res;

        // Legacy REPL protocol mapping.
        if (cmd === 'PING') {
          res = await kernel.runCommand('ping', { argv: [] });
        } else if (cmd === 'STATUS') {
          res = await kernel.runCommand('status', { argv: [] });
        } else if (cmd === 'GOTO') {
          res = await kernel.runCommand('goto', { argv: [String(req.url || '')] });
        } else if (cmd === 'SCAN') {
          res = await kernel.runCommand('scan', { argv: [] });
        } else if (cmd === 'SCANALL') {
          res = await kernel.runCommand('scanall', { argv: [] });
        } else if (cmd === 'SCROLL') {
          res = await kernel.runCommand('scroll', { argv: [String(req.direction || 'down')] });
        } else if (cmd === 'ACT') {
          res = await kernel.runCommand('act', req);
        } else {
          // Direct command passthrough: { cmd: "click", argv: ["5"] }
          if (req && req.cmd && Array.isArray(req.argv)) {
            res = await kernel.runCommand(String(req.cmd).toLowerCase(), { argv: req.argv });
          } else {
            throw new Error(`Unknown cmd: ${cmd}`);
          }
        }

        if (corr !== null && corr !== undefined && res && typeof res === 'object') res.corr = corr;
        writeLine(res, startTime);
      } catch (e) {
        const out = { ok: false, error: serializeError(e) };
        if (corr !== null && corr !== undefined) out.corr = corr;
        writeLine(out, startTime);
      }
    }).catch((e) => {
      writeLine({ ok: false, error: serializeError(e) });
    });
  });

  rl.on('close', async () => {
    await plugins.unloadAll().catch(() => {});
    await kernel.shutdown().catch(() => {});
    process.exit(0);
  });
}

/**
 * Build colorful help text - teach users how to use
 */
function buildColorfulHelp(plugins, binName) {
  const lines = [];
  
  // Quick start
  lines.push(`  ${bold('Quick Start:')}`);
  lines.push('');
  lines.push(`    ${gray('1.')} ${cyan(`${binName} goto https://www.google.com`)}    ${dim('# open a page')}`);
  lines.push(`    ${gray('2.')} ${cyan(`${binName} scan`)}                            ${dim('# scan elements, get ids')}`);
  lines.push(`    ${gray('3.')} ${cyan(`${binName} type 15 "hello" --enter`)}         ${dim('# type in input id=15 and press enter')}`);
  lines.push(`    ${gray('4.')} ${cyan(`${binName} click 5`)}                         ${dim('# click element id=5')}`);
  lines.push('');
  
  // Core commands
  lines.push(`  ${bold('Navigation:')}`);
  lines.push(`    ${cyan('goto <url>')}              ${gray('open a webpage')}`);
  lines.push(`    ${cyan('goto <url> --scan')}       ${gray('open and scan')}`);
  lines.push(`    ${cyan('back / forward')}          ${gray('go back / forward')}`);
  lines.push(`    ${cyan('reload')}                  ${gray('reload page')}`);
  lines.push('');
  
  lines.push(`  ${bold('Page Analysis:')}`);
  lines.push(`    ${cyan('scan')}                    ${gray('scan page, list interactive elements with ids')}`);
  lines.push(`    ${cyan('scan --no-empty')}         ${gray('only show elements with text')}`);
  lines.push(`    ${cyan('scan --filter "text"')}    ${gray('filter elements containing text')}`);
  lines.push(`    ${cyan('status')}                  ${gray('show current page status')}`);
  lines.push('');
  
  lines.push(`  ${bold('Interaction:')}`);
  lines.push(`    ${cyan('click <id>')}              ${gray('click element')}`);
  lines.push(`    ${cyan('click "text"')}            ${gray('click element containing text')}`);
  lines.push(`    ${cyan('click <id> --js')}         ${gray('JS click (fixes modal/scroll issues)')}`);
  lines.push(`    ${cyan('type <id> "text"')}        ${gray('type into input field')}`);
  lines.push(`    ${cyan('type <id> "text" --enter')} ${gray('type and press enter')}`);
  lines.push(`    ${cyan('type 1 "text" --enter')}   ${gray('auto-find input (single input pages)')}`);
  lines.push(`    ${cyan('clear <id>')}              ${gray('clear input field')}`);
  lines.push(`    ${cyan('hover <id>')}              ${gray('hover over element')}`);
  lines.push(`    ${cyan('enter <id>')}              ${gray('focus element and press enter')}`);
  lines.push(`    ${cyan('select <id> "option"')}    ${gray('select dropdown option')}`);
  lines.push('');
  
  lines.push(`  ${bold('File Transfer:')}`);
  lines.push(`    ${cyan('upload <file>')}           ${gray('upload file to file input')}`);
  lines.push(`    ${cyan('download <url>')}          ${gray('download file from URL')}`);
  lines.push(`    ${cyan('download links')}          ${gray('list download links on page')}`);
  lines.push(`    ${cyan('download click <n>')}      ${gray('click download link by index')}`);
  lines.push('');
  
  lines.push(`  ${bold('Scrolling:')}`);
  lines.push(`    ${cyan('scroll down / up')}        ${gray('scroll down / up')}`);
  lines.push(`    ${cyan('scroll top / bottom')}     ${gray('scroll to top / bottom')}`);
  lines.push(`    ${cyan('scroll down --scan')}      ${gray('scroll and scan')}`);
  lines.push('');
  
  lines.push(`  ${bold('Tabs:')}`);
  lines.push(`    ${cyan('tabs')}                    ${gray('list all tabs')}`);
  lines.push(`    ${cyan('tab <id>')}                ${gray('switch to tab')}`);
  lines.push(`    ${cyan('newtab [url]')}            ${gray('open new tab')}`);
  lines.push(`    ${cyan('close')}                   ${gray('close current tab')}`);
  lines.push(`    ${cyan('closetab <id>')}           ${gray('close tab by id')}`);
  lines.push('');
  
  lines.push(`  ${bold('Data Extraction:')}`);
  lines.push(`    ${cyan('extract')}                 ${gray('extract product/list data from page')}`);
  lines.push(`    ${cyan('extract --limit 5')}       ${gray('limit extraction count')}`);
  lines.push(`    ${cyan('detail')}                  ${gray('extract product detail page data')}`);
  lines.push('');
  
  lines.push(`  ${bold('Utilities:')}`);
  lines.push(`    ${cyan('ipinfo')}                  ${gray('show IP info and health score')}`);
  lines.push(`    ${cyan('ipinfo --full')}           ${gray('show full IP risk info')}`);
  lines.push(`    ${cyan('screenshot')}              ${gray('take screenshot')}`);
  lines.push(`    ${cyan('wait <ms>')}               ${gray('wait for milliseconds')}`);
  lines.push(`    ${cyan('debug <id>')}              ${gray('debug element position')}`);
  lines.push('');
  
  lines.push(`  ${bold('JavaScript:')}`);
  lines.push(`    ${cyan('exec <code>')}             ${gray('execute JavaScript in page')}`);
  lines.push(`    ${cyan('query <selector>')}        ${gray('query DOM elements')}`);
  lines.push(`    ${cyan('setval <sel> <val>')}      ${gray('set element value')}`);
  lines.push(`    ${cyan('trigger <sel> <event>')}   ${gray('trigger DOM event')}`);
  lines.push('');
  
  lines.push(`  ${bold('DevTools:')}`);
  lines.push(`    ${cyan('network')}                 ${gray('show network requests')}`);
  lines.push(`    ${cyan('network --capture')}       ${gray('start capturing requests')}`);
  lines.push(`    ${cyan('cookies')}                 ${gray('show cookies')}`);
  lines.push(`    ${cyan('storage')}                 ${gray('show localStorage')}`);
  lines.push(`    ${cyan('dom <search query>')}      ${gray('search DOM')}`);
  lines.push(`    ${cyan('media')}                   ${gray('control video/audio')}`);
  lines.push('');
  
  // Output options
  lines.push(`  ${bold('Output Options:')}`);
  lines.push(`    ${cyan('--json, -j')}              ${gray('output JSON (for programmatic use)')}`);
  lines.push(`    ${cyan('--pretty')}                ${gray('output formatted JSON')}`);
  lines.push('');
  
  // Examples
  lines.push(`  ${bold('Examples:')}`);
  lines.push('');
  lines.push(`    ${dim('# Google search')}`);
  lines.push(`    ${cyan(`${binName} goto https://www.google.com`)}`);
  lines.push(`    ${cyan(`${binName} type 1 "mechanical keyboard" --enter`)}`);
  lines.push(`    ${cyan(`${binName} scan --no-empty`)}`);
  lines.push(`    ${cyan(`${binName} click 104`)}`);
  lines.push('');
  lines.push(`    ${dim('# eBay product search')}`);
  lines.push(`    ${cyan(`${binName} goto https://www.ebay.com`)}`);
  lines.push(`    ${cyan(`${binName} scan --filter "search"`)}`);
  lines.push(`    ${cyan(`${binName} type 97 "vintage watch" --enter`)}`);
  lines.push(`    ${cyan(`${binName} extract --limit 5`)}`);
  lines.push('');
  lines.push(`    ${dim('# Check IP')}`);
  lines.push(`    ${cyan(`${binName} ipinfo --full`)}`);
  lines.push('');
  
  // Tips
  lines.push(`  ${bold('Tips:')}`);
  lines.push(`    ${yellow('•')} ${gray('use scan first to get element ids, then click/type')}`);
  lines.push(`    ${yellow('•')} ${gray('type 1 only works on single-input pages, otherwise lists options')}`);
  lines.push(`    ${yellow('•')} ${gray('elements outside viewport are auto-scrolled')}`);
  lines.push(`    ${yellow('•')} ${gray('click "text" clicks element containing that text')}`);
  lines.push('');
  
  return lines.join('\n');
}

main().catch((e) => {
  const message = (e && e.message) ? String(e.message) : String(e || 'Unknown error');
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
});
