// M3U / M3U8 播放列表解析
// 支持 #EXTM3U 头部的 url-tvg / x-tvg-url，以及 #EXTINF 上的常见属性
import { proxied } from './net.js';

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

function parseAttrs(line) {
  const attrs = {};
  let m;
  while ((m = ATTR_RE.exec(line)) !== null) {
    attrs[m[1].toLowerCase()] = m[2];
  }
  return attrs;
}

// M3U 中频道、台标和 EPG 地址都可能写成相对路径。
// 无基准地址或 URL 不合法时保留原值，避免破坏 udp://、rtmp:// 等特殊协议。
function resolveReference(value, baseUrl) {
  const raw = String(value || '').trim();
  if (!raw || !baseUrl) return raw;
  try {
    return new URL(raw, baseUrl).href;
  } catch (e) {
    return raw;
  }
}

// 从 #EXTM3U 头解析默认 EPG 地址
function parseHeaderEpg(headerLine, baseUrl) {
  const attrs = parseAttrs(headerLine);
  const url = attrs['url-tvg'] || attrs['x-tvg-url'] || '';
  // 可能是逗号分隔的多个地址，取第一个
  return resolveReference(url.split(',')[0], baseUrl);
}

/**
 * 解析 M3U 文本
 * @param {string} text
 * @param {string} baseUrl 播放列表最终地址，用于解析相对频道/台标/EPG路径
 * @returns {{ epgUrl: string, channels: Array }}
 */
export function parseM3U(text, baseUrl = '') {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const raws = [];
  let epgUrl = '';
  let pending = null;

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) {
      epgUrl = parseHeaderEpg(line, baseUrl);
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      const attrs = parseAttrs(line);
      // 逗号之后是频道显示名
      const commaIdx = line.indexOf(',');
      const title = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';
      const tvgName = attrs['tvg-name'] || '';
      pending = {
        tvgId: attrs['tvg-id'] || '',
        title: title || tvgName || '未命名',
        tvgName,
        logo: resolveReference(attrs['tvg-logo'], baseUrl),
        group: attrs['group-title'] || '未分组',
        catchup: (attrs['catchup'] || attrs['timeshift'] ? (attrs['catchup'] || 'default') : ''),
        catchupSource: attrs['catchup-source'] || '',
        catchupDays: parseInt(attrs['catchup-days'] || attrs['timeshift'] || '0', 10) || 0,
        headers: {}
      };
      continue;
    }

    // VLC 选项（可携带 UA / referer）
    if (line.startsWith('#EXTVLCOPT') && pending) {
      const kv = line.slice(line.indexOf(':') + 1);
      const eq = kv.indexOf('=');
      if (eq > 0) {
        const k = kv.slice(0, eq).trim().toLowerCase();
        const v = kv.slice(eq + 1).trim();
        if (k === 'http-user-agent') pending.headers['User-Agent'] = v;
        if (k === 'http-referrer' || k === 'http-referer') pending.headers['Referer'] = v;
      }
      continue;
    }

    if (line.startsWith('#')) continue; // 其它注释忽略

    // 非注释行 = URL；相对路径以播放列表地址为基准。
    if (pending) {
      pending.url = resolveReference(line, baseUrl);
      raws.push(pending);
      pending = null;
    }
  }

  return { epgUrl, channels: groupByName(raws) };
}

// 把当前选中源的字段镜像到频道对象顶层，便于播放/回看/收藏等直接读取
export function applyActiveSource(ch) {
  const s = ch.sources[ch.sourceIdx] || ch.sources[0];
  if (!s) return;
  ch.url = s.url;
  ch.catchup = s.catchup;
  ch.catchupSource = s.catchupSource;
  ch.catchupDays = s.catchupDays;
  ch.headers = s.headers;
  if (s.logo) ch.logo = s.logo;
}

// 同一分组内、名称完全相同的条目视为同一个台的多个源（如 CCTV5 的多条备用源），合并为一个频道。
// 名称不同则不合并（如「深圳卫视4k」与「深圳卫视高清」是两个台，即使 tvg-id 相同）。
function groupByName(raws) {
  const map = new Map(); // 'group|title' -> channel
  const channels = [];
  for (const r of raws) {
    const source = {
      label: r.title,
      url: r.url,
      logo: r.logo,
      catchup: r.catchup,
      catchupSource: r.catchupSource,
      catchupDays: r.catchupDays,
      headers: r.headers
    };
    const gkey = r.group + '|' + r.title;
    if (map.has(gkey)) {
      map.get(gkey).sources.push(source);
      continue;
    }
    const ch = {
      tvgId: r.tvgId,
      chno: '', // 频道序号，由 renumberChannels 统一分配
      name: r.title, // 台名（用显示名，保留 4k/高清 等区分）
      epgName: r.tvgName || r.title, // EPG 匹配名（优先干净的 tvg-name）
      group: r.group,
      logo: r.logo,
      sources: [source],
      sourceIdx: 0,
      key: 'ch:' + gkey // 唯一键：分组+名称
    };
    map.set(gkey, ch);
    channels.push(ch);
  }
  channels.forEach((ch) => applyActiveSource(ch));
  renumberChannels(channels);
  return channels;
}

/**
 * 按分组聚合后的显示顺序重排频道序号，从 1 起连续递增。
 * 频道菜单和换台都按分组顺序走，所以编号也按分组聚合，菜单里从上往下就是 1、2、3……
 * 不用源里的 tvg-id：第三方源的 tvg-id 常缺失、重复或是无规律的台号。
 * tvgId 保持原值不动，EPG 匹配和回看仍依赖它。
 * @param {Array} channels
 * @returns {Array} 原数组（原地修改）
 */
export function renumberChannels(channels) {
  const groups = new Map();
  for (const ch of channels) {
    if (!groups.has(ch.group)) groups.set(ch.group, []);
    groups.get(ch.group).push(ch);
  }
  let n = 0;
  for (const arr of groups.values()) {
    for (const ch of arr) {
      ch.index = ++n;
      ch.chno = String(n);
    }
  }
  return channels;
}

/**
 * 按 group-title 分组，收藏组置顶由上层处理
 * @param {Array} channels
 * @returns {Array<{ name, channels }>}
 */
export function groupChannels(channels) {
  const map = new Map();
  for (const ch of channels) {
    if (!map.has(ch.group)) map.set(ch.group, []);
    map.get(ch.group).push(ch);
  }
  return Array.from(map.entries()).map(([name, list]) => ({ name, channels: list }));
}

// 从最终响应地址取得相对路径基准。开发代理会把真实地址放在 u 参数中，
// 不能拿 localhost/__proxy__ 当基准；生产环境则直接使用 fetch 跟随重定向后的 res.url。
function responseBaseUrl(res, requestedUrl) {
  const finalUrl = (res && res.url) || '';
  if (!finalUrl) return requestedUrl;
  try {
    const parsed = new URL(finalUrl);
    if (parsed.pathname.endsWith('/__proxy__')) {
      return parsed.searchParams.get('u') || requestedUrl;
    }
    return finalUrl;
  } catch (e) {
    return requestedUrl;
  }
}

// 拉取并解析 M3U（支持超时）
// 45s：部分公开源站每次都回源动态生成列表（带签名的播放地址），耗时常达 8~10s，
// 电视端网络/CPU 更弱，20s 会误报超时。
export async function fetchM3U(url, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // no-store：内置 m3u 文件名无 hash，更新后若走缓存会读到旧频道表
    const res = await fetch(proxied(url), { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    return parseM3U(text, responseBaseUrl(res, url));
  } finally {
    clearTimeout(timer);
  }
}
