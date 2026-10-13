// 播放器：优先原生 <video>，HLS 不支持时回退 hls.js
import Hls from 'hls.js';
import { proxied, resolveMediaUrl } from '../core/net.js';
import { t } from '../core/i18n.js';
import { toHlsConfig, getTuning } from './tuning.js';
import {
  setSegBudget,
  putSeg,
  makeCachedFragLoader,
  resetSegHits,
  segHits,
  segCount,
  hasSeg,
  pendingSeg,
  setPending,
  noteWarmMs,
  missNote,
  missDetail,
  waitDiag,
  cachedSegNums,
  urlSegNum
} from './fragCache.js';
import { setRangeLanes, rangeLanes, rangeLoad, warmLanes } from './rangeLoad.js';
import { makeVodPlaylistLoader } from './vodPlaylist.js';

// 可调参数集中管理，避免魔法数字散落各处
const CFG = {
  maxErrorRetries: 3, // 单次载入内网络/解码错误的连续重试上限（超过则报错）
  nativeCacheMax: 128, // “需原生解码”地址记忆的上限（超量 LRU 淘汰最早的）
  prefetchCacheMax: 48, // 预热去重集合上限（超量 LRU 淘汰最早的）
  startup: {
    pollMs: 200,
    timeoutMs: 10000,
    stallMs: 1000,
    minBuffer: 2,
    boundaryTolerance: 0.05,
    nudge: 0.05,
    motion: 0.1
  },
  warmSafety: {
    segmentFactor: 1.5, // 长分片源需要更厚的余量
    targetFraction: 0.8, // 分片时长推导的门槛不超过缓冲目标的八成
    downloadFactor: 2, // 为当前台最近的分片加载耗时留两倍余量
    downloadSlack: 2,
    downloadDecay: 0.8 // 慢下载样本逐步衰减，不被下一片缓存命中立刻冲掉
  },
  hls: {
    lowLatencyMode: false,
    startFragPrefetch: true, // 解析完清单立刻预取首个分片，不等 MSE 就绪
    testBandwidth: false, // 跳过起播带宽探测，直接起播
    abrEwmaDefaultEstimate: 1500000, // 保守的初始带宽估计：起播就选安全码率档
    // 起播回退量用「秒」而不是「片数」。原先 liveSyncDurationCount:4 是乘 TARGETDURATION 的，
    // 而 TARGETDURATION 向上取整且各源不一（这批 4K 声明 11 实际片长 10，北京卫视声明 7 实际 6），
    // 同一个片数在不同源上退出来差近一倍：4 片在前者退 44 秒、后者只退 28 秒。
    //
    // 落位算法（实测反推）：startPosition = 最后一片的 start − 本值，再由
    // startOnSegmentBoundary 向下取整对齐到所在分片的头部。注意是「跳到片边界」，
    // 所以结果是离散跳变的——本值在同一片内变化不改变落位，跨过一片就整片跳一格。
    //
    // 取 22 的依据（窗口都是 6 片）：
    //   片长 10s 的源：最后片start−22 落在倒数第 3 片 → 起播点距直播边缘约 38.6s，前面留 2 片余量
    //   片长  6s 的源：最后片start−22 落在第 1 片   → 距边缘约 30s，前面留 1 片余量
    // 两个要求：① 距边缘要盖住下面的 maxBufferLength:30，否则缓冲垫填不满就白设了；
    //          ② 起播点别压在窗口最老一片上（会被窗口滚动移除）。
    // 对比取 25：片长 10s 的源结果完全相同（落同一片），但片长 6s 的源会跳回最老一片
    // 且延迟多 6 秒，所以 22 严格更优。取 3 片（旧默认）则 10s 的源要退到 48.6s，收得不够。
    //
    // 注意：hls.js 禁止 liveSyncDuration 与 liveSyncDurationCount 并存（config.ts 里直接 throw），
    // 所以是替换掉原来那行，不能两个都留。
    liveSyncDuration: 22,
    // 对齐首个可播缓冲区间以减少片内定位；该边界不保证是源的 IDR 时间戳。
    startOnSegmentBoundary: true,
    maxBufferLength: 30,
    backBufferLength: 30,
    manifestLoadingTimeOut: 8000, // 超时与重试：失败要快，避免长时间黑屏
    manifestLoadingMaxRetry: 2,
    manifestLoadingRetryDelay: 500,
    fragLoadingTimeOut: 15000,
    fragLoadingMaxRetry: 3,
    fragLoadingRetryDelay: 500
  }
};

// 同一频道多久之后允许再热一次。直播分片会随窗口滑出，热过的过一会儿就没用了；
// 但也不能每次 settle 都重热，否则频繁翻台时会反复拉同样的数据。
//
// 原来是 30 秒，太长了：实测源单片约 3.6 秒，30 秒前热的片早滑出覆盖范围 8 片之外。
// 于是「A→B 停一会儿→回 A」时，A 因为还在冷却期不重热，缓存里留的仍是那批过时的片，
// 换过去必然落空（角标上表现为存了几片却 s+10 这种大偏差）。
// 压到 8 秒：约等于两片时长，既能让重新停留时刷新到新片，又不至于反复拉同一批。
const WARM_REDO_MS = 8000;

// 每个邻台预热几片（从起播片起连续取）。
//
// 定为 2 的依据（实测）：一轮预热里实际只跑完 1~2 片就被下一次换台清空了——
// 缓存里那几片来自 3 个不同频道，就是「每轮只完成 1 片」的证据。排 3 片的后两片
// 基本轮不到，却实打实占着带宽：实测起播被拖到 4.8 秒（比不预热还慢）。
// 而且减片数不会推迟第二个方向：交替取片让两台的首片分别排在第 1、第 2 位，
// 第二个方向的首片何时就绪只取决于单片耗时，与每台排几片无关。
// 留 2 片而不是 1 片，是为了命中之后紧跟的那一片也在内存里，别刚起播就等下载。
const WARM_SEG_MAX = 2;

// 起播对齐时允许缓存片比默认落位旧多少片。
//
// 必须和 WARM_SEG_MAX 解耦：这个值代表「对齐能忍受多少额外延迟」，
// 跟每台热几片是两件事。曾经写成 WARM_SEG_MAX * dur，结果把片数调小时
// 容忍度被连带收紧，本来能对齐的片被判成「太旧」而白白放弃。
// 3 → 4：实测遇到「预热到了但停留久了、缓存片旧了 3 片(s+3)」卡在边界没被采用，
// 放宽到 4 让这种也能对齐命中，代价是那种情况下画面多落后直播约一个分片（延迟标签可见）。
const ALIGN_LAG_SEG = 4;

// 分片缓存的总容量绝对上限。
//
// 总容量本来是「单片上限 × (两个邻台各 WARM_SEG_MAX 片 + 一格余量)」，也就是随单片上限
// 线性膨胀。4K 台要把单片上限拉到 64MB 才装得下一片，那样算出来是 320MB 的 ArrayBuffer，
// 电视那点内存扛不住。所以再夹一道绝对上限。
// 取 192MB 的依据：4K 片实测 40MB 上下，192MB 仍装得下两个邻台各 2 片，
// 不会因为容量不足触发 LRU 互挤（那会表现成「切过去缓存里根本没这个台」）。
const WARM_TOTAL_MAX = 192 * 1024 * 1024;

// 取片时往前偏移几片。
//
// 预热在停留 1.5 秒时算出起播片，而用户按下 CH+ 是几秒之后——那时直播边缘前进了，
// hls.js 算出的起播片也跟着往后挪。实测偏差稳定在 1~3 片（屏幕上表现为 s+1 ~ s+3），
// 从没出现过要更旧的片，所以起点直接跳过 1 片，把覆盖窗口对准偏差的实际落点。
//
// 这个偏移不额外花钱：起播片本来就在直播边缘往后 6 片左右的位置，
// 它后面那几片在预热那一刻的清单里早就存在了。
const WARM_LEAD = 1;

// 预热任务的保鲜期：排到时已经超过这个时长的直接丢掉。
// 直播分片过期得比队列排干还快，硬着头皮下完只是白耗带宽、还挤掉真正需要的下载。
// 取值要略大于一轮排干的时间（约 10 秒），否则最后一对片总是被误丢。
const WARM_JOB_TTL = 12000;

// 单片预热的超时。没有它，一个卡住的请求会把整条预热队列永久堵住：
// _warming 一直是 true，后面的片再也轮不到，而且换台时若 hls.js 正等着这一片
// （见 fragCache 的 pending），首片会被它一起拖住。
// 取 15 秒：4K 台单片 40MB 在预热的一半路数下也该在这之内下完，超了就是真卡住了。
const WARM_LOAD_TIMEOUT = 15000;
const WARM_MANIFEST_TIMEOUT = 4000;

// Map 版的有上限容器：记录 key → 时间戳，超量时淘汰最早写入的
function boundedSet(map, key, val, max) {
  if (map.has(key)) map.delete(key);
  else if (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, val);
}

// 按上限读取响应体。直播分片常用 chunked 传输，没有 Content-Length 可看，
// 不设上限会把 30MB 的 4K 分片整段拉下来，白占带宽还挤掉当前台。
async function readCapped(reader, cap, ctl, enabled) {
  const parts = [];
  let n = 0;
  let finished = false;
  const cancel = () => cancelWarmBody(reader);
  if (ctl) ctl.signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      checkWarmAbort(ctl, enabled());
      const { done, value } = await reader.read();
      checkWarmAbort(ctl, enabled());
      if (done) {
        finished = true;
        const out = new Uint8Array(n);
        let offset = 0;
        for (const part of parts) {
          out.set(part, offset);
          offset += part.byteLength;
        }
        return out.buffer;
      }
      n += value.byteLength;
      if (n > cap) {
        if (ctl) ctl.abort();
        return null;
      }
      parts.push(value);
    }
  } finally {
    if (ctl) ctl.signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

function cancelWarmBody(body) {
  try { Promise.resolve(body && body.cancel()).catch(() => {}); } catch (e) {}
}

function checkWarmAbort(ctl, enabled = true) {
  if (!enabled && ctl) ctl.abort();
  if (!enabled || (ctl && ctl.signal.aborted)) throw new Error('warm aborted');
}

// 有上限的 Set：命中则刷新到最近，超量时淘汰最早加入的（近似 LRU），
// 而不是一满就整个 clear()——保住“最近常用”的记忆不被误伤。
function boundedAdd(set, key, max) {
  if (set.has(key)) { set.delete(key); set.add(key); return; }
  if (set.size >= max) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(key);
}

export class Player {
  constructor(videoEl) {
    this.video = videoEl;
    this.hls = null;
    this.mode = 'live'; // live | catchup
    this.current = null; // { channel, programme, url }
    this.mediaInfo = { width: 0, height: 0, videoCodec: '', audioCodec: '' };
    this.onError = null;
    this.onStateChange = null;
    this.onMediaInfo = null; // 分辨率/编码信息变化（OSD 画质标签用）
    this._warmHold = true;
    this._warmPlaying = false;
    this._warmGeneration = 0; // 换台/停止后，旧清单响应不得重新排入预热
    this._fragDuration = 0;
    this._fragLoadSec = 0;
    this._bufferEvent = '';
    this._warmTuning = getTuning();
    this._prefetched = new Map();
    this._warmTargets = new Map();
    this._warmRefresh = null;

    this.video.addEventListener('error', () => {
      // load() 已清掉错误时，排队中的旧 error 事件不属于当前媒体。
      if (!this.current || !this.video.error) return;
      this._warmPlaying = false;
      this.holdWarm();
      if (this.hls && !this._triedNativeFallback && this._canNativeHls()) {
        if (this._fallbackToNative('media')) return;
      }
      this._sampleStartup();
      if (this.onError) this.onError(this._describeError());
    });
    // 实际解码尺寸：元数据就绪、画面尺寸变化、起播时各读一次
    ['loadedmetadata', 'resize', 'playing'].forEach((ev) => {
      this.video.addEventListener(ev, () => this._readVideoSize());
    });
    ['playing', 'waiting', 'pause', 'ended'].forEach((ev) => {
      this.video.addEventListener(ev, () => {
        if (!this.current || !this._activePath) return;
        if (ev === 'playing' && (this.video.readyState < 2 || this.video.paused)) return;
        if (ev === 'playing') { this._netRetries = 0; this._mediaRetries = 0; } // 正常起播：清零重试计数，避免长时播放中偶发抱错累加误报
        if (ev === 'playing') this._unmuteIfAllowed(); // 换台时若被静音兜底过，起播即恢复声音
        if (ev === 'playing') this._mark('playing');
        this._warmPlaying = ev === 'playing';
        // 在放行新任务前记录现场，区分先有预热争抢还是恢复后才开始预热。
        if ((ev === 'playing' || ev === 'waiting') && this._bufferEvent !== ev) {
          this._bufferEvent = ev;
          this._logBuffer(ev);
        }
        this._pumpWarm();
        if (this.onStateChange) this.onStateChange(ev);
      });
    });
    // 不加定时强制放行：时间推进/新数据入缓冲时重评，每个新任务启动前也重评。
    // 缓冲内 seek 不一定触发新的 playing，用 video.seeking 暂停，seeked 后重评；
    // 若真的触发过 waiting，仍由上面的状态锁等待 playing，不能仅凭 seeked 放行。
    ['timeupdate', 'progress', 'seeking', 'seeked'].forEach((ev) => {
      this.video.addEventListener(ev, () => this._pumpWarm());
    });
    ['loadeddata', 'playing', 'waiting', 'seeking', 'seeked', 'timeupdate'].forEach((ev) => {
      this.video.addEventListener(ev, () => this._sampleStartup(ev));
    });
  }

  _watchStartup() {
    if (!this._phase || this._startup || !['hls', 'native'].includes(this._activePath)) return;
    const now = Date.now();
    const state = this._startup = {
      at: now, position: this.video.currentTime, stillAt: now, progress: 0,
      reason: 'buffer', nudged: false, attempted: false, done: false
    };
    this._sampleStartup();
    if (state.done) return;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this._startupFrame = this.video.requestVideoFrameCallback(() => {
        if (this._startup !== state) return;
        this._startupFrame = null;
        this._mark('frame');
      });
    }
    this._startupTimer = setInterval(() => this._sampleStartup(), CFG.startup.pollMs);
  }

  _clearStartup() {
    clearInterval(this._startupTimer);
    this._startupTimer = null;
    if (this._startupFrame != null && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this._startupFrame);
    }
    this._startupFrame = null;
  }

  _sampleStartup(event) {
    const state = this._startup;
    const phase = this._phase;
    if (!state || state.done || !phase || !this._activePath) return;
    const native = this._activePath === 'native';
    if (!native && !this.hls) return;
    const v = this.video;
    const cfg = CFG.startup;
    const now = Date.now();
    const pos = v.currentTime;
    const delta = pos - state.position;
    const elapsed = (now - state.at) / 1000;
    const seeking = v.seeking || event === 'seeking' || event === 'seeked';
    if (v.readyState >= 2) this._mark('data');
    if (event === 'seeked') this._mark('seeked');
    // seek 的跳时不能算作播放推进，也不能继承跳时前的停滞计时。
    if (seeking || v.paused || delta < 0 || delta > elapsed * Math.max(1, v.playbackRate) + 0.25) {
      state.progress = 0;
      state.stillAt = now;
    } else if (delta > 0) {
      state.progress += delta;
      state.stillAt = now;
    }
    state.position = pos;
    state.at = now;
    if (v.error || v.ended || now - (phase.native || phase.t0) >= cfg.timeoutMs) {
      state.done = true;
      state.reason = v.error ? 'error' : 'timeout';
      this._clearStartup();
      return;
    }
    if (state.progress >= cfg.motion) {
      this._mark('motion');
      state.reason = 'moving';
      state.done = true;
      this._clearStartup();
      if (native && this.onStateChange) this.onStateChange('startupmoving');
      return;
    }
    const ahead = this._bufferAhead();
    state.reason = seeking ? 'seeking' : ahead < cfg.minBuffer ? 'buffer' : 'ready';
    // webOS 原生 HLS 的 buffered/seekable 往往晚于首帧，微移 currentTime 反而会触发一次 waiting。
    // 原生路径只观察真实时间推进；首边界校正仅用于能掌握分片状态的 hls.js。
    if (native || this.mode !== 'live' || v.paused || seeking || v.readyState !== 2 ||
        ahead < cfg.minBuffer || state.attempted || now - state.stillAt < cfg.stallMs) return;
    const target = pos + cfg.nudge;
    const flights = this.hls.inFlightFragments || {};
    const dependency = ['main', 'audio'].some((type) => {
      const flight = flights[type];
      return flight && flight.frag && flight.frag.start <= pos &&
        !['IDLE', 'STOPPED', 'ENDED', 'ERROR'].includes(flight.state);
    });
    if (dependency) { state.reason = 'dependency'; return; }
    const buffered = v.buffered;
    if (!buffered.length) return;
    const start = buffered.start(0);
    if (pos < start || pos - start > cfg.boundaryTolerance || target >= buffered.end(0)) return;
    state.attempted = true;
    state.progress = 0;
    state.stillAt = now;
    try {
      v.currentTime = target;
      state.position = v.currentTime;
      state.nudged = true;
      state.reason = 'nudged';
      console.log('[startup] hls nudge ' + pos.toFixed(3) + ' -> ' + target.toFixed(3));
    } catch (e) {
      state.reason = 'ready';
    }
  }

  startupStatus() {
    const p = this._phase;
    const state = this._startup;
    if (!p || !state || !this._activePath) return null;
    const sinceStart = (value) => value ? Math.max(0, value - p.t0) : null;
    let ahead = this._bufferAhead();
    if (this._activePath === 'native') {
      try { if (!this.video.buffered || !this.video.buffered.length) ahead = null; }
      catch (e) { ahead = null; }
    }
    return {
      path: this._activePath, fallback: p.fallback || null, native: sinceStart(p.native),
      data: sinceStart(p.data), frame: sinceStart(p.frame), seeked: sinceStart(p.seeked),
      playing: sinceStart(p.playing), motion: sinceStart(p.motion),
      ahead, readyState: this.video.readyState, reason: state.reason, nudged: state.nudged
    };
  }

  // 起播耗时分解用：记下某个阶段第一次到达的绝对时刻（后到的同名标记不覆盖）。
  _mark(name) {
    if (this._phase && !this._phase[name]) this._phase[name] = Date.now();
  }

  // 本次起播各阶段耗时（毫秒），供右下角角标临时展示「时间花在哪」。
  // 只有 hls.js 路径能拿到清单/分片/缓冲事件；原生路径返回 null（只有总时长可看）。
  startupPhases() {
    const p = this._phase;
    if (!p || !p.t0 || !p.playing) return null;
    // 原生解码路径拿不到清单/分片/缓冲事件，四段里只有「出帧」会有值，
    // 剩下三段全是 0——那不是「这三步不花时间」，而是压根没测到。
    // 显示出来会把人往「解码器慢」上带，所以这条路直接不给分解，只留总时长。
    if (this._activePath !== 'hls') return null;
    const seg = (end, start) => (end && start && end >= start ? end - start : 0);
    return {
      manifest: seg(p.manifest, p.t0),
      frag: seg(p.frag, p.manifest || p.t0),
      buffer: seg(p.buffered, p.frag || p.manifest || p.t0),
      render: seg(p.playing, p.buffered || p.frag || p.manifest || p.t0)
    };
  }

  _describeError() {
    const e = this.video.error;
    if (!e) return t('perr.generic');
    const map = {
      1: 'perr.aborted',
      2: 'perr.network',
      3: 'perr.decode',
      4: 'perr.srcUnsupported'
    };
    return t(map[e.code] || 'perr.generic');
  }

  // ---- 媒体信息（分辨率 + 音频编码）----
  _readVideoSize() {
    const w = this.video.videoWidth || 0;
    const h = this.video.videoHeight || 0;
    if (!w || !h) return; // 元数据还没到，别把已有值清掉
    if (w === this.mediaInfo.width && h === this.mediaInfo.height) return;
    this.mediaInfo.width = w;
    this.mediaInfo.height = h;
    if (!this.mediaInfo.audioCodec) this.mediaInfo.audioCodec = this._nativeAudioCodec();
    this._emitMediaInfo();
  }

  // 原生播放（电视端走系统媒体管线）拿不到清单里的 CODECS，
  // 退而从音轨列表的名称里认编码名，认不出就不显示音频标签。
  _nativeAudioCodec() {
    const list = this.video.audioTracks;
    if (!list || !list.length) return '';
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const s = String((t && (t.label || t.language)) || '');
      if (/aac|ac-?3|mp[23]|dts|opus|dolby/i.test(s)) return s;
    }
    return '';
  }

  _emitMediaInfo() {
    if (this.onMediaInfo) this.onMediaInfo({ ...this.mediaInfo });
  }

  _resetMediaInfo() {
    this.mediaInfo = { width: 0, height: 0, videoCodec: '', audioCodec: '' };
    this._emitMediaInfo();
  }

  getMediaInfo() {
    return { ...this.mediaInfo };
  }

  // 当前播放位置落后直播边缘多少秒（回看模式返回 null，不显示）。
  // hls.js 自己算的 latency 最准（相对直播边缘、扣掉了空洞）；原生解码或它没给值时，
  // 退而用「可 seek 区间末端 − 当前播放位置」——末端即窗口里最新的画面，近似直播边缘。
  getLiveLatency() {
    if (this.mode !== 'live') return null;
    if (this.hls) {
      const l = this.hls.latency;
      if (typeof l === 'number' && isFinite(l) && l >= 0) return l;
    }
    const v = this.video;
    const sk = v && v.seekable;
    if (sk && sk.length) {
      const d = sk.end(sk.length - 1) - v.currentTime;
      if (isFinite(d) && d >= 0) return d;
    }
    return null;
  }

  // 本次载入至今的下载字节数（单调递增，换台归零）。
  // hls.js 用分片下载统计；原生播放拿不到网络量，退而用已解码字节数近似。
  getLoadedBytes() {
    if (this.hls) return this._loadedBytes || 0;
    const v = this.video;
    return (v.webkitVideoDecodedByteCount || 0) + (v.webkitAudioDecodedByteCount || 0);
  }

  _destroyHls() {
    this._clearStartup();
    this._startup = null;
    const hls = this.hls;
    this.hls = null;
    if (hls) {
      try { hls.destroy(); } catch (e) {}
    }
  }

  _canNativeHls() {
    return !!this.video.canPlayType('application/vnd.apple.mpegurl');
  }

  // 尝试播放：若被浏览器自动播放策略拦截，则退化为静音播放以显示画面
  _tryPlay() {
    const phase = this._phase;
    const path = this._activePath;
    const p = this.video.play();
    if (p && typeof p.catch === 'function') {
      p.catch((error) => {
        // 换流中断的旧 play() 不能重试到新频道，也不属于自动播放权限失败。
        if (this._phase !== phase || this._activePath !== path || !this.current ||
            !error || error.name !== 'NotAllowedError') return;
        this.video.muted = true;
        this._autoMuted = true;
        this.video.play().catch(() => {});
      });
    }
  }

  // 用户首次交互后恢复声音（解除因自动播放策略导致的静音）。
  // 只记标记 + 尝试解除：换台是「按键 → 载入新流」的顺序，新流被静音兜底时
  // 这次按键早已处理完，光靠按键触发就得等下一次按键才有声，所以起播时还会再试一次。
  userUnmute() {
    this._userInteracted = true;
    this._unmuteIfAllowed();
  }

  // 解除静音兜底。只在用户交互过之后才安全——没交互就取消静音会被自动播放策略再次拦下。
  _unmuteIfAllowed() {
    if (!this._autoMuted || !this._userInteracted) return;
    this.video.muted = false;
    this._autoMuted = false;
  }

  // 载入并播放一个地址
  _load(rawUrl, decoder = 'auto') {
    this._warmTuning = getTuning();
    this._clearStartup();
    this._startup = null;
    this._phase = { t0: Date.now() }; // 起播耗时分解的计时起点（各阶段标记见 _mark）
    this._decoder = decoder; // 预热要据此判断「邻台切过去会不会走原生」（见 _willUseNative）
    this._aligned = false; // 本次载入是否已定过起播位置（见 _alignedStart 的两个调用点）
    this._alignNote = ''; // 本次对齐的结局（上屏诊断用，见 _alignedStart 里的赋值点）
    this._alignWin = null; // 对齐失败时的清单窗口与缓存号段（同上）
    resetSegHits(); // 预热命中数按本次换台重新计
    this._warmHeld = segCount(); // 换台这一刻缓存里存着几片（角标诊断用）
    this._resetMediaInfo(); // 换台先清掉上一个台的画质标签

    const url = proxied(rawUrl);
    this._rawUrl = rawUrl; // 原始地址（用作“需原生解码”的记忆键）
    this._proxiedUrl = url; // 供 hls.js 失败时回退原生播放用
    this._triedNativeFallback = false; // 每次载入重置回退标记
    this._netRetries = 0; // 本次载入的连续网络/解码错误重试计数（超上限则报错）
    this._mediaRetries = 0;
    this._loadedBytes = 0; // 本次载入已下载字节数（网速显示用），换台归零
    const isHls = /\.m3u8(\?|$)/i.test(rawUrl);
    // 自动档默认走 hls.js（缓冲更厚、抗抖动更好）；只有确定 hls.js 走不通的地址
    // （历史回退过 / MSE 解不了 HEVC，见 _looksHevc）才直接交原生，省一轮黑屏等待。
    const preferNative =
      decoder === 'auto' && this._canNativeHls() && this._looksHevc(rawUrl);
    const useHlsJs = isHls && decoder !== 'native' && !preferNative && Hls.isSupported();
    // 在途的后台预热让位给这次换台。
    // 「要切过去的那个台」只在走 hls.js 时才值得留着：它的片能喂进分片加载器
    // （见 fragCache 的 pending）。走原生的话那片谁也用不上，留着只是继续占着
    // 原生起播正需要的带宽，所以传 null 让它一起掐掉。
    // 这一步必须等 useHlsJs 算出来才做，不能放在函数开头——那时还不知道走哪条路。
    this._abortWarm(useHlsJs && this._warmEnabled() ? rawUrl : null);

    if (useHlsJs) {
      this._activePath = 'hls';
      // 调参刚改过：hls.js 的配置只在 new Hls() 时读取一次，改了必须销毁重建才生效，
      // 不能走下面的复用分支（复用只换清单，配置还是旧实例那份）。
      if (this._tuningDirty) {
        this._destroyHls();
        this._tuningDirty = false;
      }
      // 复用已存在的 hls.js 实例：直接换清单，省去 destroy→new→attachMedia 的
      // MSE 重建开销，连续换台起播更快（事件处理器仍在，会自动 _tryPlay）。
      if (this.hls) {
        try {
          this.hls.stopLoad();
          this.hls.loadSource(url);
          // 这里不再 startLoad()：起播位置要等清单解析出来、看清缓存里有哪几片才能定，
          // 统一由 MANIFEST_PARSED 处理器调用（见 _createHls 里的 _alignedStart）。
          return;
        } catch (e) {
          this._destroyHls(); // 复用失败则退回重建
        }
      }
      // 上一路是原生播放：先清掉原生 src 再新建实例
      this.video.removeAttribute('src');
      this._createHls(url);
    } else {
      this._warmNote('v');
      this._startNative(url);
    }
  }

  _startNative(url, fallback = null) {
    const now = Date.now();
    const t0 = this._phase ? this._phase.t0 : now;
    this._destroyHls();
    this._activePath = 'native';
    this._phase = { t0, native: now, fallback };
    this.video.removeAttribute('src');
    this.video.preload = 'auto';
    this.video.src = url;
    this.video.load();
    this._watchStartup();
    if (fallback && this.onStateChange) this.onStateChange('nativefallback');
    this._tryPlay();
  }

  // 按基类缓存生成的缓存加载器类。基类取自 hls.config.loader，hls.js 可能按配置
  // 换成不同的实现，所以按基类分别缓存——但也不该每次换台都重新生成一个类，
  // 那会让 hls.js 每次都当成新 loader 处理。
  static _fragLoaderFor(Base) {
    if (!Player._fragLoaders) Player._fragLoaders = new Map();
    let C = Player._fragLoaders.get(Base);
    if (!C) {
      C = makeCachedFragLoader(Base);
      Player._fragLoaders.set(Base, C);
    }
    return C;
  }

  // 新建并挂载 hls.js 实例（事件绑定只在这里做一次；换台复用时不重复绑定）
  _createHls(url) {
    // 用户调参覆盖在 CFG 之上。两者的默认值是逐项对齐的，所以不动调参时行为与写死一致。
    const tune = getTuning();
    const cfg = { ...CFG.hls, ...toHlsConfig(tune) };
    // 起播位置由我们自己定，所以不让 hls.js 自动开跑。
    // 它默认一挂上媒体元素就按「直播边缘 − liveSyncDuration」起播，那个位置是它算的，
    // 未必是我们缓存里有的那一片；改成等清单解析完、看清缓存内容再 startLoad(位置)。
    cfg.autoStartLoad = false;
    const hls = new Hls(cfg);
    this.hls = hls;
    // 预热缓存或并行分段下载开着时才接管分片加载：两个都关就是原生行为，
    // 不引入任何额外路径。（并行分段也住在这个加载器里，所以条件是「或」——
    // 只开并行、不开预热的组合必须也能生效。）
    //
    // 必须放在 new Hls() **之后**，而且基类要取 hls.config.loader 而不是
    // Hls.DefaultConfig.loader：hls.js 会在构造时按配置替换 config.loader，
    // 从 DefaultConfig 上取会拿到被替换之前的那个，于是我们的加载器继承错了基类。
    // （曾经的边下边解开关就是这样失效的：它把 loader 换成 FetchLoader，
    //  但分片走的是 fLoader，而 fLoader 继承的还是 XhrLoader。那个开关现已撤掉。）
    setRangeLanes(tune.fragParallel);
    if (tune.prefetchSegmentBytes > 0 || rangeLanes() >= 2) {
      hls.config.fLoader = Player._fragLoaderFor(hls.config.loader);
    }
    // 回看清单缺 #EXT-X-ENDLIST 会被 hls.js 当成直播：duration 是 Infinity（进度条只能拿
    // EPG 时长凑），还会整段回看期都定时重拉清单。这个加载器在解析前把它补上
    // （只在已确认清单完整时，详见 vodPlaylist.js）。
    // 基类同样只能取 hls.config.loader，理由跟上面 fLoader 一样。
    hls.config.pLoader = makeVodPlaylistLoader(hls.config.loader, () => this._vodExpect());
    // 一次性确认：分片到底走的哪个加载器、并行开了几路。
    try {
      const base = hls.config.loader;
      console.log(
        '[warm] frag base=' + ((base && base.name) || '?') +
          ' cached=' + !!hls.config.fLoader +
          ' lanes=' + rangeLanes()
      );
    } catch (e) {}
    const fail = (message) => {
      if (this.hls !== hls) return;
      this._abortWarm(null);
      this._destroyHls();
      if (this.onError) this.onError(message);
    };
    hls.on(Hls.Events.ERROR, (evt, data) => {
      if (!data || this.hls !== hls) return;
      // 非致命的编码错误：hls.js 会丢掉这条轨继续播下去。丢的是音轨时表现就是
      // 「画面正常但没声音」（IPTV 的杜比 AC-3/E-AC-3 音轨最典型），
      // 所以只要沾上 codec 就交给原生管线重播一次——电视原生解码支持杜比。
      if (!data.fatal && /codec/i.test(data.details || '')) {
        if (this._canNativeHls() && this._fallbackToNative('codec')) return;
      }
      if (data.fatal) {
        // 编码不被当前浏览器支持（如桌面 Chrome 无 H.265/HEVC 解码）
        if (data.details && /codec/i.test(data.details)) {
          // hls.js 经 MSE 无法解码该编码（多为 4K H.265/HEVC）→ 回退电视原生硬件解码
          if (this._canNativeHls() && this._fallbackToNative('codec')) return;
          // 已回退过（可能由 video error 先触发）→ 不重复弹错
          if (this._triedNativeFallback) { this._destroyHls(); return; }
          fail(t('perr.hevcUnsupported'));
          return;
        }
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            // 连续网络错误重试有上限：源真挂了就报错，避免无限静默重试让用户一直看着转圈
            if (++this._netRetries > CFG.maxErrorRetries) {
              fail(t('perr.networkLost'));
            } else {
              hls.startLoad();
            }
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            if (++this._mediaRetries > CFG.maxErrorRetries) {
              fail(t('perr.decodeFailed'));
            } else {
              hls.recoverMediaError();
            }
            break;
          default:
            fail(t('perr.playFailed', { detail: data.details || t('perr.unknown') }));
        }
      }
    });
    // 分片/清单下载量累计：给右下角网速显示提供原始数据
    const countBytes = (evt, data) => {
      if (this.hls !== hls) return;
      if (data && data.frag && data.frag.type === 'main' && Number.isFinite(data.frag.sn)) this._mark('frag');
      const st = data && (data.stats || (data.frag && data.frag.stats));
      const n = (st && (st.loaded || st.total)) ||
        (data && data.payload && data.payload.byteLength) || 0;
      if (n > 0) this._loadedBytes += n;
      if (this.hls === hls) this._recordFragLoad(data);
    };
    hls.on(Hls.Events.FRAG_LOADED, countBytes);
    // 首片送进 MSE 缓冲区的时刻（起播耗时分解用）
    hls.on(Hls.Events.FRAG_BUFFERED, (evt, data) => {
      if (this.hls !== hls) return;
      if (data && data.frag && data.frag.type === 'main' && Number.isFinite(data.frag.sn)) {
        this._mark('buffered');
        this._watchStartup();
      }
      this._pumpWarm();
    });
    // 编码信息取自实际解析结果（BUFFER_CODECS），比清单里声明的 CODECS 可靠
    hls.on(Hls.Events.BUFFER_CODECS, (evt, data) => {
      if (!data || this.hls !== hls) return;
      if (data.video && data.video.codec) this.mediaInfo.videoCodec = data.video.codec;
      if (data.audio && data.audio.codec) this.mediaInfo.audioCodec = data.audio.codec;
      this._emitMediaInfo();
    });
    // 码率档切换：清单里的宽高只在拿不到实际解码尺寸时作兜底
    hls.on(Hls.Events.LEVEL_SWITCHED, (evt, data) => {
      if (this.hls !== hls) return;
      const lv = hls.levels && hls.levels[data && data.level];
      if (!lv) return;
      if (!this.mediaInfo.width && lv.width && lv.height) {
        this.mediaInfo.width = lv.width;
        this.mediaInfo.height = lv.height;
      }
      if (!this.mediaInfo.videoCodec && lv.videoCodec) this.mediaInfo.videoCodec = lv.videoCodec;
      if (!this.mediaInfo.audioCodec && lv.audioCodec) this.mediaInfo.audioCodec = lv.audioCodec;
      this._emitMediaInfo();
    });
    // 先挂载媒体元素再加载清单：让 MSE 初始化与网络请求并行，减少首帧等待
    hls.attachMedia(this.video);
    hls.loadSource(url);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (this.hls !== hls) return;
      this._mark('manifest');
      // 清单解析后若发现是 MSE 不支持的 HEVC（常见于 4K 频道），
      // 提前回退原生硬件解码，省去等报错的黑屏时间。
      // 回退返回 false 表示这一轮已经回退过了，那就只能继续用 hls.js 往下走——
      // 不能直接 return，否则 autoStartLoad 关着，谁都不去加载就成黑屏了。
      if (this._hevcNeedsNative(hls)) {
        this.mediaInfo.videoCodec = 'hevc'; // 原生解码拿不到 CODECS，这里据清单先标注
        this._emitMediaInfo();
        if (this._fallbackToNative('hevc')) return;
      }
      // 音频编码 MSE 一个都放不出来（杜比等）→ 同样提前交给原生，
      // 免得先静音播一段再靠 ERROR 兜底回退。
      if (this._audioNeedsNative(hls) && this._fallbackToNative('audio')) return;
      // 起播位置：优先落到「缓存里已经有的那一片」，没有就传 -1 让 hls.js 自己算
      const pos = this._alignedStart(hls);
      if (pos >= 0) this._aligned = true; // 已定位，下面那个补丁就不必再管了
      hls.startLoad(pos);
      this._tryPlay();
    });
    // 多码率源（master 清单）的起播对齐补在这里。
    //
    // 上面那次对齐在多码率源上必然失败：MANIFEST_PARSED 触发时各档的 details 还是空的。
    // hls.js 只在「清单本身就是 media playlist」时才把解析好的 details 一并塞进那个
    // 独苗 level（playlist-loader.ts 的 singleLevel 分支带着 details 就 trigger），
    // master 清单则要等各档自己加载完才有分片列表。于是那一刻 _alignedStart 拿不到
    // frags、只能返回 -1——预热明明存着这个台的片，起播却按 hls.js 自己算的位置去要，
    // 序号自然对不上，角标上就是「存了几片却 s±N」。
    //
    // 此刻改起播位置还来得及：stream-controller 收到本事件才转入 IDLE，真正取片是
    // 下一个 tick，而这个回调是同步跑完的。而且 hls.js 的 setStartPosition 明确
    // 「已经给了值就直接用」（base-stream-controller.ts 原文 "use it straight away
    // if value is defined"），所以这里设下去的位置不会被它回头算掉。
    hls.on(Hls.Events.LEVEL_LOADED, (evt, data) => {
      if (this.hls !== hls || this._aligned) return;
      const det = data && data.details;
      if (!det || !det.fragments || !det.fragments.length) return;
      this._aligned = true; // 只补一次，成不成都不再试
      const pos = this._alignedStart(hls, det);
      if (pos >= 0) hls.startLoad(pos);
    });
  }

  // 起播落在哪一秒。
  //
  // 原先的思路是「猜 hls.js 会请求哪一片，就预热那一片」，但那个片号取决于用户在上一个台
  // 停留了多久（清单一直在往前滑），根本猜不准——实测怎么调偏移量都差一两片。
  //
  // 这里把因果调过来：不猜它要哪片，而是让它从我们已经有的那片开始播。
  // 代价看起来是「内容位置退后一片」，实际几乎为零：退后一片是 3.6 秒，
  // 而首帧从 4 秒提前到 0.4 秒也是 3.6 秒，到同一个墙上时刻画面进度是一样的。
  //
  // 返回 -1 表示不干预，由 hls.js 按 liveSyncDuration 自己落位。
  //
  // det 可以由调用方直接给（LEVEL_LOADED 时就用它带来的那一份）；不给才按当前档去取。
  // 这个参数是必要的：master 清单在 MANIFEST_PARSED 那一刻各档的 details 都还是空的。
  _alignedStart(hls, det) {
    try {
      if (!(getTuning().prefetchSegmentBytes > 0)) {
        this._alignNote = 'off';
        return -1;
      }
      if (!det) {
        const levels = hls.levels || [];
        let li = hls.startLevel;
        if (li < 0) li = hls.firstLevel;
        const lv = levels[li >= 0 ? li : 0];
        det = lv && lv.details;
      }
      const frags = det && det.fragments;
      if (!frags || !frags.length || !det.live) {
        this._alignNote = 'nodet';
        return -1;
      }
      // hls.js 不干预时会落在这里，用它当基准判断「对齐要多付多少延迟」
      const dflt = det.edge - (getTuning().liveSyncDuration || 0);
      let pick = -1;
      for (let i = 0; i < frags.length; i++) {
        // 正在下载途中的也算「有」：加载器会等它下完直接用（见 fragCache 的 pending）。
        // 等一两秒拿到，比放弃对齐、让 hls.js 从零重下一片 2.4 秒更快，还省一份流量。
        if (!hasSeg(frags[i].url) && !pendingSeg(frags[i].url)) continue;
        if (frags[i].start <= dflt) {
          pick = i; // 不断往后更新：留下最接近基准、又没超过它的那一片
        } else {
          // 缓存里全是比基准更新的片（停留极短时会这样）：取最老的那个，
          // 别贴着直播边缘起播，否则前向缓冲一开始就是空的、容易立刻转圈
          if (pick < 0) pick = i;
          break;
        }
      }
      if (pick < 0) {
        // 清单窗口里一片都不在缓存里。到这一步必须把两个号段一起记下来，
        // 因为同一句「窗口里没一片在缓存里」背后有三种修法完全相反的成因：
        //   ① 缓存里压根没有这个台的片（同目录一个号都没）→ 预热没热到它
        //   ② 号明明落在窗口区间内却没匹配上  → 缓存键按地址比，源给分片挂了
        //      每次都变的 token，得改归一化规则（代码问题）
        //   ③ 号真的滑出了窗口区间              → 时间墙，只能调预热取片位置
        // 光看主行那个 s±1 分不出来：那个差值是按路径算的，绕过了缓存键的匹配规则，
        // 所以它可以显示「只差 1 片」而对齐同时报「一片都不在窗口内」——两者并不矛盾。
        this._alignNote = 'nowin';
        this._alignWin = {
          lo: urlSegNum(frags[0].url),
          hi: urlSegNum(frags[frags.length - 1].url),
          n: frags.length,
          have: cachedSegNums(frags[0].url)
        };
        return -1;
      }
      const f = frags[pick];
      // 太旧的残留片不要对齐：那是十几片之前的老货，对齐过去等于凭空多几十秒延迟，
      // 不如老老实实现下载。容忍度用独立常量，不跟每台热几片挂钩。
      const dur = f.duration || det.targetduration || 0;
      if (dur > 0 && dflt - f.start > ALIGN_LAG_SEG * dur) {
        this._alignNote = 'old';
        return -1;
      }
      this._alignNote = 'ok';
      try {
        console.log(
          '[warm] align start ' + f.start.toFixed(2) + 's (default ' + dflt.toFixed(2) + 's) ' + f.url
        );
      } catch (e) {}
      return f.start;
    } catch (e) {
      this._alignNote = 'err';
      return -1;
    }
  }

  // hls.js 载入失败/编码不支持时回退到电视原生硬件解码（同一地址重播一次）。
  // 每次 _load 只回退一次，避免死循环。返回是否执行了回退。
  _fallbackToNative(reason = 'media') {
    if (this._triedNativeFallback || !this._proxiedUrl) return false;
    this._abortWarm(null);
    this._triedNativeFallback = true;
    if (this._rawUrl) {
      if (!this._nativeUrls) this._nativeUrls = new Set();
      boundedAdd(this._nativeUrls, this._rawUrl, CFG.nativeCacheMax);
    }
    this._startNative(this._proxiedUrl, reason);
    return true;
  }

  // 这个地址切过去会不会走原生解码。给预热用：走原生就不该整片下载。
  //
  // 只认两条硬证据，不猜：① 全局解码档位就选的原生；② 这个地址以前真回退过原生。
  // 不能复用 _looksHevc：它会去看 this.current.channel.name，那是**当前**台的名字，
  // 拿来判断另一个台必然认错对象。
  _willUseNative(rawUrl) {
    if (this._decoder === 'native') return true;
    return !!(this._nativeUrls && this._nativeUrls.has(rawUrl));
  }

  // 自动档下预判“该地址得用原生解码”。只认两种情况：
  // ① 这个地址以前真的回退过原生；② MSE 确实解不了 HEVC。
  // 不能只凭频道名带 4K 就跳过 hls.js：部分电视的 MSE 能解 HEVC，硬推给原生反而更糟——
  // 原生管线对某些 4K 流会播几秒后解码失败，而且它的缓冲比 hls.js 浅得多，
  // 大分片高码率（10s/47MB 这种）下极易周期性卡顿。
  _looksHevc(rawUrl) {
    if (this._nativeUrls && this._nativeUrls.has(rawUrl)) return true;
    if (this._mseHevcOk()) return false; // MSE 解得了 → 交 hls.js，缓冲更厚更稳
    const name = (this.current && this.current.channel && this.current.channel.name) || '';
    return /4k|8k|2160|uhd|hevc|h\.?265/i.test(name + ' ' + rawUrl);
  }

  // MSE 能否解 HEVC。拿 Main profile / Level 5.0（4K HEVC 的典型档位）探测，
  // hvc1 与 hev1 两种封装标识都试——有些平台只认其中一个。
  _mseHevcOk() {
    try {
      const mse = window.MediaSource;
      if (!mse || !mse.isTypeSupported) return false;
      return ['hvc1.1.6.L150.90', 'hev1.1.6.L150.90'].some((c) =>
        mse.isTypeSupported('video/mp4; codecs="' + c + '"')
      );
    } catch (e) {
      return false;
    }
  }

  // 判断清单里是否为 HEVC 且当前 MSE 不支持——此时需交给原生解码。
  _hevcNeedsNative(hls) {
    try {
      const levels = (hls && hls.levels) || [];
      const isHevc = (c) => /hvc1|hev1|h\.?265|hevc/i.test(c || '');
      const anyHevc = levels.some((l) => isHevc(l.videoCodec) || isHevc(l.codecs));
      if (!anyHevc) return false;
      // MSE 不支持 HEVC，但电视原生能放 → 回退；桌面无原生 HLS 则不回退（本就放不了）
      return !this._mseHevcOk() && this._canNativeHls();
    } catch (e) {
      return false;
    }
  }

  // 判断清单声明的音频编码是否 MSE 全都放不出来（杜比 AC-3/E-AC-3、MPEG-2 音频等）。
  // 不维护编码黑名单，直接问 MSE：只要有任意一条音轨能放，hls.js 会自己挑那条，不用回退。
  // 局限：不少 IPTV 清单压根不声明音频 CODECS，这里就查不出来，靠 ERROR 事件那层兜底。
  _audioNeedsNative(hls) {
    try {
      if (!this._canNativeHls()) return false; // 没有原生 HLS 就没得退（桌面浏览器）
      const mse = window.MediaSource;
      if (!mse || !mse.isTypeSupported) return false;
      const codecs = new Set();
      for (const l of (hls && hls.levels) || []) if (l.audioCodec) codecs.add(l.audioCodec);
      for (const a of (hls && hls.audioTracks) || []) if (a.audioCodec) codecs.add(a.audioCodec);
      if (!codecs.size) return false;
      for (const c of codecs) {
        if (mse.isTypeSupported('audio/mp4; codecs="' + c + '"')) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // 面板可能先保存额度、关闭面板后才重播；不能只看上次载入的设置。
  _warmEnabled() {
    return this._warmTuning.prefetchSegmentBytes > 0 && getTuning().prefetchSegmentBytes > 0;
  }

  // 登记邻台；缓冲安全后才按登记顺序取最新清单，直播期间限频续热。
  prefetch(rawUrl, refresh = false) {
    if (!this._warmEnabled()) {
      this._abortWarm(null);
      return Promise.resolve();
    }
    const generation = this._warmGeneration;
    if (!this.current || this.mode !== 'live' || rawUrl === this.current.url) return Promise.resolve();
    if (!rawUrl || !/\.m3u8(\?|$)/i.test(rawUrl)) {
      // 非 m3u8 地址走原生解码，没有分片概念，预热与所有 hls.js 调参都不适用
      this._warmNote('n');
      try { console.log('[warm] skip (not m3u8) ' + rawUrl); } catch (e) {}
      return Promise.resolve();
    }
    if (!this._prefetched) this._prefetched = new Map();
    if (this._willUseNative(rawUrl)) {
      if (!refresh && Date.now() - (this._prefetched.get(rawUrl) || 0) < WARM_REDO_MS) return Promise.resolve();
      boundedSet(this._prefetched, rawUrl, Date.now(), CFG.prefetchCacheMax);
      this._warmNote('v', rawUrl);
      return this._fetchWarmManifest(rawUrl, rawUrl, generation, 0, true);
    }
    let target = this._warmTargets.get(rawUrl);
    if (!target) {
      target = { nextAt: 0, interval: WARM_REDO_MS };
      boundedSet(this._warmTargets, rawUrl, target, CFG.prefetchCacheMax);
    }
    if (refresh) target.nextAt = 0;
    return this._refreshWarmTargets();
  }

  _refreshWarmTargets() {
    if (this._warmRefresh) return this._warmRefresh.promise;
    if (!this._updateWarmGate() || this._warming) return Promise.resolve();
    if (![...this._warmTargets.values()].some((target) => target.nextAt <= Date.now())) return Promise.resolve();
    const generation = this._warmGeneration;
    const entry = { promise: null };
    this._warmRefresh = entry;
    entry.promise = Promise.resolve().then(async () => {
      for (const [chan, target] of this._warmTargets) {
        if (generation !== this._warmGeneration || !this._updateWarmGate()) return;
        if (target.nextAt > Date.now()) continue;
        target.nextAt = Date.now() + target.interval;
        this._warmQ = (this._warmQ || []).filter((job) => job.chan !== chan);
        boundedSet(this._prefetched, chan, Date.now(), CFG.prefetchCacheMax);
        await this._fetchWarmManifest(chan, chan, generation);
        if (generation !== this._warmGeneration) return;
        target.nextAt = target.once ? Infinity : Date.now() + target.interval;
      }
    }).finally(() => {
      if (this._warmRefresh !== entry) return;
      this._warmRefresh = null;
      this._pumpWarm();
    });
    return entry.promise;
  }

  _fetchWarmManifest(url, chan, generation, depth = 0, manifestOnly = false) {
    if (!this._warmEnabled() || generation !== this._warmGeneration) return Promise.resolve();
    if (!this._warmManifests) this._warmManifests = new Map();
    const active = this._warmManifests.get(url);
    if (active) return active.promise;
    const ctl = new AbortController();
    const entry = { promise: null, chan, ctl };
    this._warmManifests.set(url, entry);
    if (!this._warmManifestOwners) this._warmManifestOwners = new Map();
    boundedSet(this._warmManifestOwners, url, chan, CFG.prefetchCacheMax);
    const timer = setTimeout(() => ctl.abort(), WARM_MANIFEST_TIMEOUT);
    entry.promise = Promise.resolve()
      .then(async () => {
        if (!this._warmEnabled() || generation !== this._warmGeneration) return;
        const response = await fetch(proxied(url), { cache: 'no-store', signal: ctl.signal });
        if (!this._warmEnabled() || ctl.signal.aborted || !response || response.ok === false) {
          cancelWarmBody(response && response.body);
          throw new Error('manifest unavailable');
        }
        const text = await response.text();
        checkWarmAbort(ctl, this._warmEnabled());
        clearTimeout(timer);
        if (manifestOnly || generation !== this._warmGeneration) return;
        let base = response.url || url;
        const resolved = new URL(base, url);
        if (resolved.pathname === '/__proxy__') base = resolved.searchParams.get('u') || url;
        return this._warmStartSegment(base, text, chan, generation, depth);
      })
      .catch(() => {
        if (generation === this._warmGeneration) this._warmNote('m', chan);
      })
      .finally(() => {
        clearTimeout(timer);
        ctl.abort();
        if (this._warmManifests.get(url) === entry) this._warmManifests.delete(url);
      });
    return entry.promise;
  }

  // 暂停新的预热任务，不取消当前台可能复用的在途片。
  holdWarm() {
    this._warmHold = true;
  }

  // 只计算包含播放头的连续区间，不能拿最后一段 end 跨过缓冲空洞算余量。
  // 原生管线未暴露 buffered 时保守返回 0，不用 seekable 或直播延迟冒充已下载缓冲。
  _bufferAhead() {
    try {
      const pos = this.video.currentTime;
      const ranges = this.video.buffered;
      if (!Number.isFinite(pos) || !ranges) return 0;
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= pos && pos < ranges.end(i)) return ranges.end(i) - pos;
      }
    } catch (e) {}
    return 0;
  }

  _recordFragLoad(data) {
    const frag = data && data.frag;
    // 只用主媒体片；音频/字幕/initSegment 的小请求不能把安全余量冲低。
    if (!frag || frag.type !== 'main' || !Number.isFinite(frag.sn)) return;
    if (Number.isFinite(frag.duration) && frag.duration > 0) this._fragDuration = frag.duration;
    const stats = data.stats || frag.stats;
    const load = stats && stats.loading;
    if (load && Number.isFinite(load.start) && Number.isFinite(load.end) && load.end > load.start) {
      // 缓存加载器会回填该片原下载耗时：这里保守采用，不把命中当成网络无限快。
      const sec = (load.end - load.start) / 1000;
      this._fragLoadSec = Math.max(sec, this._fragLoadSec * CFG.warmSafety.downloadDecay);
    }
  }

  _warmThresholds() {
    const tune = this._warmTuning;
    let resume = tune.prefetchStartBuffer;
    let hold = tune.prefetchHoldBuffer;
    if (tune.prefetchAdaptive) {
      const cfg = CFG.warmSafety;
      const target = (this.hls && this.hls.config.maxBufferLength) || CFG.hls.maxBufferLength;
      const segment = Math.min(this._fragDuration * cfg.segmentFactor, target * cfg.targetFraction);
      resume = Math.max(resume, segment, this._fragLoadSec * cfg.downloadFactor + cfg.downloadSlack);
      hold = Math.max(hold, resume / 2);
    }
    return { resume, hold };
  }

  applyWarmTuning(tuning) {
    this._warmTuning = tuning;
    this.holdWarm();
    this._pumpWarm();
  }

  getWarmBufferStatus() {
    if (!this.current) return null;
    return {
      ...this._warmThresholds(),
      ahead: this._bufferAhead() / Math.max(1, this.video.playbackRate || 1)
    };
  }

  _updateWarmGate() {
    if (!this._warmEnabled()) {
      this._abortWarm(null);
      return false;
    }
    const v = this.video;
    const limits = this._warmThresholds();
    const ahead = this._bufferAhead() / Math.max(1, v.playbackRate || 1);
    const playable = this.current && this.mode === 'live' && this._warmPlaying &&
      !v.paused && !v.ended && !v.seeking && !v.error && v.readyState >= 3;
    const hold = !playable || (this._warmHold ? ahead < limits.resume : ahead < limits.hold);
    if (hold !== this._warmHold) {
      this._warmHold = hold;
      this._logBuffer(hold ? 'warm-hold' : 'warm-resume');
    }
    return !hold;
  }

  // 只在 playing/waiting 或闸门状态变化时输出，不逐帧刷日志，不记录含凭据的播放 URL。
  _logBuffer(event) {
    if (!this.current) return;
    const limits = this._warmThresholds();
    const channel = this.current.channel || {};
    try {
      console.log('[buffer] ' + JSON.stringify({
        event,
        channel: channel.name || '',
        generation: this._warmGeneration,
        path: this.activePath(),
        position: Number((this.video.currentTime || 0).toFixed(2)),
        ahead: Number(this._bufferAhead().toFixed(2)),
        resume: Number(limits.resume.toFixed(2)),
        hold: Number(limits.hold.toFixed(2)),
        fragLoad: Number(this._fragLoadSec.toFixed(2)),
        warm: this._warming ? (this._warmChan === this.current.url ? 'current' : 'neighbour') : 'none',
        queued: this._warmQ ? this._warmQ.length : 0
      }));
    } catch (e) {}
  }

  // 从清单里挑出「hls.js 起播真正会请求的那一个分片」并预热。遇 master 清单递归一层。
  //
  // 原先这里热的是清单里的第一个分片——那是直播窗口里最老的一片，而 hls.js 的起播点是
  // 「最后一片的 start − liveSyncDuration」再向下对齐到分片头部（liveSyncDuration=22、
  // 片长 10s 的源落在倒数第 3 片）。也就是说以前热的那一片 hls.js 根本不会请求，白热一场。
  // chan 是这一轮预热对应的频道地址（始终是最初传给 prefetch 的那个，递归时原样带下去）。
  // 有了它，预热结局才能按频道分开记——否则两个邻台共用一个字母，
  // 角标上看到的可能是另一个方向的结局，等于没有诊断价值。
  _warmStartSegment(manifestUrl, text, chan, generation, depth = 0) {
    if (!this._warmEnabled() || generation !== this._warmGeneration || !this.current || this.mode !== 'live') return;
    if (!text) {
      this._warmNote('m', chan); // 清单是空的
      return;
    }
    try {
      const segs = [];
      let dur = 0;
      let vod = false;
      for (const line of text.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        if (s[0] === '#') {
          if (s.indexOf('#EXTINF:') === 0) dur = parseFloat(s.slice(8)) || 0;
          else if (s.indexOf('#EXT-X-ENDLIST') === 0) vod = true; // 回看/点播：从头起播
          continue;
        }
        segs.push({ uri: s, dur });
        dur = 0;
      }
      if (!segs.length) {
        this._warmNote('q', chan); // 清单里一条分片都解不出来
        return;
      }
      const first = resolveMediaUrl(segs[0].uri, manifestUrl);
      // 子清单（master playlist）：递归再热一层，取到真正的分片。
      // 这一层的 promise 必须交回去：调用方靠它判断「这个台排完队了」，
      // 不交回去的话清单要两跳的台会被当成已排完，另一个方向抢先插到它前面。
      if (/\.m3u8(\?|$)/i.test(first)) {
        if (depth >= 1 || first === manifestUrl) return;
        boundedSet(this._prefetched, first, Date.now(), CFG.prefetchCacheMax);
        return this._fetchWarmManifest(first, chan, generation, depth + 1);
      }
      const target = this._warmTargets.get(chan);
      if (target) {
        const duration = Math.max(...segs.map((seg) => seg.dur));
        target.interval = Math.max(WARM_REDO_MS, Math.min(WARM_JOB_TTL, duration * 1000));
        target.once = vod;
      }
      const idx = vod ? 0 : this._startSegIndex(segs);
      // 从「起播片 + 偏移」开始连续取几片。
      //
      // 原因：直播清单一直在往前滑。预热是在「停在当前台 1.5 秒后」做的，而用户按下
      // CH+ 是几秒之后——那时清单边缘已经前进，hls.js 算出来的起播片也跟着往后挪。
      // 实测这个偏差稳定在 1~3 片、方向永远朝新，所以起点跳过 WARM_LEAD 片，
      // 把这几片对准偏差的实际落点，而不是对准「此刻」的起播片（那一片反而基本用不上）。
      // 末尾要留住：偏移后不能越过清单最后一片。
      const from = Math.min(idx + (vod ? 0 : WARM_LEAD), segs.length - 1);
      const urls = [];
      for (let i = from; i < segs.length && urls.length < WARM_SEG_MAX; i++) {
        urls.push(proxied(resolveMediaUrl(segs[i].uri, manifestUrl)));
      }
      try {
        console.log(
          '[warm] pick ' + (from + 1) + '/' + segs.length + ' of ' + manifestUrl + ' -> ' + JSON.stringify(urls)
        );
      } catch (e) {}
      this._queueWarm(urls, chan);
    } catch (e) {}
  }

  // 复现 hls.js 的起播落位：直播边缘 − liveSyncDuration，再向下对齐到所在分片头部。
  // startOnSegmentBoundary 关掉时起播点会落在片中间，但请求的仍是同一个分片，所以不必区分。
  //
  // 「边缘」必须是最后一片的**结束**时刻，不是它的开始时刻——hls.js 取的是
  // fragments[last].end（level-details.ts 的 fragmentEnd）。用开始时刻会让整个
  // 目标位置往前偏一整片，白白浪费掉连续预热覆盖的一格余量。
  _startSegIndex(segs) {
    const n = segs.length;
    if (n < 2) return 0;
    const starts = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      starts.push(acc);
      acc += segs[i].dur;
    }
    const edge = acc; // = starts[n-1] + segs[n-1].dur
    const goal = edge - (getTuning().liveSyncDuration || 0);
    for (let i = n - 1; i >= 0; i--) if (starts[i] <= goal) return i;
    return 0; // 回退量比整个窗口还长：落在最老那一片
  }

  // 预热排队：一次只拉一片。几片同时拉会把当前台的带宽挤没，反而更卡。
  // （「一片」内部会拆成几条 Range 连接并行下，见 _warmOne——那是为了让这一片
  //  尽快下完好腾出带宽，与「同时拉多片」是两回事：并行的段拼完就结束，
  //  而同时拉多片会让好几片都长时间半成品地占着线路。）
  //
  // 上限（prefetchSegmentBytes）是「单片」上限，不是一个频道的总额度。
  // 曾经按总额度分摊过，结果是致命的：这批源单片 5~6MB，8MB 额度下第一片一存就没钱了，
  // 连续预热塌回成只热一片——而实测起播要的往往正是第二片（只差 1 片就落空）。
  // 片数是命中率的命门，宁可多花流量也不能牺牲覆盖。
  _queueWarm(urls, chan) {
    if (!this._warmEnabled()) {
      this._abortWarm(null);
      return;
    }
    if (!urls || !urls.length) return;
    const cap = getTuning().prefetchSegmentBytes;
    // 容量要能同时装下两个邻台各 WARM_SEG_MAX 片，再留一格余量。
    // 装不下就会 LRU 挤掉先热的那个台，表现成「切过去缓存里根本没这个台」。
    // 再夹一道绝对上限，免得 4K 台把单片上限拉大时总容量线性膨胀到爆内存（见 WARM_TOTAL_MAX）。
    // 下限必须保住 cap：putSeg 里「单片大于总容量就不存」，夹完了也得装得下一整片。
    setSegBudget(
      Math.max(cap, Math.min(cap * (WARM_SEG_MAX * 2 + 1), WARM_TOTAL_MAX))
    );
    if (!this._warmQ) this._warmQ = [];
    // slot 是这一片在本频道内的序位，配合 _pumpWarm 的取法实现两个邻台交替下载：
    // 否则先入队的那个台会把 3 片全下完才轮到另一个台，头几秒里另一个方向完全是空的，
    // 而 CH+ 和 CH- 的概率是一样的。
    // at 是入队时刻，排队排到一半就过期的任务要丢掉，不然只是白占带宽。
    const at = Date.now();
    const queued = this._warmQ.length;
    urls.forEach((url, slot) => {
      if (hasSeg(url) || pendingSeg(url) || this._warmQ.some((job) => job.url === url)) return;
      this._warmQ.push({ url, cap, at, slot, chan });
    });
    // 先记成「排进队了、还没轮到下」。真开始下之后会被 k/b/e/a 覆盖掉。
    // 没有这一步的话，「排队中就被换台清空」这种情况一个字母都记不到，
    // 角标上只能显示 w?，看不出是压根没排队还是排了没轮到——两者的处置完全不同。
    if (this._warmQ.length > queued) this._warmNote('0', chan);
    this._pumpWarm();
  }

  // 记下最近一次预热尝试的结局，换台后显示在角标上（见 warmStatus）。
  // 缓存里一片都没有时，只有这个字母能说明卡在哪一步——否则 ✕0 背后有四五种
  // 完全不同的原因（地址不是 m3u8 / 走了原生解码 / 分片超额度 / 请求被拒），只能靠猜。
  _warmNote(code, chan) {
    this._note = code;
    if (!chan) return;
    // 按频道分开记：两个邻台同时在热，共用一个字母的话，切过去看到的可能是
    // 另一个方向的结局——那比没有诊断更糟，会把人带到错的方向上。
    if (!this._warmNotes) this._warmNotes = new Map();
    boundedSet(this._warmNotes, chan, code, CFG.prefetchCacheMax);
  }

  _noteOf(chan) {
    return (chan && this._warmNotes && this._warmNotes.get(chan)) || '';
  }

  // 换台时掐掉在途预热：新频道的首片下载优先级最高，不能被后台预热分走带宽。
  //
  // 唯一的例外是「正在下的那一片恰好属于要切过去的台」：那片已经下了一大半，
  // 掐掉就是扔了重来（实测单片要 2.4 秒，而停留常只有 2~4 秒，撞上的概率很高）。
  // 留着它，分片加载器会等它下完直接用（见 fragCache 的 pending）。
  // 排队中还没开始下的一律丢掉——那些片 hls.js 自己顺着往下拉就行，留着只会抢带宽。
  _abortWarm(keepChan) {
    this._warmGeneration++;
    this._warmTargets.clear();
    this._warmRefresh = null;
    this._warmPlaying = false;
    this.holdWarm();
    this._fragDuration = 0;
    this._fragLoadSec = 0;
    this._bufferEvent = '';
    // 已作废的清单/未执行队列不算「最近热过」；快速 A→C 时仍应能重新预热 B。
    const enabled = this._warmEnabled();
    const keepWarm = enabled && keepChan && this._warmChan === keepChan;
    if (!enabled) {
      setSegBudget(0);
      this._warmHeld = 0;
      this._prefetched.clear();
      if (this._warmManifestOwners) this._warmManifestOwners.clear();
    }
    const cancelled = new Set();
    if (this._warmManifests) {
      for (const entry of this._warmManifests.values()) {
        cancelled.add(entry.chan);
        entry.ctl.abort();
      }
      this._warmManifests.clear();
    }
    if (this._warmQ) {
      for (const job of this._warmQ) cancelled.add(job.chan);
      this._warmQ.length = 0;
    }
    if (this._warmCtl && !keepWarm) cancelled.add(this._warmChan);
    if (this._prefetched) {
      for (const chan of cancelled) this._prefetched.delete(chan);
      // master 的子清单也要解除冷却，否则根清单虽重拉了，仍会在子清单处被拦掉。
      if (this._warmManifestOwners) {
        for (const [url, chan] of this._warmManifestOwners) {
          if (!cancelled.has(chan)) continue;
          this._prefetched.delete(url);
          this._warmManifestOwners.delete(url);
        }
      }
    }
    if (this._warmCtl && !keepWarm) {
      try { this._warmCtl.abort(); } catch (e) {}
      this._warmCtl = null;
      this._warming = false;
    }
  }

  // 从队列里挑 slot 最小的那一片：两个邻台各自的第 1 片会排在各自第 2 片之前，
  // 于是变成 A1 B1 A2 B2 A3 B3 的交替顺序，两个方向都能尽早有货。
  // 同 slot 取先入队的，新一轮的第 1 片也会自然插到上一轮的尾巴前面（新的更有用）。
  _takeWarmJob() {
    const q = this._warmQ;
    if (!q || !q.length) return null;
    let pick = 0;
    for (let i = 1; i < q.length; i++) if (q[i].slot < q[pick].slot) pick = i;
    return q.splice(pick, 1)[0];
  }

  _pumpWarm() {
    // 即便有在途任务，也更新低水位状态；完成后不能直接启动下一片抢带宽。
    if (!this._updateWarmGate() || this._warming || this._warmRefresh) return;
    const now = Date.now();
    this._warmQ = (this._warmQ || []).filter((job) => {
      if (now - job.at <= WARM_JOB_TTL) return true;
      const target = this._warmTargets.get(job.chan);
      if (target) target.nextAt = 0;
      else this._warmTargets.set(job.chan, { nextAt: 0, interval: WARM_REDO_MS });
      return false;
    });
    this._refreshWarmTargets();
    if (this._warmRefresh) return;
    const job = this._takeWarmJob();
    if (!job) return;
    const cap = job.cap;
    this._warming = true;
    this._warmChan = job.chan; // 换台时据此判断「在途这片是不是目标台的」，见 _abortWarm
    let ctl = null;
    try { ctl = new AbortController(); } catch (e) {}
    this._warmCtl = ctl;
    // 记成「正在下」，但不覆盖已经存进去的 k（held 是全局片数，分不清哪个台存的，
    // 只有这个字母能说明这个台自己走到哪一步）。
    // 有了它，w0 才拆成两种处境完全不同的情形：
    //   w0 排进队了、一片都没轮到开始下 → 时间墙，只能靠排序和减片数
    //   wr 换台那刻正在下这个台的片 → 被 _abortWarm 特意留着了，加载器可能正在等它
    if (this._noteOf(job.chan) === '0') this._warmNote('r', job.chan);
    // 预热自己的超时：卡住的请求必须放弃，否则整条队列永久堵在这一片上
    const watchdog = setTimeout(() => {
      try { console.log('[warm] timeout ' + job.url); } catch (e) {}
      try { if (ctl) ctl.abort(); } catch (e) {}
    }, WARM_LOAD_TIMEOUT);
    // 只在自己还是当前那一个的时候才收尾：被 _abortWarm 掐掉后，
    // 迟到的回调不能去清掉后来者的控制器、也不该再去拉下一个。
    const done = () => {
      clearTimeout(watchdog);
      if (this._warmCtl !== ctl) return;
      this._warming = false;
      this._warmCtl = null;
      this._pumpWarm();
    };
    const t0 = Date.now();
    try {
      // 整条链登记成「这一片正在下」：换台时若 hls.js 正要这一片，
      // 分片加载器会等这条链结束再取，而不是另发一次重复请求。
      // 链尾有 .catch，所以无论成败都会 resolve —— 等它的那一方不会被永久挂住。
      const chain = this._warmOne(job, ctl, cap)
        .then((buf) => {
          // 即使底层忽略 abort 并迟到成功，也不能把已作废的片写进重新开启后的缓存。
          checkWarmAbort(ctl, this._warmEnabled());
          if (this._warmCtl !== ctl) { done(); return; }
          if (buf && buf.byteLength && buf.byteLength <= cap) {
            const ms = Date.now() - t0;
            putSeg(job.url, buf, ms);
            // 只用第一片校准「预热单片要多久」：只有它和自己下一片同路数（见 _warmOne），
            // 拿后续的半路数片去记会把估值抬高一倍，waitBudget 就会误判「它还剩很多」。
            if (job.slot === 0) noteWarmMs(ms);
            this._warmNote('k', job.chan); // 存进去了
            try { console.log('[warm] stored ' + buf.byteLength + 'B ' + job.url); } catch (e) {}
          } else {
            // 这一片超上限就跳过它，但同频道后面的片照旧要试：片长不均时
            // 大的那片超了不代表下一片也超，而少存一片就可能整次落空。
            if (this._noteOf(job.chan) !== 'e') this._warmNote('b', job.chan); // 超上限
            try { console.log('[warm] skip (over cap) ' + job.url); } catch (e) {}
          }
          done();
        })
        .catch(() => {
          // 被自己 abort 的和被服务器拒的必须分开记：前者是「换台时我把在途的那片扔了」，
          // 后者才是真的请求失败。混成一个字母会把诊断带到完全错误的方向上。
          // g 是第三种：加载器算过账、决定自己下而把它掐了（见下面的 setPending），
          // 那已经记过了，别在这里覆盖成 a——两者的处置完全不同。
          if (this._noteOf(job.chan) !== 'g') {
            this._warmNote(ctl && ctl.signal && ctl.signal.aborted ? 'a' : 'e', job.chan);
          }
          done();
        });
      // 一并交出「什么时候开始下的」和掐掉它的手柄：加载器要靠开始时刻估算它还剩多少，
      // 判定不值得等就掐掉它自己下（见 fragCache 的 waitBudget）。
      setPending(job.url, chain, {
        startedAt: t0,
        abort: () => {
          // 只有「加载器决定自己下」这一条路会调到这里，记成 g 与换台让路（a）区分开
          this._warmNote('g', job.chan);
          try { if (ctl) ctl.abort(); } catch (e) {}
        }
      });
    } catch (e) {
      this._warmNote('e', job.chan);
      done();
    }
  }

  // 取一片预热数据：先试并行分段下载，不适用或失败再退回整片单连接下载。
  //
  // 预热为什么也要并行：实测预热失败的形态几乎全是「来不及」——排进队了没轮到下（w0）、
  // 换台那刻正在下被掐掉（wa）。单连接一片要 3 秒，两个方向各 2 片就是 12 秒，
  // 而在一个台上通常只停 2~4 秒，所以基本热不完。并行把单片压到 1 秒上下，
  // 4 秒就能热完，命中率才有可能上来。而命中一次就等于首片耗时直接归零。
  //
  // resolve 出 ArrayBuffer，或 null 表示「不该存」（超上限 / 服务器拒了）；
  // 这两种情形的诊断字母由调用方按 _warmNote 已有的规则区分。
  async _warmOne(job, ctl, cap) {
    checkWarmAbort(ctl, this._warmEnabled());
    // 每个台的第一片保留满路数，后续片减半，以保留预热命中速度。
    // 前提是 _pumpWarm 已确认当前台的实际缓冲安全；出画面本身并不代表线路有余量。
    // 下载中若缓冲变薄，会停止启动新预热任务，不把在途片反复取消重下。
    const lanes = job.slot === 0 ? rangeLanes() : warmLanes();
    const rj = rangeLoad(job.url, WARM_LOAD_TIMEOUT, {
      lanes,
      maxBytes: cap,
      signal: ctl && ctl.signal, // 换台让路：_abortWarm 掐 ctl，这一组段跟着停
      tag: job.slot === 0 ? 'warm-range-1st' : 'warm-range' // 与播放路径的日志分开，两者要对比着看
    });
    if (!rj) return this._warmWhole(job, ctl, cap);
    const res = await rj.promise;
    checkWarmAbort(ctl, this._warmEnabled());
    if (res && res.buf) return res.buf;
    if (res && res.overCap) {
      try { console.log('[warm] skip size >= ' + res.total + 'B > cap ' + cap + 'B ' + job.url); } catch (e) {}
      return null;
    }
    return this._warmWhole(job, ctl, cap);
  }

  async _warmWhole(job, ctl, cap) {
    checkWarmAbort(ctl, this._warmEnabled());
    const res = await fetch(job.url, ctl ? { signal: ctl.signal } : undefined);
    const enabled = this._warmEnabled();
    if (!enabled || (ctl && ctl.signal.aborted)) {
      cancelWarmBody(res && res.body);
      checkWarmAbort(ctl, enabled);
    }
    if (!res || !res.ok) {
      cancelWarmBody(res && res.body);
      this._warmNote('e', job.chan);
      return null;
    }
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (len > cap) {
      try { console.log('[warm] skip ' + len + 'B > cap ' + cap + 'B ' + job.url); } catch (e) {}
      cancelWarmBody(res.body);
      return null;
    }
    // 无流接口时无法保证容量上限，不能先 arrayBuffer 再检查。
    if (!res.body || !res.body.getReader) {
      cancelWarmBody(res.body);
      this._warmNote('e', job.chan);
      return null;
    }
    return readCapped(res.body.getReader(), cap, ctl, () => this._warmEnabled());
  }

  // 本次起播的预热情况，给网速角标显示：
  //   { hit: true }                   → 起播片是从缓存直接喂进去的（角标画闪电）
  //   { hit: false, held: 3, note }   → 存了 3 片但 hls.js 一片都没要，note 说明是哪种对不上：
  //     x 只有查询串不同（缓存键已经会自动去掉 .ts 后面的 token，走到这里说明路径本身
  //       不带扩展名、查询串可能才是真正的片号，不能贸然忽略）
  //     s 目录同、序号不同（缓存里没有一片落在这个台的清单窗口内）
  //     w 连目录都不同（缓存里根本没有这个台）
  //   { hit: false, held: 0, note }   → 缓存里空的，note 说明卡在预热的哪一步：
  //     v 走的原生解码，不经过 hls.js   n 频道地址不是 m3u8
  //     m 清单没拉到                   q 清单解不出分片
  //     b 分片超过额度（高码率台）      e 分片请求被拒/失败
  //     k 明明存进去了（说明是被 TTL 过期或 LRU 挤掉了）
  //     空 = 预热压根没触发（停留不到 1.5 秒，或换的不是相邻台）
  // 没有这个区分，「预热没效果」只能靠猜。
  warmStatus() {
    const held = this._warmHeld || 0;
    let note = held ? missNote() : this._note || '';
    // w = 缓存里没有一片属于这个台。后缀说明这个台自己的预热走到哪一步了：
    //   w-  压根没排进预热（连按翻台时落到隔了两个的台）→ 固有限制，无从修
    //   w0  排进队了但一片都没轮到开始下，就被换台清空了 → 停留时间不够，见下
    //   wr  换台那刻它的片正在下，被特意留着让加载器等（有界等待，见 fragCache）
    //   wg  它的片正在下，但加载器算过账觉得不值得等，掐掉自己下了（见 waitBudget）
    //   wa  换台那刻它的片正在下，被我自己 abort 掉了
    //   we  请求被服务器拒了（403/连接数限制…）
    //   wb  每一片都超单片上限 → 额度往大调
    //   wk  下载成功存进去了却对不上 → 说明同一个台两次拿到的路径不一样
    //   wm  连清单都没拉到
    //
    // w0 是时间墙，不是 bug：单片 5MB ÷ 实测 2.1MB/s ≈ 2.4 秒，两个邻台串行下，
    // 先排的那个约 2.6 秒就绪、后排的约 5 秒。停留短于这个数就必然是 w0。
    // 能做的只有让「更可能去的那个方向」排在前面（见 main.js 的 lastZapDir）。
    //
    // wr 要盯着看：它意味着首片可能等过在途的预热片。等不等、等多久由 waitBudget
    // 按「它还剩多少 vs 自己下一遍多久」算出来（见 fragCache），
    // 所以 wr/wg 伴随首片明显偏慢时，要核对那两个滚动平均是不是偏得离谱
    // （日志里 `[warm] in flight ... warm~ own~` 那一行）。
    if (held && note.charAt(0) === 'w') {
      note += this._wasWarmed(this._rawUrl) ? this._noteOf(this._rawUrl) || '?' : '-';
    }
    return {
      hit: segHits() > 0,
      held,
      note,
      // 起播对齐的结局。电视上取不到控制台日志，这一项必须上屏——
      // s±N 只说明「差了几片」，而修法完全取决于对齐卡在哪一步：
      //   nowin 预热片不在清单窗口内 → 清单滑走了，属于时间墙
      //   ok    对齐算出了位置却仍未命中 → hls.js 把落位改回去了，是代码问题
      //   nodet 拿不到分片列表（多码率源的补齐没赶上）
      //   old   找到了但太旧，被 ALIGN_LAG_SEG 挡掉
      //   off   预热额度是 0（功能没开）
      //   空    压根没跑到对齐（走了原生解码，或换台被中断）
      align: this._alignNote || '',
      // 对齐报 nowin 时的清单窗口与缓存号段：它才能分出「真滑出去了」
      // 和「号在窗口内却没匹配上」——后者是缓存键的 bug，修法与前者完全相反
      win: this._alignWin || null,
      // 两个片号：差值的来源，用来核对上面的判断是否成立
      seg: missDetail(),
      // 「等不等在途预热片」的现场账。这一项优先级高于 align：
      // 预热片还在下的路上就被换台赶上、然后被算账取消，跟对齐准不准是两回事，
      // 而前者才是起播耗时的真正去向（首片那几秒就是重下同一片的代价）。
      wait: waitDiag()
    };
  }

  // 这个频道地址最近有没有排进过预热。_prefetched 记的就是「热过谁、什么时候」，
  // 时间窗放宽到一分钟：换台后重热的是新的邻台，当前台的记录只会是换台之前留下的。
  _wasWarmed(rawUrl) {
    if (!rawUrl || !this._prefetched) return false;
    const t = this._prefetched.get(rawUrl);
    return !!t && Date.now() - t < 60000;
  }

  // 播放直播
  playLive(channel, decoder = 'auto') {
    this.mode = 'live';
    this.current = { channel, programme: null, url: channel.url };
    this._load(channel.url, decoder);
  }

  // 播放回看
  playCatchup(channel, programme, url, decoder = 'auto') {
    this.mode = 'catchup';
    this.current = { channel, programme, url };
    this._load(url, decoder);
  }

  isCatchup() {
    return this.mode === 'catchup';
  }

  // 回看清单该不该封口，以及这个节目按 EPG 应该有多长（秒）。
  // 直播返回 null：直播清单本来就应该一直往后长，封了口就播到窗口末尾停住。
  // hls.js 实例是跳着台复用的，所以这个判断必须每次加载现算，不能在建实例时定下来。
  _vodExpect() {
    if (this.mode !== 'catchup') return null;
    const p = this.current && this.current.programme;
    const dur = p && p.stop && p.start ? (p.stop - p.start) / 1000 : 0;
    return { dur };
  }

  // 快进/快退（秒）
  seek(deltaSec) {
    if (!isFinite(this.video.duration) && this.mode === 'live') return;
    try {
      this.video.currentTime = Math.max(0, this.video.currentTime + deltaSec);
    } catch (e) {}
  }

  // 当前这一路实际用的解码方式（'hls' | 'native' | ''）。
  // 调参面板要靠它提示用户：hls.js 的参数在原生路径下一点作用都没有。
  activePath() {
    return this._activePath || '';
  }

  // 调参有变更。hls.js 的配置只在 new Hls() 时读一次，所以这里只打标记，
  // 下次 _load 时销毁重建实例让新配置生效（不能就地改 hls.config，很多控制器
  // 在构造时就把值拷走了，改了也不会重新读）。
  markTuningDirty() {
    this._tuningDirty = true;
  }

  setAspect(aspect) {
    this.video.classList.remove('aspect-fill', 'aspect-43');
    if (aspect === 'fill') this.video.classList.add('aspect-fill');
    else if (aspect === '4:3') this.video.classList.add('aspect-43');
  }

  stop() {
    this._abortWarm(null);
    this._destroyHls();
    // 清掉当前流的记录：外部靠 player.current 判断「这一路是否还在播」，
    // 停了还留着会让「重播同一个频道」被当成无需动作而短路掉。
    this.current = null;
    this._activePath = '';
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch (e) {}
  }
}
