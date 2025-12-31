'use strict';

/**
 * ip-info plugin:
 * - 获取当前浏览器的 IP 地址信息
 * - 检测 IP 健康度、位置、风险分数
 * - 使用多个稳定的公共 API
 */

const https = require('https');
const http = require('http');

const meta = {
  name: 'ip-info',
  description: 'IP address information, location, and health score',
  cliOptions: []
};

// 多个 IP 检测 API（按稳定性排序）
const IP_APIS = [
  { url: 'https://api.ipify.org?format=json', parse: (d) => d.ip },
  { url: 'https://ipinfo.io/json', parse: (d) => d.ip },
  { url: 'https://api.ip.sb/ip', parse: (d) => d.trim() },
];

// IP 地理位置 API
const GEO_APIS = [
  {
    url: (ip) => `https://ipinfo.io/${ip}/json`,
    parse: (d) => ({
      ip: d.ip,
      country: d.country,
      region: d.region,
      city: d.city,
      org: d.org,
      timezone: d.timezone,
      loc: d.loc
    })
  },
  {
    url: (ip) => `https://ipapi.co/${ip}/json/`,
    parse: (d) => ({
      ip: d.ip,
      country: d.country_code,
      region: d.region,
      city: d.city,
      org: d.org,
      timezone: d.timezone,
      loc: d.latitude && d.longitude ? `${d.latitude},${d.longitude}` : null
    })
  }
];

// IP 风险检测 API
const RISK_APIS = [
  {
    url: (ip) => `https://proxycheck.io/v2/${ip}?vpn=1&asn=1&risk=1`,
    parse: (d) => {
      // proxycheck.io 返回格式: { status: "ok", "1.2.3.4": { ... } }
      const ipKey = Object.keys(d).find(k => k !== 'status' && k !== 'query time');
      const info = ipKey ? d[ipKey] : {};
      return {
        proxy: info.proxy === 'yes',
        vpn: info.vpn === 'yes',
        risk: parseInt(info.risk) || 0,
        type: info.type || 'unknown',
        asn: info.asn || null,
        provider: info.provider || null
      };
    }
  }
];

// Node.js 原生 HTTP 请求（绕过 CORS）
function nodeHttpGet(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ data: JSON.parse(data) });
        } catch {
          resolve({ data: data.trim() });
        }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
  });
}

async function fetchWithTimeout(page, url, timeoutMs = 8000) {
  try {
    const result = await page.evaluate(async (fetchUrl, timeout) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      try {
        const res = await fetch(fetchUrl, {
          signal: controller.signal,
          headers: { 'Accept': 'application/json' }
        });
        clearTimeout(timeoutId);
        
        if (!res.ok) return { error: `HTTP ${res.status}` };
        
        const text = await res.text();
        try {
          return { data: JSON.parse(text) };
        } catch {
          return { data: text };
        }
      } catch (e) {
        clearTimeout(timeoutId);
        return { error: e.message || 'fetch failed' };
      }
    }, url, timeoutMs);
    
    return result;
  } catch (e) {
    return { error: e.message || 'evaluate failed' };
  }
}

async function getIP(page) {
  for (const api of IP_APIS) {
    const result = await fetchWithTimeout(page, api.url, 5000);
    if (!result.error && result.data) {
      try {
        const ip = api.parse(result.data);
        if (ip && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          return ip;
        }
      } catch {}
    }
  }
  return null;
}

async function getGeoInfo(page, ip) {
  for (const api of GEO_APIS) {
    const result = await fetchWithTimeout(page, api.url(ip), 6000);
    if (!result.error && result.data) {
      try {
        const geo = api.parse(result.data);
        if (geo && geo.country) {
          return geo;
        }
      } catch {}
    }
  }
  return null;
}

async function getRiskInfo(page, ip) {
  // 使用 Node.js 原生请求绕过 CORS
  for (const api of RISK_APIS) {
    const result = await nodeHttpGet(api.url(ip), 8000);
    if (!result.error && result.data && typeof result.data === 'object') {
      try {
        const risk = api.parse(result.data);
        return risk;
      } catch {}
    }
  }
  return null;
}

// 计算综合健康分数 (0-100, 100 最健康)
function calculateHealthScore(geo, risk) {
  let score = 100;
  
  if (risk) {
    // VPN/Proxy 扣分
    if (risk.vpn) score -= 30;
    if (risk.proxy) score -= 25;
    
    // 风险值扣分 (0-100 的风险值)
    if (risk.risk > 0) {
      score -= Math.min(risk.risk * 0.4, 40);
    }
    
    // 数据中心 IP 扣分
    if (risk.type === 'Hosting' || risk.type === 'Data Center') {
      score -= 15;
    }
  }
  
  // 确保分数在 0-100 范围内
  return Math.max(0, Math.min(100, Math.round(score)));
}

function getHealthLevel(score) {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  if (score >= 20) return 'poor';
  return 'bad';
}

async function onLoad(kernel) {
  kernel.registerCommand(meta.name, {
    name: 'ipinfo',
    usage: 'ipinfo [--full]',
    description: 'Get IP address, location, and health score.',
    cliOptions: [
      { flags: '--full', description: 'Show full details including risk analysis' }
    ],
    handler: async (ctx) => {
      const argv = ctx.argv || [];
      const full = argv.includes('--full');
      
      const page = await kernel.page();
      
      // 获取 IP
      const ip = await getIP(page);
      if (!ip) {
        throw new Error('IPINFO: failed to detect IP address');
      }
      
      // 获取地理位置
      const geo = await getGeoInfo(page, ip);
      
      // 获取风险信息
      const risk = await getRiskInfo(page, ip);
      
      // 计算健康分数
      const healthScore = calculateHealthScore(geo, risk);
      const healthLevel = getHealthLevel(healthScore);
      
      const result = {
        ok: true,
        cmd: 'IPINFO',
        ip,
        health: {
          score: healthScore,
          level: healthLevel
        }
      };
      
      if (geo) {
        result.location = {
          country: geo.country,
          region: geo.region,
          city: geo.city,
          timezone: geo.timezone
        };
        if (geo.loc) result.location.coordinates = geo.loc;
        if (geo.org) result.org = geo.org;
      }
      
      if (full && risk) {
        result.risk = {
          vpn: risk.vpn || false,
          proxy: risk.proxy || false,
          riskScore: risk.risk || 0,
          type: risk.type || 'unknown'
        };
        if (risk.asn) result.risk.asn = risk.asn;
        if (risk.provider) result.risk.provider = risk.provider;
      }
      
      return result;
    }
  });
}

async function onUnload(kernel) {}

module.exports = {
  meta,
  onLoad,
  onUnload
};
