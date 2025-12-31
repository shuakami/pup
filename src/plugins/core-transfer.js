'use strict';

/**
 * core-transfer plugin:
 * 文件传输插件 - 上传和下载管理
 * 
 * 功能：
 * - upload: 上传文件到 input[type=file]
 * - download: 下载管理（设置路径、监控下载）
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const meta = {
  name: 'core-transfer',
  description: 'File upload and download management plugin'
};

/**
 * 上传文件到指定的 file input
 * 使用 CDP DOM.setFileInputFiles
 */
async function uploadFile(kernel, filePath, opts = {}) {
  const { selector = 'input[type="file"]', index = 0 } = opts;
  
  // 检查文件是否存在
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    return { ok: false, error: `File not found: ${absPath}` };
  }
  
  const cdp = await kernel.cdp();
  await cdp.enable('DOM');
  await cdp.enable('Runtime');
  
  try {
    // 获取 document
    const { root } = await cdp.send('DOM.getDocument', {}, { timeoutMs: 5000, label: 'getDocument' });
    
    // 查找 file input 元素
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: selector
    }, { timeoutMs: 5000, label: 'querySelectorAll' });
    
    if (!nodeIds || nodeIds.length === 0) {
      return { ok: false, error: `No file input found with selector: ${selector}` };
    }
    
    if (index >= nodeIds.length) {
      return { ok: false, error: `Index ${index} out of range. Found ${nodeIds.length} file inputs.` };
    }
    
    const targetNodeId = nodeIds[index];
    
    // 设置文件
    await cdp.send('DOM.setFileInputFiles', {
      nodeId: targetNodeId,
      files: [absPath]
    }, { timeoutMs: 10000, label: 'setFileInputFiles' });
    
    // 触发 change 和 input 事件，让网站 JS 知道文件已选择
    const resolved = await cdp.send('DOM.resolveNode', {
      nodeId: targetNodeId
    }, { timeoutMs: 3000, label: 'resolveNode' });
    
    if (resolved && resolved.object && resolved.object.objectId) {
      await cdp.send('Runtime.callFunctionOn', {
        objectId: resolved.object.objectId,
        functionDeclaration: `function() {
          const el = this;
          // 触发各种事件确保网站 JS 能检测到
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          // 有些网站监听 drop 事件
          try {
            const dt = new DataTransfer();
            if (el.files && el.files.length > 0) {
              for (const f of el.files) dt.items.add(f);
            }
            el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
          } catch {}
          return { triggered: true, files: el.files ? el.files.length : 0 };
        }`,
        returnByValue: true
      }, { timeoutMs: 3000, label: 'triggerEvents' });
    }
    
    const stats = fs.statSync(absPath);
    
    return {
      ok: true,
      action: 'upload',
      file: absPath,
      fileName: path.basename(absPath),
      size: stats.size,
      selector,
      index
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 上传多个文件
 */
async function uploadFiles(kernel, filePaths, opts = {}) {
  const { selector = 'input[type="file"]', index = 0 } = opts;
  
  // 检查所有文件是否存在
  const absPaths = [];
  for (const fp of filePaths) {
    const absPath = path.resolve(fp);
    if (!fs.existsSync(absPath)) {
      return { ok: false, error: `File not found: ${absPath}` };
    }
    absPaths.push(absPath);
  }
  
  const cdp = await kernel.cdp();
  await cdp.enable('DOM');
  
  try {
    const { root } = await cdp.send('DOM.getDocument', {}, { timeoutMs: 5000, label: 'getDocument' });
    
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: selector
    }, { timeoutMs: 5000, label: 'querySelectorAll' });
    
    if (!nodeIds || nodeIds.length === 0) {
      return { ok: false, error: `No file input found with selector: ${selector}` };
    }
    
    if (index >= nodeIds.length) {
      return { ok: false, error: `Index ${index} out of range. Found ${nodeIds.length} file inputs.` };
    }
    
    const targetNodeId = nodeIds[index];
    
    await cdp.send('DOM.setFileInputFiles', {
      nodeId: targetNodeId,
      files: absPaths
    }, { timeoutMs: 10000, label: 'setFileInputFiles' });
    
    const files = absPaths.map(p => ({
      path: p,
      name: path.basename(p),
      size: fs.statSync(p).size
    }));
    
    return {
      ok: true,
      action: 'upload-multiple',
      files,
      count: files.length,
      selector,
      index
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 直接下载文件（使用 Node.js http/https）
 */
function downloadFileDirectly(url, destPath, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const absPath = path.resolve(destPath);
    const dir = path.dirname(absPath);
    
    // 确保目录存在
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const file = fs.createWriteStream(absPath);
    const protocol = url.startsWith('https') ? https : http;
    
    const timeoutId = setTimeout(() => {
      file.close();
      fs.unlinkSync(absPath);
      reject(new Error('Download timeout'));
    }, timeout);
    
    const request = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (response) => {
      // 处理重定向
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        clearTimeout(timeoutId);
        file.close();
        fs.unlinkSync(absPath);
        downloadFileDirectly(response.headers.location, destPath, timeout)
          .then(resolve)
          .catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        clearTimeout(timeoutId);
        file.close();
        fs.unlinkSync(absPath);
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      
      const totalSize = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedSize = 0;
      
      response.pipe(file);
      
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
      });
      
      file.on('finish', () => {
        clearTimeout(timeoutId);
        file.close();
        resolve({
          ok: true,
          path: absPath,
          size: downloadedSize,
          totalSize
        });
      });
    });
    
    request.on('error', (err) => {
      clearTimeout(timeoutId);
      file.close();
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      reject(err);
    });
    
    file.on('error', (err) => {
      clearTimeout(timeoutId);
      file.close();
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      reject(err);
    });
  });
}

/**
 * 下载文件
 */
async function downloadFile(kernel, url, opts = {}) {
  const { filename, dir = './downloads', timeout = 30000 } = opts;
  
  // 从 URL 提取文件名
  let finalFilename = filename;
  if (!finalFilename) {
    try {
      const urlObj = new URL(url);
      finalFilename = path.basename(urlObj.pathname) || 'download';
      // 如果没有扩展名，尝试从 URL 推断
      if (!path.extname(finalFilename)) {
        finalFilename += '.bin';
      }
    } catch {
      finalFilename = 'download.bin';
    }
  }
  
  const destPath = path.join(dir, finalFilename);
  
  try {
    const result = await downloadFileDirectly(url, destPath, timeout);
    return {
      ok: true,
      action: 'download',
      url,
      path: result.path,
      filename: finalFilename,
      size: result.size
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 列出页面上的所有下载链接
 */
async function listDownloadLinks(kernel) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const links = [];
          
          // 带 download 属性的链接
          document.querySelectorAll('a[download]').forEach((a, i) => {
            links.push({
              type: 'download-attr',
              index: i,
              href: a.href,
              download: a.download || true,
              text: (a.textContent || '').trim().substring(0, 50)
            });
          });
          
          // 文件类型链接
          const fileExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', 
                           '.zip', '.rar', '.7z', '.tar', '.gz',
                           '.mp3', '.mp4', '.avi', '.mkv', '.mov',
                           '.jpg', '.jpeg', '.png', '.gif', '.svg',
                           '.exe', '.msi', '.dmg', '.apk'];
          
          document.querySelectorAll('a[href]').forEach((a, i) => {
            const href = a.href.toLowerCase();
            const ext = fileExts.find(e => href.includes(e));
            if (ext && !a.hasAttribute('download')) {
              links.push({
                type: 'file-link',
                index: i,
                href: a.href,
                ext,
                text: (a.textContent || '').trim().substring(0, 50)
              });
            }
          });
          
          return links;
        })()
      `,
      returnByValue: true
    }, { timeoutMs: 5000, label: 'listDownloadLinks' });
    
    const links = result.result?.value || [];
    return {
      ok: true,
      action: 'list-links',
      links,
      count: links.length
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 列出页面上的所有 file input
 */
async function listFileInputs(kernel) {
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const inputs = [];
          document.querySelectorAll('input[type="file"]').forEach((input, i) => {
            inputs.push({
              index: i,
              name: input.name || '',
              id: input.id || '',
              accept: input.accept || '*',
              multiple: input.multiple,
              required: input.required,
              disabled: input.disabled,
              files: input.files ? input.files.length : 0
            });
          });
          return inputs;
        })()
      `,
      returnByValue: true
    }, { timeoutMs: 5000, label: 'listFileInputs' });
    
    const inputs = result.result?.value || [];
    return {
      ok: true,
      action: 'list-inputs',
      inputs,
      count: inputs.length
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 设置浏览器下载行为并等待下载完成
 * 用于点击触发的下载
 */
async function setupBrowserDownload(kernel, downloadDir, timeout = 60000) {
  const absDir = path.resolve(downloadDir);
  
  // 确保目录存在
  if (!fs.existsSync(absDir)) {
    fs.mkdirSync(absDir, { recursive: true });
  }
  
  const cdp = await kernel.cdp();
  
  // 设置下载行为
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: absDir,
    eventsEnabled: true
  }, { timeoutMs: 5000, label: 'setDownloadBehavior' });
  
  return {
    downloadDir: absDir,
    // 返回一个等待下载完成的函数
    waitForDownload: () => new Promise((resolve, reject) => {
      let downloadGuid = null;
      let suggestedFilename = null;
      let downloadState = 'pending';
      
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Download timeout'));
      }, timeout);
      
      const cleanup = () => {
        clearTimeout(timeoutId);
        cdp.off('Browser.downloadWillBegin', onDownloadBegin);
        cdp.off('Browser.downloadProgress', onDownloadProgress);
      };
      
      const onDownloadBegin = (params) => {
        downloadGuid = params.guid;
        suggestedFilename = params.suggestedFilename;
        downloadState = 'started';
      };
      
      const onDownloadProgress = (params) => {
        if (params.guid !== downloadGuid) return;
        
        if (params.state === 'completed') {
          downloadState = 'completed';
          cleanup();
          
          // 查找下载的文件
          const downloadedFile = path.join(absDir, suggestedFilename || 'download');
          resolve({
            ok: true,
            action: 'browser-download',
            path: downloadedFile,
            filename: suggestedFilename,
            size: params.receivedBytes || 0,
            totalSize: params.totalBytes || 0
          });
        } else if (params.state === 'canceled') {
          downloadState = 'canceled';
          cleanup();
          reject(new Error('Download canceled'));
        }
      };
      
      cdp.on('Browser.downloadWillBegin', onDownloadBegin);
      cdp.on('Browser.downloadProgress', onDownloadProgress);
    })
  };
}

/**
 * 点击下载链接并等待下载完成
 */
async function clickAndDownload(kernel, linkIndex, opts = {}) {
  const { dir = './downloads', timeout = 60000 } = opts;
  
  // 先获取下载链接列表
  const linksResult = await listDownloadLinks(kernel);
  if (!linksResult.ok) return linksResult;
  
  const links = linksResult.links || [];
  if (linkIndex >= links.length) {
    return { ok: false, error: `Link index ${linkIndex} out of range. Found ${links.length} links.` };
  }
  
  const link = links[linkIndex];
  
  // 如果是直接的文件链接，使用 HTTP 下载
  if (link.href && !link.href.startsWith('javascript:') && !link.href.startsWith('blob:')) {
    // 尝试直接下载
    try {
      const result = await downloadFile(kernel, link.href, { dir, timeout });
      if (result.ok) {
        return { ...result, linkIndex, linkText: link.text };
      }
    } catch {
      // 直接下载失败，尝试点击下载
    }
  }
  
  // 设置浏览器下载行为
  const downloadSetup = await setupBrowserDownload(kernel, dir, timeout);
  
  // 点击链接
  const cdp = await kernel.cdp();
  await cdp.enable('Runtime');
  
  try {
    // 点击下载链接
    await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const links = [];
          document.querySelectorAll('a[download]').forEach(a => links.push(a));
          document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href.toLowerCase();
            if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.zip', '.rar', '.7z', '.tar', '.gz', '.mp3', '.mp4', '.exe', '.msi', '.dmg', '.apk'].some(ext => href.includes(ext))) {
              if (!links.includes(a)) links.push(a);
            }
          });
          const target = links[${linkIndex}];
          if (target) {
            target.click();
            return { clicked: true };
          }
          return { clicked: false };
        })()
      `,
      returnByValue: true
    }, { timeoutMs: 5000, label: 'clickDownloadLink' });
    
    // 等待下载完成
    const result = await downloadSetup.waitForDownload();
    return { ...result, linkIndex, linkText: link.text };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ==================== Command Registration ====================

async function onLoad(kernel) {
  kernel.provide(meta.name, 'transfer', {
    upload: (filePath, opts) => uploadFile(kernel, filePath, opts),
    uploadMultiple: (filePaths, opts) => uploadFiles(kernel, filePaths, opts),
    download: (url, opts) => downloadFile(kernel, url, opts),
    listDownloadLinks: () => listDownloadLinks(kernel),
    listFileInputs: () => listFileInputs(kernel)
  });

  // upload 命令
  kernel.registerCommand(meta.name, {
    name: 'upload',
    usage: 'upload <file-path> [--selector "css"] [--index N]',
    description: 'Upload file to file input element.',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      
      // 解析参数
      const selectorIdx = argv.indexOf('--selector');
      const indexIdx = argv.indexOf('--index');
      
      const selector = selectorIdx !== -1 ? argv[selectorIdx + 1] : 'input[type="file"]';
      const index = indexIdx !== -1 ? Number(argv[indexIdx + 1]) || 0 : 0;
      
      // 文件路径是第一个非选项参数
      const filePath = argv.find((a, i) => {
        if (a.startsWith('--')) return false;
        if (i > 0 && argv[i-1] === '--selector') return false;
        if (i > 0 && argv[i-1] === '--index') return false;
        return true;
      });
      
      if (!filePath) {
        return { ok: false, cmd: 'UPLOAD', error: 'Usage: upload <file-path> [--selector "css"] [--index N]' };
      }
      
      const result = await uploadFile(kernel, filePath, { selector, index });
      return { ...result, cmd: 'UPLOAD' };
    }
  });

  // download 命令
  kernel.registerCommand(meta.name, {
    name: 'download',
    usage: 'download <url|action> [options]',
    description: 'Download file: download <url>, download links, download inputs, download click <index>',
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const first = argv[0] || '';
      
      // 如果是 URL，直接下载
      if (first.startsWith('http://') || first.startsWith('https://')) {
        const url = first;
        const filenameIdx = argv.indexOf('--filename');
        const dirIdx = argv.indexOf('--dir');
        const filename = filenameIdx !== -1 ? argv[filenameIdx + 1] : undefined;
        const dir = dirIdx !== -1 ? argv[dirIdx + 1] : './downloads';
        
        const result = await downloadFile(kernel, url, { filename, dir });
        return { ...result, cmd: 'DOWNLOAD' };
      }
      
      // 否则是子命令
      switch (first) {
        case 'links': {
          const result = await listDownloadLinks(kernel);
          return { ...result, cmd: 'DOWNLOAD' };
        }
        
        case 'inputs': {
          const result = await listFileInputs(kernel);
          return { ...result, cmd: 'DOWNLOAD' };
        }
        
        case 'click': {
          // 点击下载链接
          const linkIndex = Number(argv[1]);
          if (!Number.isFinite(linkIndex) || linkIndex < 0) {
            return { ok: false, cmd: 'DOWNLOAD', error: 'Usage: download click <link-index> [--dir path]' };
          }
          const dirIdx = argv.indexOf('--dir');
          const dir = dirIdx !== -1 ? argv[dirIdx + 1] : './downloads';
          
          const result = await clickAndDownload(kernel, linkIndex, { dir });
          return { ...result, cmd: 'DOWNLOAD' };
        }
        
        default:
          return { ok: false, cmd: 'DOWNLOAD', error: 'Usage: download <url> [--filename name] [--dir path] | download links | download inputs | download click <index>' };
      }
    }
  });
}

async function onUnload(kernel) {}

module.exports = { meta, onLoad, onUnload };
