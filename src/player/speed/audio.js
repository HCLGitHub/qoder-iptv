// 倍速时的声音：自己解码（AAC 走 WebCodecs / decodeAudioData，MP2 走自带的 JS 解码器）
// → WSOLA 变速不变调 → Web Audio 按视频时钟排期。
//
// 视频那边靠改 timescale 让解码器「以为」自己在 1× 播，媒体时钟（原始 currentTime）照常 1 秒走 1 秒；
// 内容时间 = 媒体时间 × speed。声音这边只要保证：
//   某一刻听到的内容位置 == 同一刻画面的内容位置。
// 电视上 currentTime 不是连续的（实测一格 60ms 左右跳一次），直接拿来对时会抖，
// 所以取最近半秒「媒体时间 - 音频时钟」的最大值当偏移估计，再用小步挪 WSOLA 读点的方式慢慢追。
import { PcmStore, Wsola } from './pcm.js';
import { adtsHeader } from './isobmff.js';
import { Mp2Decoder, parseMpegHeader } from './mp2.js';

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

let sharedCtx = null;

/** 全应用共用一个 AudioContext：电视上开多个容易被系统拒，也没必要 */
export function getAudioContext() {
  if (sharedCtx) return sharedCtx;
  const C = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!C) return null;
  try {
    sharedCtx = new C({ latencyHint: 'playback' });
  } catch (e) {
    try {
      sharedCtx = new C();
    } catch (e2) {
      sharedCtx = null;
    }
  }
  return sharedCtx;
}

/** 在按键回调里同步调一次：浏览器要求音频上下文由用户手势唤醒 */
export function primeAudio() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/**
 * 本机能走哪条解码路：
 *   webcodecs   = AudioDecoder（Chromium 94+，即 webOS 23 起）
 *   decodeaudio = 老内核兜底：每片补 ADTS 头整片 decodeAudioData
 */
export async function detectAudioPath() {
  if (typeof window === 'undefined' || !(window.AudioContext || window.webkitAudioContext)) {
    return { ok: false, reason: 'no-webaudio' };
  }
  if (typeof window.AudioDecoder === 'function' && typeof window.EncodedAudioChunk === 'function') {
    try {
      const r = await window.AudioDecoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: 44100,
        numberOfChannels: 2
      });
      if (r && r.supported) return { ok: true, path: 'webcodecs' };
    } catch (e) {}
  }
  return { ok: true, path: 'decodeaudio' };
}

function decodeAudio(ctx, ab) {
  return new Promise((resolve, reject) => {
    // 老 webkit 只认回调式；新内核两种都支持，回调式最稳
    const p = ctx.decodeAudioData(ab, resolve, reject);
    if (p && p.catch) p.catch(reject);
  });
}

/** AudioData → 每声道一条 Float32Array。老内核 copyTo 不支持格式转换，按原格式取了自己换 */
function copyPlanes(ad) {
  const n = ad.numberOfFrames;
  const ch = ad.numberOfChannels;
  const out = [];
  try {
    for (let c = 0; c < ch; c++) {
      const f = new Float32Array(n);
      ad.copyTo(f, { planeIndex: c, format: 'f32-planar' });
      out.push(f);
    }
    return out;
  } catch (e) {
    out.length = 0;
  }
  const fmt = String(ad.format || 'f32');
  const planar = fmt.indexOf('planar') > 0;
  const kind = fmt.slice(0, 3);
  const Ctor = kind === 's16' ? Int16Array : kind === 's32' ? Int32Array : kind === 'u8' || kind === 'u8-' ? Uint8Array : Float32Array;
  const conv = (v) =>
    kind === 's16' ? v / 32768 : kind === 's32' ? v / 2147483648 : Ctor === Uint8Array ? (v - 128) / 128 : v;
  if (planar) {
    for (let c = 0; c < ch; c++) {
      const raw = new Ctor(n);
      ad.copyTo(raw, { planeIndex: c });
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = conv(raw[i]);
      out.push(f);
    }
    return out;
  }
  const raw = new Ctor(n * ch);
  ad.copyTo(raw, { planeIndex: 0 });
  for (let c = 0; c < ch; c++) {
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = conv(raw[i * ch + c]);
    out.push(f);
  }
  return out;
}

const TICK_MS = 50;
const AHEAD = 0.35; // 往前排多少秒的声音
const HOPS = 4; // 每个 AudioBuffer 装几跳（约 80ms）
const MP2_SLICE_MS = 8; // JS 解 MP2 每次最多占主线程多久，剩下的让出去下一拍接着解
const MP2_BAD_JOBS = 3; // 连着几批大半是坏帧就认定解不了

export class AudioPipeline {
  /**
   * @param {object} o
   * @param {HTMLMediaElement} o.video
   * @param {number} o.speed
   * @param {'webcodecs'|'decodeaudio'} o.path
   * @param {() => number} o.realTime 原始媒体时间（未换算）
   * @param {(reason:string) => void} [o.onFail]
   * @param {(a:number, b:number) => void} [o.onEvict] 内存兜底丢了一段，通知伪 SourceBuffer 同步 buffered
   */
  constructor(o) {
    this.video = o.video;
    this.S = o.speed;
    this.path = o.path;
    this.realTime = o.realTime;
    this.onFail = o.onFail || null;
    this.onEvict = o.onEvict || null;
    this.ctx = getAudioContext();
    this.store = new PcmStore();
    this.wsola = new Wsola(this.store, this.S);
    this.info = null;
    this.dec = null;
    this.cfgKey = '';
    this._tail = null;
    this.running = false;
    this.nodes = [];
    this.gain = null;
    this.nextWhen = 0;
    this.offs = [];
    this.hist = [];
    this._stalled = false;
    this.dead = false;
    this.mp2 = null;
    this._mpQ = [];
    this._mpTimer = 0;
    this._mpNext = null;
    this._mpBad = 0;
    this.stats = { path: o.path, decoded: 0, decErrors: 0, restarts: 0, underruns: 0, drift: 0, measured: 0, played: 0 };

    const halt = () => this._halt(true);
    this._ev = {
      seeking: halt,
      pause: halt,
      waiting: () => {
        this._stalled = true;
        this._halt(true);
      },
      playing: () => {
        this._stalled = false;
      }
    };
    for (const k in this._ev) this.video.addEventListener(k, this._ev[k]);
    this._timer = setInterval(() => this._tick(), TICK_MS);
  }

  /* ---------------- 解码 ---------------- */

  setInit(info) {
    this.info = info;
    const key = [info.codec, info.sampleRate, info.channels, Array.prototype.join.call(info.asc || [], ',')].join('|');
    if (key === this.cfgKey) return;
    this.cfgKey = key;
    this._closeDecoder();
    this._clearMpeg();
    this._tail = null;
    this.stats.path = info.codec === 'mpeg' ? 'mp2' : this.path;
  }

  /** 收一批样本；t/d 是轨道刻度，offset 是 SourceBuffer.timestampOffset（秒） */
  push(samples, timescale, offset) {
    if (this.dead || !this.info || !samples.length || !timescale) return;
    if (this.info.codec === 'mpeg') this._queueMpeg(samples, timescale, offset);
    else if (this.path === 'webcodecs') this._decodeWebCodecs(samples, timescale, offset);
    else this._decodeAdts(samples, timescale, offset);
  }

  remove(a, b) {
    this.store.removeSec(a, b);
    this._tail = null;
    const q = this._mpQ;
    const kept = q.filter((j) => {
      const mid = (j.t0 + j.t1) / 2;
      return mid < a || mid >= b;
    });
    if (kept.length !== q.length) {
      this._mpQ = kept;
      // 解到一半的那批可能被删了，下一批不能再接着它的滤波器状态
      this._mpNext = null;
    }
  }

  /* ---------------- MP2：主线程分片解码 ---------------- */

  _queueMpeg(samples, ts, off) {
    const h = parseMpegHeader(samples[0].data, 0);
    // MP3 / MPEG-2 低采样率这些自带解码器不管，回退 1×
    if (h && (h.version !== 3 || h.layer !== 2)) {
      if (this.onFail) this.onFail('audio-codec');
      return;
    }
    const last = samples[samples.length - 1];
    this._mpQ.push({ t0: samples[0].t / ts + off, t1: (last.t + last.d) / ts + off, samples, i: 0, planes: null, sr: 0, bad: 0 });
    if (!this._mpTimer) this._mpTimer = setTimeout(() => this._pumpMpeg(), 0);
  }

  _pumpMpeg() {
    this._mpTimer = 0;
    if (this.dead) return;
    const start = now();
    const q = this._mpQ;
    while (q.length && now() - start < MP2_SLICE_MS) {
      const job = q[0];
      if (!job.planes) this._startMpegJob(job);
      const dec = this.mp2;
      const [L, R] = job.planes;
      const n = job.samples.length;
      while (job.i < n) {
        if (!dec.decode(job.samples[job.i].data, L, R, job.i * 1152)) job.bad++;
        job.i++;
        if (now() - start >= MP2_SLICE_MS) break;
      }
      if (job.i < n) break;
      q.shift();
      this._finishMpegJob(job);
    }
    if (q.length && !this.dead) this._mpTimer = setTimeout(() => this._pumpMpeg(), 0);
  }

  _startMpegJob(job) {
    if (!this.mp2) this.mp2 = new Mp2Decoder();
    if (this._mpNext == null || Math.abs(job.t0 - this._mpNext) > 0.05) this.mp2.reset();
    this._mpNext = job.t1;
    const h = parseMpegHeader(job.samples[0].data, 0);
    job.sr = (h && h.sampleRate) || this.info.sampleRate || 48000;
    const n = job.samples.length * 1152;
    job.planes = [new Float32Array(n), new Float32Array(n)];
  }

  _finishMpegJob(job) {
    // 坏帧那段留着静音；大半是坏帧说明不是偶发丢包
    this.stats.decErrors += job.bad;
    if (job.bad * 2 > job.samples.length) {
      if (++this._mpBad >= MP2_BAD_JOBS && this.onFail) this.onFail('audio-decode');
      return;
    }
    this._mpBad = 0;
    this.store.insert(job.t0, job.planes, job.sr);
    this.stats.decoded += job.samples.length;
  }

  _clearMpeg() {
    this._mpQ = [];
    this._mpNext = null;
    this._mpBad = 0;
    if (this._mpTimer) clearTimeout(this._mpTimer);
    this._mpTimer = 0;
  }

  _decoder() {
    if (this.dec && this.dec.state !== 'closed') return this.dec;
    const info = this.info;
    const dec = new window.AudioDecoder({
      output: (ad) => this._onAudioData(ad),
      // 退役中的旧解码器出错不算数，也别连累新的
      error: (e) => {
        if (this.dec === dec) this._onDecodeError(e);
      }
    });
    dec.configure({
      codec: info.codec,
      sampleRate: info.sampleRate,
      numberOfChannels: info.channels,
      description: info.asc
    });
    this.dec = dec;
    return dec;
  }

  _decodeWebCodecs(samples, ts, off) {
    try {
      // Chromium 的 AAC 解码器只拿第一包的时间戳当基准，之后按解出的帧数往后累加：
      // 输入一跳（拖动、补片）它不认，输出会接着旧位置往下标，把新位置的声音写到旧位置上。
      // 所以一跳就换新解码器，旧的把已收的包解完再关。
      const t0 = samples[0].t / ts + off;
      if (this.dec && this._nextTs != null && Math.abs(t0 - this._nextTs) > 0.05) this._retireDecoder();
      const dec = this._decoder();
      for (const s of samples) {
        dec.decode(
          new window.EncodedAudioChunk({
            type: 'key',
            timestamp: Math.round((s.t / ts + off) * 1e6),
            duration: Math.round((s.d / ts) * 1e6),
            data: s.data
          })
        );
      }
      const last = samples[samples.length - 1];
      this._nextTs = (last.t + last.d) / ts + off;
    } catch (e) {
      this._onDecodeError(e);
    }
  }

  _retireDecoder() {
    const old = this.dec;
    this.dec = null;
    const close = () => {
      try {
        if (old.state !== 'closed') old.close();
      } catch (e) {}
    };
    try {
      if (old.state === 'configured') old.flush().then(close, close);
      else close();
    } catch (e) {
      close();
    }
  }

  _onAudioData(ad) {
    try {
      if (this.dead) return;
      const planes = copyPlanes(ad);
      this.store.insert(ad.timestamp / 1e6, planes, ad.sampleRate);
      this.stats.decoded++;
    } catch (e) {
      this._onDecodeError(e);
    } finally {
      try {
        ad.close();
      } catch (e) {}
    }
  }

  /**
   * 兜底解码：整片补 ADTS 头交给 decodeAudioData。
   * 每片单独解，解码器每次都从冷启动开始，片头会有一小截不准；
   * 所以接上前一片最后两帧当预滚，解完把这截丢掉，接缝处就不咔哒。
   */
  _decodeAdts(samples, ts, off) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = samples[0].t / ts + off;
    const last = samples[samples.length - 1];
    const t1 = (last.t + last.d) / ts + off;
    const tail = this._tail && Math.abs(this._tail.end - t0) < 0.03 ? this._tail.frames : [];
    const frames = tail.concat(samples.map((s) => ({ data: s.data, dur: s.d / ts })));
    const preSec = tail.reduce((a, f) => a + f.dur, 0);
    this._tail = { end: t1, frames: frames.slice(-2).map((f) => ({ data: f.data.slice(), dur: f.dur })) };
    let total = 0;
    for (const f of frames) total += 7 + f.data.length;
    const buf = new Uint8Array(total);
    let p = 0;
    for (const f of frames) {
      buf.set(adtsHeader(this.info, f.data.length), p);
      buf.set(f.data, p + 7);
      p += 7 + f.data.length;
    }
    decodeAudio(ctx, buf.buffer).then(
      (ab) => {
        if (this.dead) return;
        const sr = ab.sampleRate;
        const skip = Math.round(preSec * sr);
        const n = Math.max(0, Math.min(ab.length - skip, Math.round((t1 - t0) * sr)));
        if (!n) return;
        const planes = [];
        for (let c = 0; c < ab.numberOfChannels; c++) planes.push(ab.getChannelData(c).slice(skip, skip + n));
        this.store.insert(t0, planes, sr);
        this.stats.decoded++;
      },
      (e) => this._onDecodeError(e)
    );
  }

  _onDecodeError() {
    if (this.dead) return;
    this.stats.decErrors++;
    this._closeDecoder();
    // 偶发一两片坏数据能扛过去；连续失败说明这台机器/这条音轨解不了，交给上层回退 1×
    if (this.stats.decErrors >= 4 && this.onFail) this.onFail('audio-decode');
  }

  _closeDecoder() {
    this._nextTs = null;
    if (this.dec) {
      try {
        if (this.dec.state !== 'closed') this.dec.close();
      } catch (e) {}
      this.dec = null;
    }
  }

  /* ---------------- 排期 ---------------- */

  _latency() {
    const ctx = this.ctx;
    const l = (ctx && (ctx.outputLatency || ctx.baseLatency)) || 0;
    return l > 0 && l < 0.3 ? l : 0;
  }

  _tick() {
    if (this.dead) return;
    const ctx = this.ctx;
    const v = this.video;
    if (!ctx) return;
    const m = this.realTime();
    const live = !v.paused && !v.seeking && !v.ended && v.readyState >= 3 && !this._stalled;
    this._measure(live, m);
    this._evict(m);
    if (!live || !this.store.sr) {
      this._halt(true);
      return;
    }
    if (ctx.state !== 'running') {
      // 挂起时音频时钟不走，排了也不响；催一下，等它跑起来
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      this._halt(true);
      return;
    }
    const now = ctx.currentTime;
    this.offs.push(m - now);
    if (this.offs.length > 10) this.offs.shift();
    // 至少攒 200ms 再开：一两次采样碰上 currentTime 停在格子里，偏移会估低
    if (this.offs.length < 4) return;
    const est = Math.max.apply(null, this.offs);
    const lat = this._latency();
    if (!this.running) {
      this._begin(now, est, lat);
    } else {
      const sr = this.store.sr;
      // 下一块开播那一刻（再加输出延迟才被听到），画面应在的内容秒
      const want = (this.nextWhen + lat + est) * this.S;
      const drift = (this.wsola.pos / sr - want) / this.S; // 媒体秒；正＝声音超前
      this.stats.drift = drift;
      const starved = this.nextWhen < now + 0.005;
      if (starved || Math.abs(drift) > 0.25) {
        if (starved) this.stats.underruns++;
        this._halt(false);
        this._begin(now, est, lat);
      } else if (Math.abs(drift) > 0.03) {
        this.wsola.nudge(-drift * this.S * sr * 0.2);
      }
    }
    if (this.running) this._fill(now);
  }

  _begin(now, est, lat) {
    const ctx = this.ctx;
    const startAt = now + 0.08;
    const s = Math.round((startAt + lat + est) * this.S * this.store.sr);
    this.wsola.reset(s);
    if (!this.wsola.ready(HOPS)) return; // 这一段还没解出来，下一拍再试
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, startAt);
    g.gain.linearRampToValueAtTime(1, startAt + 0.03);
    g.connect(ctx.destination);
    this.gain = g;
    this.nextWhen = startAt;
    this.running = true;
    this.stats.restarts++;
  }

  _fill(now) {
    const ctx = this.ctx;
    const sr = this.store.sr;
    while (this.nextWhen - now < AHEAD) {
      const out = this.wsola.process(HOPS);
      if (!out) break;
      const len = out[0].length;
      const buf = ctx.createBuffer(out.length, len, sr);
      for (let c = 0; c < out.length; c++) {
        if (buf.copyToChannel) buf.copyToChannel(out[c], c);
        else buf.getChannelData(c).set(out[c]);
      }
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(this.gain);
      node.start(this.nextWhen);
      node.onended = () => {
        const i = this.nodes.indexOf(node);
        if (i >= 0) this.nodes.splice(i, 1);
      };
      this.nodes.push(node);
      this.nextWhen += len / sr;
      this.stats.played += len / sr;
    }
  }

  /** 停声：20ms 淡出防爆音。resetClock=暂停/拖动后时钟关系变了，偏移估计要重攒 */
  _halt(resetClock) {
    if (resetClock) this.offs = [];
    if (!this.running) return;
    this.running = false;
    const ctx = this.ctx;
    const g = this.gain;
    const t = ctx.currentTime;
    try {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + 0.02);
    } catch (e) {}
    for (const n of this.nodes) {
      try {
        n.stop(t + 0.03);
      } catch (e) {}
    }
    this.nodes = [];
    this.gain = null;
    setTimeout(() => {
      try {
        g.disconnect();
      } catch (e) {}
    }, 200);
  }

  /** 实测画面倍速：内容时间增量 / 墙钟，窗口 2~4 秒，卡顿/暂停时清零重来 */
  _measure(live, m) {
    if (!live) {
      this.hist = [];
      return;
    }
    const w = Date.now() / 1000;
    const h = this.hist;
    h.push([w, m * this.S]);
    while (h.length > 2 && w - h[0][0] > 4) h.shift();
    const span = w - h[0][0];
    if (span >= 2) this.stats.measured = (h[h.length - 1][1] - h[0][1]) / span;
  }

  /** 内存兜底：正常情况下 hls.js 的 backBuffer 清理会走 remove()；万一没走，超过 150 秒就自己丢旧的 */
  _evict(m) {
    if (this.store.seconds <= 150) return;
    const r = this.store.evictBefore(m * this.S - 20);
    if (r && this.onEvict) this.onEvict(r[0], r[1]);
  }

  destroy() {
    if (this.dead) return;
    this._halt(true);
    this.dead = true;
    clearInterval(this._timer);
    for (const k in this._ev) this.video.removeEventListener(k, this._ev[k]);
    this._closeDecoder();
    this._clearMpeg();
    this.store.reset();
  }
}
