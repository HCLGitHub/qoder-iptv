// 分片并行分段下载：把一个分片用多条 HTTP Range 连接同时拉，再拼回整段。
//
// 为什么有效（广东联通网关实测，完整数据见 scripts/probe-range.mjs 顶部注释）：
// 网关按「节目码率 × 约 1.9」给**单条连接**配额度，而线路总吞吐上限远高于此。
//   PC 上实测  CCTV1 高清  8.8 Mbps 码率：单连接 2.0 MB/s → 4 路 6.5 MB/s（3.3 倍）
//              广东 4K    28.7 Mbps 码率：单连接 6.8 MB/s → 4 路 7.6 MB/s（1.1 倍）
// 8 路与 4 路持平，说明 4 路已经把线路打满，所以路数取 4。
//
// 真机实测（与 PC 的差别很关键）：高清台起播 3 秒多 → 1 秒出头，4K 台 6 秒 → 3 秒左右。
// 4K 在 PC 上只有 1.1 倍，我据此判断过「4K 没有提升空间」，真机把这个判断推翻了：
// 电视单条连接的实际吞吐明显低于 PC（TCP 窗口、无线链路、单线程拷贝都比 PC 吃亏），
// 所以在电视上连 4K 台的单连接也远没顶到线路上限，照样有一倍空间。
// 教训：并行收益 = 线路总吞吐 ÷ **该设备上**的单连接吞吐。分母是设备相关的，
// 拿 PC 上量出来的比值去预测电视，会把本来有收益的场景误判成没有。
//
// 邻台预热也走这里（见 Player._warmOne），但路数取一半（warmLanes）。
// 起因是四段分解的实测：首片占了起播耗时的 74%~89%，而缓冲和解码几乎是 0；
// 采到的样本全是预热未命中，且失败形态全是「来不及下完」而不是「地址算错」。
// 单连接一片要 3 秒，两个方向各 2 片就是 12 秒，而在一个台上通常只停 2~4 秒。
// 并行把单片压到 1 秒上下，才有可能在停留时间内热完——命中一次首片就直接归零。
//
// 这也解释了「为什么什么台都是 3 秒首片」：额度恒为码率的 1.9 倍，那 6 秒的分片
// 永远要 6÷1.9 ≈ 3.2 秒下完，跟画质高低无关——所以这不是带宽不足，是限速比例。
//
// 拼接的正确性已用 SHA-256 逐字节验证过（脚本里那段「一致性校验」，5482644 字节完全一致）。
// 这一步不能省：Range 边界只要差一个字节，拼接结果里就留下一段零，表现是偶发花屏，
// 只在特定分片出现，事后极难定位。所以下面每段都严格核对长度，对不上就整段作废。
//
// 跨域说明：Range 不在 CORS 安全请求头白名单里，浏览器里跨域请求会先发 OPTIONS 预检，
// 而 IPTV 网关基本不应答预检。但 webOS 应用没有同源限制（真机无 CORS 问题），
// 开发环境走 net.js 的同源代理，两边都不受影响。

// 整片小于这个就不拆：省下来的时间还不够几个 RTT 的固定开销。
const MIN_TOTAL = 512 * 1024;
// 每段的最小尺寸，用来反推实际路数——段切太碎同样是拿 RTT 换带宽，不划算。
const MIN_SEG = 256 * 1024;

// 确认过「不支持 Range」的源，按 origin 记住，不再重复试探。
// 不记的话，这种源每一个分片都要白搭一次探路请求。
const noRange = new Set();

let lanes = 0; // 并行路数，0/1 = 关闭（走原来的整片单连接下载）
// 本次换台各用途是否已打过诊断日志（每片都打太吵）。按 tag 分开记，
// 否则预热的日志会把播放路径那一行挤掉，而这两者要对比着看才有意义。
let loggedTags = {};

export function setRangeLanes(n) {
  lanes = n >= 2 ? n : 0;
}

export function rangeLanes() {
  return lanes;
}

// 预热用的路数：取播放路数的一半（至少 2）。
// 预热是后台行为，不能把线路吃满——正在看的那个台还要持续拉片，
// 而线路总吞吐是硬的。留一半余量，让预热快起来又不至于把当前台挤卡。
export function warmLanes() {
  return lanes >= 2 ? Math.max(2, Math.ceil(lanes / 2)) : 0;
}

// 换台时清零，让下一次换台的第一片重新打一行诊断
export function resetRangeLog() {
  loggedTags = {};
}

function perf() {
  try {
    return self.performance.now();
  } catch (e) {
    return Date.now();
  }
}

function originOf(url) {
  try {
    return new URL(url, self.location && self.location.href).origin;
  } catch (e) {
    return url;
  }
}

// Content-Range 必须完整合法；只取斜线后的总长会接受错位、重叠的分段。
function parseRange(cr) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec((cr || '').trim());
  if (!m) return null;
  const [start, end, total] = m.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return null;
  return { start, end, total };
}

function cancelBody(body) {
  try {
    const p = body && body.cancel();
    if (p) p.catch(() => {});
  } catch (e) {}
}

function checkAbort(signal) {
  if (signal.aborted) throw new Error('range aborted');
}

async function fetchRange(url, ctl, start, end) {
  checkAbort(ctl.signal);
  const response = await fetch(url, {
    headers: { Range: 'bytes=' + start + '-' + end },
    signal: ctl.signal,
    cache: 'no-store'
  });
  if (ctl.signal.aborted) {
    cancelBody(response.body);
    checkAbort(ctl.signal);
  }
  return response;
}

// Content-Length 只作提前拒绝的依据；真正的上限由逐块计数保证。
// expected 用于 Range：既不能少字节，也不能无界读入谎报长度的响应。
async function readBody(response, signal, maxBytes, expected) {
  if (signal.aborted) {
    cancelBody(response.body);
    checkAbort(signal);
  }
  const header = response.headers.get('Content-Length');
  const length = /^\d+$/.test(header || '') ? Number(header) : null;
  if (maxBytes > 0 && length > maxBytes) {
    cancelBody(response.body);
    throw { overCap: true, total: length };
  }
  if (expected !== undefined && length !== null && length !== expected) {
    cancelBody(response.body);
    throw new Error('range content length');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    // 没有流接口时不能对有界请求使用 arrayBuffer：读完再检查已来不及。
    if (maxBytes > 0 || expected !== undefined) {
      cancelBody(response.body);
      throw new Error('bounded response requires a reader');
    }
    const buf = await response.arrayBuffer();
    checkAbort(signal);
    return buf;
  }
  const reader = response.body.getReader();
  const cancel = () => cancelBody(reader);
  const limit = expected === undefined ? maxBytes : expected;
  const chunks = [];
  let loaded = 0;
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      checkAbort(signal);
      if (done) break;
      loaded += value.byteLength;
      if (limit > 0 && loaded > limit) {
        if (expected !== undefined) throw new Error('range body too large');
        // 长度未知/谎报时 total 是已见字节数（下界），不是整片的精确长度。
        throw { overCap: true, total: loaded };
      }
      chunks.push(value);
    }
    if (expected !== undefined && loaded !== expected) throw new Error('range body too short');
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  } catch (e) {
    cancel();
    throw e;
  } finally {
    signal.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch (e) {}
  }
}

// 启动一次并行下载。返回 { promise, abort } ；promise 一定 resolve，可能给出三种结果：
//   { buf, ms, ttfb, lanes }  完整数据；忽略 Range 的 200 直接复用，lanes = 1
//   { overCap: true, total }  超出 opts.maxBytes；total 是声明长度或已见字节数下界
//   null                      任何不适用/失败/取消的情形
// 这里绝不抛错，错误处理仍归调用方原本的那条路；取消后调用方不得再启动回退请求。
// 返回 null（同步）表示压根没启动，调用方可以立刻走原路。
//
// opts：
//   lanes    覆盖路数（预热用得比播放少，见 warmLanes）
//   maxBytes 整片大小上限；能从头部判断则不读 body，否则逐块检查并在超限时取消
//   signal   外部 AbortController 的 signal（换台让路用）
//   tag      日志前缀，用来区分播放和预热两条路
export function rangeLoad(url, timeoutMs, opts) {
  if (lanes < 2 || !url) return null;
  if (typeof fetch !== 'function' || typeof AbortController !== 'function') return null;
  if (noRange.has(originOf(url))) return null;

  const o = opts || {};
  const want = o.lanes >= 2 ? o.lanes : lanes;
  const outer = o.signal;
  if (outer && outer.aborted) return null;

  const ctl = new AbortController();
  const t0 = perf();
  let settled = false;
  let timer = null;
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  const fin = (r) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    if (outer) {
      try { outer.removeEventListener('abort', stop); } catch (e) {}
    }
    // 先标记完成，再取消所有 reader/请求；不能让取消把 overCap 覆盖成 null。
    if (!r || r.overCap) {
      try { ctl.abort(); } catch (e) {}
    }
    if (!r) {
      try {
        console.log('[' + (o.tag || 'range') + '] fallback after ' + Math.round(perf() - t0) + 'ms');
      } catch (e) {}
    }
    resolve(r);
  };
  const stop = () => fin(null);
  // 外部取消只转发给内部控制器；内部失败不能连坐外部调用方的回退请求。
  if (outer) {
    try { outer.addEventListener('abort', stop, { once: true }); } catch (e) {}
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(stop, timeoutMs);
  // 即使 fetch 没有及时响应 abort，stop 也会 settle；迟到响应由 fetchRange 取消。
  run(url, ctl, want, o.maxBytes || 0, o.tag || 'range').then(
    fin,
    (err) => fin(err && err.overCap ? err : null)
  );
  return { promise, abort: stop };
}

async function run(url, ctl, want, maxBytes, tag) {
  const t0 = perf();

  // 探路只请求 1 字节，但必须先检查 status：200 已经是整片，不能丢掉重下。
  const probe = await fetchRange(url, ctl, 0, 0);
  const ttfb = perf() - t0;
  if (probe.status === 200) {
    noRange.add(originOf(url));
    const buf = await readBody(probe, ctl.signal, maxBytes);
    return { buf, ms: Math.max(1, perf() - t0), ttfb, lanes: 1 };
  }
  // 403/404/5xx 等交回基类，但不继续下载它的响应体。
  const range = probe.status === 206 ? parseRange(probe.headers.get('Content-Range')) : null;
  if (!range || range.start !== 0 || range.end !== 0) {
    cancelBody(probe.body);
    return null;
  }
  const total = range.total;
  // 大小上限优先于「太小不拆」：小片也可能超过调用方给的 cap。
  if (maxBytes > 0 && total > maxBytes) {
    cancelBody(probe.body);
    return { overCap: true, total };
  }
  if (total < MIN_TOTAL) {
    cancelBody(probe.body);
    return null;
  }
  await readBody(probe, ctl.signal, 0, 1);
  checkAbort(ctl.signal);

  const n = Math.max(2, Math.min(want, Math.floor(total / MIN_SEG)));
  const size = Math.ceil(total / n);
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const start = i * size;
    const end = Math.min(total - 1, start + size - 1);
    if (start > end) break;
    jobs.push({ start, end });
  }

  const parts = await Promise.all(
    jobs.map(async (j) => {
      const r = await fetchRange(url, ctl, j.start, j.end);
      const cr = r.status === 206 ? parseRange(r.headers.get('Content-Range')) : null;
      if (!cr || cr.start !== j.start || cr.end !== j.end || cr.total !== total) {
        cancelBody(r.body);
        throw new Error('range response mismatch');
      }
      const b = await readBody(r, ctl.signal, 0, j.end - j.start + 1);
      return { j, b };
    })
  );
  checkAbort(ctl.signal);

  const out = new Uint8Array(total);
  for (const p of parts) {
    const need = p.j.end - p.j.start + 1;
    // 严格核对每段长度。差一个字节，拼接结果里就是一段零——静默的数据损坏，
    // 宁可整段作废走原路重下，也不能把坏数据喂给解码器。
    if (p.b.byteLength !== need) return null;
    out.set(new Uint8Array(p.b), p.j.start);
  }

  const ms = Math.max(1, perf() - t0);
  if (!loggedTags[tag]) {
    loggedTags[tag] = true;
    try {
      console.log(
        '[' +
          tag +
          '] ' +
          jobs.length +
          '路 ' +
          (total / 1048576).toFixed(2) +
          'MB / ' +
          (ms / 1000).toFixed(2) +
          's = ' +
          (total / 1048576 / (ms / 1000)).toFixed(2) +
          'MB/s  ttfb=' +
          Math.round(ttfb) +
          'ms'
      );
    } catch (e) {}
  }
  return { buf: out.buffer, ms, ttfb, lanes: jobs.length };
}
