// 源级请求头（M3U 里 #EXTVLCOPT 声明的 UA / Referer 等）的登记与取用。
//
// 播放链路上有四个各自独立的请求出口：hls.js 的 XHR 加载器、预热的清单 fetch、
// 预热的整片 fetch、并行 Range fetch。它们都按 URL 取头，所以这里按 origin 登记：
// 同一个源的分片、清单、子清单通常同源，一个节点一次登记就够；预热的邻台由调用方
// 先登记自己的头，不会串到别的台上。
//
// 注意：User-Agent / Referer 属于浏览器的 forbidden header，setRequestHeader 会
// 静默忽略；其余自定义头依赖 webOS 应用自身的跨域行为（真机不做 CORS 预检，
// 见 rangeLoad.js 的跨域说明）。设置失败也不抛，静默降级。

const byOrigin = new Map();
const MAX_ORIGINS = 32;

function originOf(url) {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    const o = new URL(url, base).origin;
    return o && o !== 'null' ? o : '';
  } catch (e) {
    return '';
  }
}

/** 登记某个地址所属源要带的请求头；空头视为「没有」，不覆盖已有登记。 */
export function rememberHeaders(url, headers) {
  const origin = originOf(url);
  if (!origin || !headers) return;
  const clean = {};
  let n = 0;
  for (const k in headers) {
    const v = headers[k];
    if (!v) continue;
    clean[k] = String(v);
    n++;
  }
  if (!n) return;
  const prev = byOrigin.get(origin);
  byOrigin.delete(origin); // 重新插入，维持「最近使用在最后」
  byOrigin.set(origin, clean);
  while (byOrigin.size > MAX_ORIGINS) {
    byOrigin.delete(byOrigin.keys().next().value);
  }
  if (prev && JSON.stringify(prev) === JSON.stringify(clean)) return; // 重复换台不刷日志
  try { console.log('[hdr] ' + origin + ' [' + Object.keys(clean).join(',') + ']'); } catch (e) {}
}

export function headersFor(url) {
  const origin = originOf(url);
  return origin ? byOrigin.get(origin) || null : null;
}

/** 给 XHR 挂头（hls.js 的 xhrSetup 用）。逐个 try：某个头被浏览器拒绝不影响其它头。 */
export function applyHeaders(xhr, url) {
  const headers = headersFor(url);
  if (!headers || !xhr) return;
  for (const k in headers) {
    try { xhr.setRequestHeader(k, headers[k]); } catch (e) {}
  }
}

/** 合并 fetch headers：源级头在前，调用方自己的头（如 Range）覆盖同名项。 */
export function withHeaders(url, extra) {
  const headers = headersFor(url);
  if (!headers) return extra || undefined;
  return extra ? { ...headers, ...extra } : headers;
}

export function clearHeaders() {
  byOrigin.clear();
}
