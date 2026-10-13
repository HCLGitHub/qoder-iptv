// 时移/回看（catchup）地址生成
// 参考 Kodi PVR IPTV Simple / Tivimate 的 catchup-source 规范
// 支持类型：default / append / shift / timeshift / flussonic / xc(xtream)
import { proxied } from './net.js';

// 两位补零
function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

// 用 start（秒）构造时间分量（UTC）
function timeParts(sec) {
  const d = new Date(sec * 1000);
  return {
    Y: d.getUTCFullYear(),
    m: pad(d.getUTCMonth() + 1),
    d: pad(d.getUTCDate()),
    H: pad(d.getUTCHours()),
    M: pad(d.getUTCMinutes()),
    S: pad(d.getUTCSeconds())
  };
}

// 按格式（如 YmdHMS）把某个 epoch 秒渲染成日期串，使用本地时区（国内 IPTV playseek 惯用本地/东八区时间）
function fmtByPattern(sec, pattern) {
  const d = new Date(sec * 1000);
  const map = {
    Y: d.getFullYear(),
    m: pad(d.getMonth() + 1),
    d: pad(d.getDate()),
    H: pad(d.getHours()),
    M: pad(d.getMinutes()),
    S: pad(d.getSeconds())
  };
  return pattern.replace(/[YmdHMS]/g, (c) => String(map[c]));
}

// 替换模板中的占位符，兼容 {token} 与 ${token}，并支持 {token:YmdHMS} 时间格式
function replaceTokens(template, ctx) {
  const secOf = (key) => {
    const k = key.toLowerCase();
    if (k === 'utc' || k === 'start' || k === 'timestamp') return ctx.start;
    if (k === 'utcend' || k === 'end') return ctx.end;
    if (k === 'lutc' || k === 'now') return ctx.now;
    return null;
  };

  let out = template;

  // {token} / ${token} / {token:FORMAT}
  out = out.replace(
    /\$?\{(utc|start|timestamp|utcend|end|lutc|now|offset|duration|catchup-id)(?::([^}]+))?\}/gi,
    (full, key, fmt) => {
      const k = key.toLowerCase();
      if (k === 'offset') return String(ctx.offset);
      if (k === 'duration') return String(ctx.duration);
      if (k === 'catchup-id') return String(ctx.catchupId || '');
      const sec = secOf(k);
      if (sec == null) return full;
      return fmt ? fmtByPattern(sec, fmt) : String(sec);
    }
  );

  // 时间分量 {Y}{m}{d}{H}{M}{S}（基于 start，向后兼容）
  const tp = timeParts(ctx.start);
  out = out.replace(/\{(Y|m|d|H|M|S)\}/g, (full, key) => (key in tp ? String(tp[key]) : full));

  // 清理剩余未识别的 ${...}
  out = out.replace(/\$\{[^}]*\}/g, '');

  return out;
}

// 拼接 URL 参数（正确处理 ? 与 &）
function appendToUrl(url, query) {
  if (!query) return url;
  const q = query.replace(/^[?&]/, '');
  return url + (url.includes('?') ? '&' : '?') + q;
}

/**
 * 判断某节目是否落在时移窗口内（可回看）
 * @param {object} channel 含 catchup / catchupDays
 * @param {object} programme 含 start(ms)
 * @param {number} defaultDays 默认时移天数
 */
export function isCatchupAvailable(channel, programme, defaultDays = 7) {
  if (!channel || !channel.catchup) return false;
  if (!programme || isNaN(programme.start)) return false;
  const now = Date.now();
  if (programme.start >= now) return false; // 未来节目不可回看
  const days = channel.catchupDays > 0 ? channel.catchupDays : defaultDays;
  const windowStart = now - days * 24 * 3600 * 1000;
  return programme.start >= windowStart;
}

/**
 * 生成回看地址
 * @param {object} channel { url, catchup, catchupSource, tvgId }
 * @param {object} programme { start(ms), stop(ms) }
 * @returns {string|null}
 */
export function buildCatchupUrl(channel, programme) {
  if (!channel || !programme) return null;
  const startSec = Math.floor(programme.start / 1000);
  const stopMs = isNaN(programme.stop) ? programme.start + 3600000 : programme.stop;
  const endSec = Math.floor(stopMs / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  const ctx = {
    start: startSec,
    end: endSec,
    now: nowSec,
    duration: Math.max(0, endSec - startSec),
    offset: Math.max(0, nowSec - startSec),
    catchupId: channel.tvgId || ''
  };

  const type = (channel.catchup || 'default').toLowerCase();
  const source = channel.catchupSource || '';

  // 1) 有明确 catchup-source 模板：直接按模板生成
  if (source) {
    // append 型：模板是要追加到直播 URL 后的参数串（安全处理 ? 与 &）
    if (type === 'append') {
      return appendToUrl(channel.url, replaceTokens(source, ctx));
    }
    // 其它：模板本身是完整 URL（或相对参数）
    const resolved = replaceTokens(source, ctx);
    if (/^https?:\/\//i.test(resolved)) return resolved;
    // 相对：拼到直播 URL
    return channel.url + resolved;
  }

  // 2) 无模板，按类型走默认规则
  switch (type) {
    case 'append':
    case 'default':
    case 'shift':
    case 'timeshift':
      return appendToUrl(channel.url, `utc=${ctx.start}&lutc=${ctx.now}`);

    case 'flussonic': {
      // 常见 Flussonic：.../index.m3u8 -> .../index-{start}-{duration}.m3u8
      const url = channel.url;
      if (/\.m3u8(\?|$)/i.test(url)) {
        return url.replace(/\/[^/]*\.m3u8/i, `/index-${ctx.start}-${ctx.duration}.m3u8`);
      }
      // mpegts：追加参数
      return appendToUrl(url, `archive=${ctx.start}&duration=${ctx.duration}`);
    }

    case 'xc':
    case 'xtream': {
      // Xtream Codes：/streaming/timeshift.php?...；此处无凭据信息，退化为参数追加
      return appendToUrl(channel.url, `utc=${ctx.start}&lutc=${ctx.now}`);
    }

    default:
      return appendToUrl(channel.url, `utc=${ctx.start}&lutc=${ctx.now}`);
  }
}

// ---- 回看能力自动探测 ----
// 在线源（用户手填的 m3u）基本都不写 catchup 属性，源管理里也没这个字段，
// 于是 isCatchupAvailable() 第一道 `!channel.catchup` 就把回看按钮全挡掉了。
// 这里做的事：拿一段「肯定已经过去」的时间去试各种运营商时移写法，真能取到
// 历史分片才认，认下来的模板反向补进频道对象，回看按钮随之出现。

// 候选模板，按国内 IPTV 的常见程度排序，命中即止
export const CATCHUP_PRESETS = [
  // 电信/联通 IPTV 最常见（内置「广东联通」源用的就是这个）
  { catchup: 'append', catchupSource: '?playseek={utc:YmdHMS}-{utcend:YmdHMS}' },
  // 同上但用秒级 epoch
  { catchup: 'append', catchupSource: '?playseek={utc}-{utcend}' },
  // Kodi PVR IPTV Simple / Tivimate 默认
  { catchup: 'append', catchupSource: '?utc={utc}&lutc={lutc}' },
  { catchup: 'append', catchupSource: '?starttime={utc:YmdHMS}&endtime={utcend:YmdHMS}' },
  { catchup: 'append', catchupSource: '?begin={utc}&end={utcend}' },
  // Flussonic：.../index.m3u8 -> .../index-{start}-{duration}.m3u8
  { catchup: 'flussonic', catchupSource: '' }
];

function fetchText(url, timeout) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), timeout);
  // 只在发请求时套代理（开发预览用），url 本身保持原样，好让下钻时相对地址能正确解析
  return fetch(proxied(url), { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

/**
 * 取播放列表里的分片标识（只要 pathname，甩掉 accountinfo 之类每次都在变的 query）。
 * master playlist 会下钻一层。取不到有效播放列表返回 null。
 */
async function segKeys(url, timeout = 6000, depth = 0) {
  const txt = await fetchText(url, timeout);
  if (!txt || !/#EXTM3U/i.test(txt)) return null;
  const lines = txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const media = lines.filter((l) => !l.startsWith('#'));
  if (!media.length) return null;
  // master playlist：下钻到真正的媒体播放列表
  if (/#EXT-X-STREAM-INF/i.test(txt) && depth < 1) {
    try {
      return await segKeys(new URL(media[0], url).href, timeout, depth + 1);
    } catch (e) {
      return null;
    }
  }
  return media.map((l) => {
    try {
      return new URL(l, url).pathname;
    } catch (e) {
      return l.split('?')[0];
    }
  });
}

// 探时移窗口用的候选天数，从大往小试、命中即止
const WINDOW_DAYS = [7, 3, 1, 6 / 24, 2 / 24, 1 / 24];
// 探测统一请求 10 分钟时长的内容。超出档案范围时，网关常常不报错，而是回一个
// 只含一两个分片、指向「最早可用时刻」的列表；拿分片数太少当作超窗信号。
const PROBE_MINUTES = 10;
const MIN_SEGS = 3;

function windowOf(liveUrl, preset, days) {
  const startMs = Date.now() - days * 24 * 3600 * 1000;
  return buildCatchupUrl(
    { url: liveUrl, ...preset },
    { start: startMs, stop: startMs + PROBE_MINUTES * 60 * 1000 }
  );
}

/**
 * 探测某条直播地址支持哪种回看写法、以及能往前回看多久。
 * @param {string} liveUrl 直播地址
 * @param {object} opts { timeout }
 * @returns {Promise<object|null>} { catchup, catchupSource, catchupDays }，不支持返回 null
 */
export async function probeCatchup(liveUrl, opts = {}) {
  if (!liveUrl || !/^https?:\/\//i.test(liveUrl)) return null;
  const timeout = opts.timeout || 6000;

  // 先摸清直播窗口里都有哪些分片，作为「这是直播、不是回看」的判据。
  // 这一步是整个探测的关键：实测有些网关对 ?starttime=&endtime= 这类不认识的
  // 参数照样回 HTTP 200，但吐的还是直播分片。只看状态码会把它当成支持回看，
  // 结果就是一个点进去在放直播的假入口。
  // 注意不能拿「分片列表是否完全相同」来判断——直播是滑动窗口，隔几秒列表就变了，
  // 那样会把被忽略的参数误判成回看。改看有没有重叠：参数被忽略必然还落在直播
  // 窗口里（跟基线有交集），真回看取到的历史分片则跟直播窗口完全不沾边。
  const base = await segKeys(liveUrl, timeout);
  // 直播本身都取不到（要特殊 header / 被拦），没有基线就无法可靠判断。
  // 这时宁可不探，也不能猜——猜错就是个点进去黑屏的假回看入口。
  if (!base || !base.length) return null;
  const baseSet = new Set(base);

  const ok = (keys) =>
    keys && keys.length >= MIN_SEGS && !keys.some((k) => baseSet.has(k));

  // 第一步：拿 1 小时前（肯定已过去、又离现在足够近）试出哪种写法有效
  let hit = null;
  for (const preset of CATCHUP_PRESETS) {
    const url = windowOf(liveUrl, preset, 1 / 24);
    if (!url || url === liveUrl) continue;
    if (ok(await segKeys(url, timeout))) {
      hit = preset;
      break;
    }
  }
  if (!hit) return null;

  // 第二步：试出能往前回看多久。默认 7 天在很多网关上是过头的——实测某广东联通
  // 网关只存约 2 小时，再往前请求会回一个单分片列表，播两秒就没了。按真实窗口
  // 标记，用户才不会点到播不出来的节目。
  let days = 1 / 24; // 上一步已经证明至少 1 小时可回看
  for (const d of WINDOW_DAYS) {
    if (d <= days) break;
    if (ok(await segKeys(windowOf(liveUrl, hit, d), timeout))) {
      days = d;
      break;
    }
  }

  return { ...hit, catchupDays: days };
}

export { replaceTokens };
