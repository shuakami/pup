'use strict';

/**
 * core-media plugin:
 * 媒体控制插件 - 用于检测和控制页面中的音视频
 * 
 * 功能：
 * - media: 列出所有媒体元素及其真实状态
 * - media play: 强制播放
 * - media pause: 暂停
 * - media mute/unmute: 静音控制
 * - media urls: 获取视频/音频源地址
 * - media info: 详细媒体信息
 */

const meta = {
  name: 'core-media',
  description: 'Media control plugin for video/audio detection and control'
};

/**
 * 获取所有媒体元素的真实状态（通过 CDP Runtime）
 */
async function getMediaStatus(kernel) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const media = [];
          
          // 获取所有 video 元素
          document.querySelectorAll('video').forEach((v, i) => {
            media.push({
              type: 'video',
              index: i,
              src: v.src || v.currentSrc || '',
              paused: v.paused,
              muted: v.muted,
              volume: v.volume,
              currentTime: Math.round(v.currentTime * 10) / 10,
              duration: Math.round(v.duration * 10) / 10 || 0,
              readyState: v.readyState,
              networkState: v.networkState,
              buffered: v.buffered.length > 0 ? Math.round(v.buffered.end(v.buffered.length - 1) * 10) / 10 : 0,
              width: v.videoWidth,
              height: v.videoHeight,
              playbackRate: v.playbackRate,
              loop: v.loop,
              autoplay: v.autoplay,
              controls: v.controls,
              poster: v.poster || '',
              // 检测是否真的在播放（不是暂停且有时间流动）
              playing: !v.paused && !v.ended && v.readyState > 2
            });
          });
          
          // 获取所有 audio 元素
          document.querySelectorAll('audio').forEach((a, i) => {
            media.push({
              type: 'audio',
              index: i,
              src: a.src || a.currentSrc || '',
              paused: a.paused,
              muted: a.muted,
              volume: a.volume,
              currentTime: Math.round(a.currentTime * 10) / 10,
              duration: Math.round(a.duration * 10) / 10 || 0,
              readyState: a.readyState,
              networkState: a.networkState,
              playbackRate: a.playbackRate,
              loop: a.loop,
              playing: !a.paused && !a.ended && a.readyState > 2
            });
          });
          
          return media;
        })()
      `,
      returnByValue: true
    }, { timeoutMs: 5000, label: 'getMediaStatus' });
    
    return result.result?.value || [];
  } catch (e) {
    return [];
  }
}

/**
 * 获取媒体源 URL（包括 blob URL 解析）
 */
async function getMediaUrls(kernel) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const urls = [];
          
          // Video sources
          document.querySelectorAll('video').forEach((v, i) => {
            const sources = [];
            
            // 主 src
            if (v.src) sources.push({ type: 'src', url: v.src });
            if (v.currentSrc && v.currentSrc !== v.src) sources.push({ type: 'currentSrc', url: v.currentSrc });
            
            // source 子元素
            v.querySelectorAll('source').forEach(s => {
              if (s.src) sources.push({ type: 'source', url: s.src, mime: s.type || '' });
            });
            
            urls.push({ type: 'video', index: i, sources });
          });
          
          // Audio sources
          document.querySelectorAll('audio').forEach((a, i) => {
            const sources = [];
            if (a.src) sources.push({ type: 'src', url: a.src });
            if (a.currentSrc && a.currentSrc !== a.src) sources.push({ type: 'currentSrc', url: a.currentSrc });
            a.querySelectorAll('source').forEach(s => {
              if (s.src) sources.push({ type: 'source', url: s.src, mime: s.type || '' });
            });
            urls.push({ type: 'audio', index: i, sources });
          });
          
          return urls;
        })()
      `,
      returnByValue: true
    }, { timeoutMs: 5000, label: 'getMediaUrls' });
    
    return result.result?.value || [];
  } catch (e) {
    return [];
  }
}

/**
 * 控制媒体播放
 */
async function controlMedia(kernel, action, opts = {}) {
  const { index = 0, type = 'video', volume, time, rate } = opts;
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  const selector = type === 'audio' ? `document.querySelectorAll('audio')[${index}]` : `document.querySelectorAll('video')[${index}]`;
  
  let code = '';
  
  switch (action) {
    case 'play':
      code = `
        (async () => {
          const m = ${selector};
          if (!m) return { ok: false, error: 'Media element not found' };
          m.muted = false;
          try {
            await m.play();
            return { ok: true, action: 'play', paused: m.paused, muted: m.muted, currentTime: m.currentTime, playing: !m.paused && !m.ended && m.readyState > 2 };
          } catch (e) {
            // 自动播放策略可能阻止，尝试静音播放
            m.muted = true;
            await m.play();
            return { ok: true, action: 'play', paused: m.paused, muted: m.muted, currentTime: m.currentTime, playing: !m.paused && !m.ended && m.readyState > 2, warning: 'Muted due to autoplay policy' };
          }
        })()
      `;
      break;
      
    case 'forceplay':
      // 强制播放：移除所有可能阻止播放的因素
      code = `
        (async () => {
          const m = ${selector};
          if (!m) return { ok: false, error: 'Media element not found' };
          
          // 移除可能的遮罩层
          document.querySelectorAll('[class*="mask"], [class*="login"], [class*="modal"], [class*="dialog"], [class*="popup"]').forEach(el => {
            if (el.style) el.style.display = 'none';
          });
          
          // 确保元素可见
          m.style.visibility = 'visible';
          m.style.opacity = '1';
          
          // 设置属性
          m.muted = false;
          m.volume = 1;
          m.autoplay = true;
          
          // 尝试播放
          try {
            await m.play();
          } catch (e) {
            // 如果失败，模拟用户交互后再试
            m.click();
            await new Promise(r => setTimeout(r, 100));
            try {
              await m.play();
            } catch {}
          }
          
          return { 
            ok: !m.paused, 
            action: 'forceplay', 
            paused: m.paused, 
            muted: m.muted,
            currentTime: m.currentTime,
            playing: !m.paused && !m.ended && m.readyState > 2
          };
        })()
      `;
      break;
      
    case 'pause':
      code = `
        (() => {
          const m = ${selector};
          if (!m) return { ok: false, error: 'Media element not found' };
          m.pause();
          return { ok: true, action: 'pause', paused: m.paused, currentTime: m.currentTime, playing: false };
        })()
      `;
      break;
      
    case 'mute':
      code = `
        (() => {
          const m = ${selector};
          if (!m) return { ok: false, error: 'Media element not found' };
          m.muted = true;
          return { ok: true, action: 'mute', muted: m.muted, paused: m.paused, playing: !m.paused && !m.ended && m.readyState > 2 };
        })()
      `;
      break;
      
    case 'unmute':
      code = `
        (() => {
          const m = ${selector};
          if (!m) return { ok: false, error: 'Media element not found' };
          m.muted = false;
          return { ok: true, action: 'unmute', muted: m.muted, paused: m.paused, playing: !m.paused && !m.ended && m.readyState > 2 };
        })()
      `;
      break;
      
    case 'volume':
      if (volume === undefined) return { ok: false, error: 'Volume value required (0-1)' };
      code = `
        (() => {
          const m = ${selector};
          if (!m) return { ok: false, error: 'Media element not found' };
          m.volume = ${Math.max(0, Math.min(1, volume))};
          if (m.volume > 0) m.muted = false;
          return { ok: true, action: 'volume', volume: m.volume, muted: m.muted, paused: m.paused, playing: !m.paused && !m.ended && m.readyState > 2 };
        })()
      `;
      break;
      
    case 'seek':
      if (time === undefined) return { ok: false, error: 'Time value required (seconds)' };
      code = `
        (() => {
          const m = ${selector};
          if (!m) return { ok: false, error: 'Media element not found' };
          m.currentTime = ${time};
          return { ok: true, action: 'seek', currentTime: m.currentTime, duration: m.duration, paused: m.paused, playing: !m.paused && !m.ended && m.readyState > 2 };
        })()
      `;
      break;
      
    case 'rate':
      if (rate === undefined) return { ok: false, error: 'Rate value required (e.g., 1.5)' };
      code = `
        (() => {
          const m = ${selector};
          if (!m) return { ok: false, error: 'Media element not found' };
          m.playbackRate = ${rate};
          return { ok: true, action: 'rate', playbackRate: m.playbackRate, paused: m.paused, playing: !m.paused && !m.ended && m.readyState > 2 };
        })()
      `;
      break;
      
    case 'fullscreen':
      code = `
        (async () => {
          const m = ${selector};
          if (!m) return { ok: false, error: 'Media element not found' };
          try {
            await m.requestFullscreen();
            return { ok: true, action: 'fullscreen', paused: m.paused, playing: !m.paused && !m.ended && m.readyState > 2 };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        })()
      `;
      break;
      
    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: code,
      awaitPromise: true,
      returnByValue: true
    }, { timeoutMs: 10000, label: `media:${action}` });
    
    const res = result.result?.value || { ok: false, error: 'No result' };
    
    // 如果操作成功但视频是暂停状态，添加警告
    if (res.ok && res.paused === true && action !== 'pause') {
      res.warning = res.warning || 'Video is paused - action may not have visible effect';
    }
    
    return res;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 获取详细媒体信息（包括网络请求中的媒体）
 */
async function getMediaInfo(kernel, opts = {}) {
  const { index = 0, type = 'video' } = opts;
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    const selector = type === 'audio' ? `document.querySelectorAll('audio')[${index}]` : `document.querySelectorAll('video')[${index}]`;
    
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const m = ${selector};
          if (!m) return null;
          
          // 获取所有可能的源
          const sources = [];
          if (m.src) sources.push(m.src);
          if (m.currentSrc) sources.push(m.currentSrc);
          m.querySelectorAll('source').forEach(s => s.src && sources.push(s.src));
          
          // 获取 buffered ranges
          const buffered = [];
          for (let i = 0; i < m.buffered.length; i++) {
            buffered.push({ start: m.buffered.start(i), end: m.buffered.end(i) });
          }
          
          // 获取 played ranges
          const played = [];
          for (let i = 0; i < m.played.length; i++) {
            played.push({ start: m.played.start(i), end: m.played.end(i) });
          }
          
          return {
            type: '${type}',
            index: ${index},
            
            // 播放状态
            paused: m.paused,
            ended: m.ended,
            seeking: m.seeking,
            playing: !m.paused && !m.ended && m.readyState > 2,
            
            // 音量
            muted: m.muted,
            volume: m.volume,
            
            // 时间
            currentTime: m.currentTime,
            duration: m.duration || 0,
            playbackRate: m.playbackRate,
            defaultPlaybackRate: m.defaultPlaybackRate,
            
            // 网络状态
            readyState: m.readyState,
            readyStateText: ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'][m.readyState],
            networkState: m.networkState,
            networkStateText: ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'][m.networkState],
            
            // 源
            src: m.src,
            currentSrc: m.currentSrc,
            sources: [...new Set(sources)],
            
            // 视频特有
            videoWidth: m.videoWidth || 0,
            videoHeight: m.videoHeight || 0,
            poster: m.poster || '',
            
            // 缓冲
            buffered,
            played,
            
            // 属性
            autoplay: m.autoplay,
            loop: m.loop,
            controls: m.controls,
            crossOrigin: m.crossOrigin,
            preload: m.preload,
            
            // 错误
            error: m.error ? { code: m.error.code, message: m.error.message } : null
          };
        })()
      `,
      returnByValue: true
    }, { timeoutMs: 5000, label: 'getMediaInfo' });
    
    const info = result.result?.value;
    if (!info) return { ok: false, error: 'Media element not found' };
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 从网络请求中提取媒体 URL
 */
async function getNetworkMediaUrls(kernel) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const entries = performance.getEntriesByType('resource');
          const mediaUrls = [];
          
          const videoExts = ['.mp4', '.webm', '.m3u8', '.mpd', '.ts', '.m4s', '.flv'];
          const audioExts = ['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac'];
          
          entries.forEach(e => {
            const url = e.name.toLowerCase();
            const isVideo = videoExts.some(ext => url.includes(ext)) || url.includes('video');
            const isAudio = audioExts.some(ext => url.includes(ext)) || (url.includes('audio') && !isVideo);
            
            if (isVideo || isAudio) {
              mediaUrls.push({
                type: isVideo ? 'video' : 'audio',
                url: e.name,
                size: e.transferSize || 0,
                duration: Math.round(e.duration) || 0,
                initiator: e.initiatorType
              });
            }
          });
          
          return mediaUrls;
        })()
      `,
      returnByValue: true
    }, { timeoutMs: 5000, label: 'getNetworkMediaUrls' });
    
    return result.result?.value || [];
  } catch (e) {
    return [];
  }
}

// ==================== Command Registration ====================

async function onLoad(kernel) {
  kernel.provide(meta.name, 'media', {
    getStatus: () => getMediaStatus(kernel),
    getUrls: () => getMediaUrls(kernel),
    getInfo: (opts) => getMediaInfo(kernel, opts),
    getNetworkUrls: () => getNetworkMediaUrls(kernel),
    control: (action, opts) => controlMedia(kernel, action, opts)
  });

  kernel.registerCommand(meta.name, {
    name: 'media',
    usage: 'media [play|pause|mute|unmute|urls|info|network] [--index N] [--type video|audio] [--volume V] [--seek T] [--rate R]',
    description: 'Control and inspect media elements (video/audio).',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const action = argv[0] || 'status';
      
      // 解析选项
      const indexIdx = argv.indexOf('--index');
      const typeIdx = argv.indexOf('--type');
      const volumeIdx = argv.indexOf('--volume');
      const seekIdx = argv.indexOf('--seek');
      const rateIdx = argv.indexOf('--rate');
      
      const index = indexIdx !== -1 ? Number(argv[indexIdx + 1]) || 0 : 0;
      const type = typeIdx !== -1 ? argv[typeIdx + 1] : 'video';
      const volume = volumeIdx !== -1 ? Number(argv[volumeIdx + 1]) : undefined;
      const time = seekIdx !== -1 ? Number(argv[seekIdx + 1]) : undefined;
      const rate = rateIdx !== -1 ? Number(argv[rateIdx + 1]) : undefined;
      
      switch (action) {
        case 'status':
        case 'list': {
          const media = await getMediaStatus(kernel);
          return { ok: true, cmd: 'MEDIA', action: 'status', media, count: media.length };
        }
        
        case 'urls': {
          const urls = await getMediaUrls(kernel);
          return { ok: true, cmd: 'MEDIA', action: 'urls', urls };
        }
        
        case 'network': {
          const urls = await getNetworkMediaUrls(kernel);
          return { ok: true, cmd: 'MEDIA', action: 'network', urls, count: urls.length };
        }
        
        case 'info': {
          const info = await getMediaInfo(kernel, { index, type });
          return { ...info, cmd: 'MEDIA', action: 'info' };
        }
        
        case 'play':
        case 'forceplay':
        case 'pause':
        case 'mute':
        case 'unmute':
        case 'fullscreen': {
          const result = await controlMedia(kernel, action, { index, type });
          return { ...result, cmd: 'MEDIA' };
        }
        
        case 'volume': {
          if (volume === undefined) {
            return { ok: false, cmd: 'MEDIA', error: 'Usage: media volume --volume 0.5' };
          }
          const result = await controlMedia(kernel, 'volume', { index, type, volume });
          return { ...result, cmd: 'MEDIA' };
        }
        
        case 'seek': {
          if (time === undefined) {
            return { ok: false, cmd: 'MEDIA', error: 'Usage: media seek --seek 60' };
          }
          const result = await controlMedia(kernel, 'seek', { index, type, time });
          return { ...result, cmd: 'MEDIA' };
        }
        
        case 'rate': {
          if (rate === undefined) {
            return { ok: false, cmd: 'MEDIA', error: 'Usage: media rate --rate 1.5' };
          }
          const result = await controlMedia(kernel, 'rate', { index, type, rate });
          return { ...result, cmd: 'MEDIA' };
        }
        
        default:
          return { ok: false, cmd: 'MEDIA', error: `Unknown action: ${action}. Use: status, play, forceplay, pause, mute, unmute, volume, seek, rate, urls, network, info` };
      }
    }
  });
}

async function onUnload(kernel) {}

module.exports = { meta, onLoad, onUnload };
