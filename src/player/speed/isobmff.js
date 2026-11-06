// 倍速引擎用到的那一小撮 MP4（ISO BMFF）读写。
// hls.js 不管片源是 TS 还是 fMP4，喂给 SourceBuffer 的都是 fMP4：
//   init 段 = ftyp + moov，媒体段 = moof + mdat。
// 这里只做三件事：改视频 init 的时间刻度、读音频 init 的解码参数、把音频媒体段拆成一帧帧。

const CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, mvex: 1, moof: 1, traf: 1, edts: 1, dinf: 1 };

function u32(u8, p) {
  return ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
}

function w32(u8, p, v) {
  u8[p] = (v >>> 24) & 255;
  u8[p + 1] = (v >>> 16) & 255;
  u8[p + 2] = (v >>> 8) & 255;
  u8[p + 3] = v & 255;
}

function u64(u8, p) {
  return u32(u8, p) * 4294967296 + u32(u8, p + 4);
}

export function toU8(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

/** 平铺读一层 box。size 越界就停：残缺的尾巴交给调用方决定要不要留到下一次 append */
export function readBoxes(u8, start = 0, end = u8.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(u8, p);
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = u64(u8, p + 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, end: p + size, data: p + hdr });
    p += size;
  }
  return out;
}

function child(u8, box, type) {
  const list = readBoxes(u8, box.data, box.end);
  for (let i = 0; i < list.length; i++) if (list[i].type === type) return list[i];
  return null;
}

function children(u8, box, type) {
  return readBoxes(u8, box.data, box.end).filter((b) => b.type === type);
}

/** 按路径找 box，例如 ['moov','trak','mdia']；每一层都可能有多个，全收 */
function findPath(u8, boxes, path) {
  let cur = boxes;
  for (let i = 0; i < path.length; i++) {
    const next = [];
    for (const b of cur) {
      if (b.type !== path[i]) continue;
      if (i === path.length - 1) next.push(b);
      else if (CONTAINERS[b.type]) next.push(...readBoxes(u8, b.data, b.end));
    }
    cur = next;
  }
  return cur;
}

export function hasMoov(u8) {
  return readBoxes(u8).some((b) => b.type === 'moov');
}

function handlerOf(u8, mdia) {
  const h = child(u8, mdia, 'hdlr');
  if (!h) return '';
  const p = h.data + 8; // version/flags 4 + pre_defined 4
  return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
}

function mdhdTimescalePos(u8, mdhd) {
  const v = u8[mdhd.data];
  return mdhd.data + (v === 1 ? 20 : 12);
}

/**
 * 把视频轨 mdhd 的 timescale 乘以 speed。
 * 媒体段里的 tfdt、样本时长、合成偏移都是「刻度数」，刻度变密，
 * 同样的刻度数折成秒就变短——解码器照常按 1× 走，画面就快了 speed 倍。
 * 必须在副本上改：hls.js 会缓存 init 段，切档时原样再 append 一次，原地改会被乘两遍。
 * @returns {{data:Uint8Array, scale:number}|null} scale = 实际生效倍率；null = 没找到视频轨
 */
export function rewriteVideoInit(input, speed) {
  const src = toU8(input);
  const out = src.slice();
  const traks = findPath(out, readBoxes(out), ['moov', 'trak']);
  let scale = 0;
  for (const trak of traks) {
    const mdia = child(out, trak, 'mdia');
    if (!mdia) continue;
    const kind = handlerOf(out, mdia);
    if (kind === 'soun') continue;
    const mdhd = child(out, mdia, 'mdhd');
    if (!mdhd) continue;
    const pos = mdhdTimescalePos(out, mdhd);
    const ts = u32(out, pos);
    if (!ts) continue;
    const next = Math.round(ts * speed);
    if (next <= 0 || next > 0xffffffff) return null;
    w32(out, pos, next);
    scale = next / ts;
  }
  return scale ? { data: out, scale } : null;
}

/* ---------------- 音频 init ---------------- */

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** MPEG-4 描述符长度：每字节 7 位，最高位为 1 表示后面还有 */
function descLen(u8, p) {
  let len = 0;
  let n = 0;
  while (n < 4) {
    const b = u8[p + n];
    len = (len << 7) | (b & 0x7f);
    n++;
    if (!(b & 0x80)) break;
  }
  return { len, size: n };
}

function parseEsds(u8, esds) {
  let p = esds.data + 4;
  const end = esds.end;
  if (u8[p] !== 0x03) return null;
  let d = descLen(u8, p + 1);
  p += 1 + d.size + 2; // tag + len + ES_ID
  const flags = u8[p++];
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + u8[p];
  if (flags & 0x20) p += 2;
  if (u8[p] !== 0x04) return null;
  d = descLen(u8, p + 1);
  p += 1 + d.size;
  const oti = u8[p];
  p += 13; // oti 1 + streamType 1 + bufferSize 3 + maxBitrate 4 + avgBitrate 4
  let asc = null;
  if (p < end && u8[p] === 0x05) {
    d = descLen(u8, p + 1);
    p += 1 + d.size;
    asc = u8.slice(p, Math.min(end, p + d.len));
  }
  return { oti, asc };
}

/** AudioSpecificConfig 前几位：对象类型、采样率、声道 */
export function parseAsc(asc) {
  if (!asc || asc.length < 2) return null;
  let bit = 0;
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((asc[bit >> 3] >> (7 - (bit & 7))) & 1);
    return v;
  };
  let aot = read(5);
  if (aot === 31) aot = 32 + read(6);
  const sfi = read(4);
  const sampleRate = sfi === 15 ? read(24) : SAMPLE_RATES[sfi] || 0;
  const chanCfg = read(4);
  return { aot, sfi, sampleRate, chanCfg };
}

/**
 * 读音频 init 段，拿解码器要的参数。
 * 认 AAC 和 MPEG 音频（codec = 'mpeg'，自带 MP2 解码）；AC-3/E-AC-3 这类杜比音轨浏览器侧解不了，
 * codec 留空，调用方据此回退 1×。
 */
export function parseAudioInit(input) {
  const u8 = toU8(input);
  const top = readBoxes(u8);
  const traks = findPath(u8, top, ['moov', 'trak']);
  const trexList = findPath(u8, top, ['moov', 'mvex', 'trex']);
  for (const trak of traks) {
    const mdia = child(u8, trak, 'mdia');
    if (!mdia || handlerOf(u8, mdia) !== 'soun') continue;
    const tkhd = child(u8, trak, 'tkhd');
    const trackId = tkhd ? u32(u8, tkhd.data + (u8[tkhd.data] === 1 ? 20 : 12)) : 0;
    const mdhd = child(u8, mdia, 'mdhd');
    const timescale = mdhd ? u32(u8, mdhdTimescalePos(u8, mdhd)) : 0;
    const stsd = findPath(u8, [mdia], ['mdia', 'minf', 'stbl', 'stsd'])[0];
    if (!stsd) continue;
    const entries = readBoxes(u8, stsd.data + 8, stsd.end);
    const entry = entries[0];
    if (!entry) continue;
    const info = { trackId, timescale, format: entry.type, codec: '', asc: null, sampleRate: 0, channels: 0, trex: null };
    for (const t of trexList) {
      if (u32(u8, t.data + 4) === trackId || trexList.length === 1) {
        info.trex = { duration: u32(u8, t.data + 12), size: u32(u8, t.data + 16) };
      }
    }
    if (entry.type !== 'mp4a' && entry.type !== '.mp3') return info; // ac-3 / ec-3 / Opus ...：不支持，codec 留空
    // AudioSampleEntry：reserved 6 + dref 2 + version 2 + revision 2 + vendor 4 + channels 2 + bits 2 + ... + rate 4
    const base = entry.data;
    const ver = (u8[base + 8] << 8) | u8[base + 9];
    info.channels = (u8[base + 16] << 8) | u8[base + 17];
    info.sampleRate = u32(u8, base + 24) >>> 16;
    // hls.js 遇到 TS 里的 MPEG 音频、又不能直接建 audio/mpeg 时，会封成 '.mp3' 样本项
    if (entry.type === '.mp3') {
      info.codec = 'mpeg';
      return info;
    }
    const childStart = base + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
    const esds = readBoxes(u8, childStart, entry.end).find((b) => b.type === 'esds');
    const es = esds && parseEsds(u8, esds);
    // 0x6B = MPEG-1 音频，0x69 = MPEG-2 音频（Layer 在帧头里，解码时再挑）
    if (es && (es.oti === 0x6b || es.oti === 0x69)) {
      info.codec = 'mpeg';
      return info;
    }
    if (!es || es.oti !== 0x40 || !es.asc) return info; // 0x40 = MPEG-4 Audio
    const a = parseAsc(es.asc);
    if (!a) return info;
    info.asc = es.asc;
    info.aot = a.aot;
    info.sfi = a.sfi;
    info.chanCfg = a.chanCfg;
    info.codec = 'mp4a.40.' + a.aot;
    if (!info.sampleRate) info.sampleRate = a.sampleRate;
    if (!info.channels) info.channels = a.chanCfg || 2;
    return info;
  }
  return null;
}

/* ---------------- 音频媒体段 ---------------- */

/**
 * 把 moof+mdat 拆成样本。
 * @returns {{samples:Array<{t:number,d:number,data:Uint8Array}>, rest:Uint8Array|null}}
 *   t/d 单位是轨道刻度；rest = 末尾只来了 moof、mdat 还没到的那截，留给下一次 append 拼上
 */
export function parseFragments(input, track) {
  const u8 = toU8(input);
  const boxes = readBoxes(u8);
  const samples = [];
  let consumed = 0;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.type !== 'moof') {
      consumed = b.end;
      continue;
    }
    const mdat = boxes[i + 1];
    if (!mdat || mdat.type !== 'mdat') break;
    for (const traf of children(u8, b, 'traf')) readTraf(u8, b, traf, track, samples);
    consumed = mdat.end;
    i++;
  }
  // 数据在 box 中间被截断（readBoxes 停在半个 box 上）也算没吃完
  const rest = consumed < u8.length ? u8.slice(consumed) : null;
  return { samples, rest };
}

function readTraf(u8, moof, traf, track, out) {
  const tfhd = child(u8, traf, 'tfhd');
  if (!tfhd) return;
  const tf = u32(u8, tfhd.data) & 0xffffff;
  let p = tfhd.data + 4;
  const trackId = u32(u8, p);
  p += 4;
  if (track.trackId && trackId !== track.trackId) return;
  let base = moof.start;
  if (tf & 0x1) {
    base = u64(u8, p);
    p += 8;
  }
  if (tf & 0x2) p += 4;
  const trex = track.trex || {};
  let defDur = trex.duration || 0;
  let defSize = trex.size || 0;
  if (tf & 0x8) {
    defDur = u32(u8, p);
    p += 4;
  }
  if (tf & 0x10) {
    defSize = u32(u8, p);
    p += 4;
  }
  const tfdt = child(u8, traf, 'tfdt');
  let t = 0;
  if (tfdt) t = u8[tfdt.data] === 1 ? u64(u8, tfdt.data + 4) : u32(u8, tfdt.data + 4);
  let dataPos = -1;
  for (const trun of children(u8, traf, 'trun')) {
    const flags = u32(u8, trun.data) & 0xffffff;
    let q = trun.data + 4;
    const count = u32(u8, q);
    q += 4;
    if (flags & 0x1) {
      dataPos = base + (u32(u8, q) | 0);
      q += 4;
    } else if (dataPos < 0) {
      dataPos = base;
    }
    if (flags & 0x4) q += 4;
    for (let k = 0; k < count; k++) {
      let dur = defDur;
      let size = defSize;
      if (flags & 0x100) {
        dur = u32(u8, q);
        q += 4;
      }
      if (flags & 0x200) {
        size = u32(u8, q);
        q += 4;
      }
      if (flags & 0x400) q += 4;
      if (flags & 0x800) q += 4;
      if (dataPos + size > u8.length) return;
      out.push({ t, d: dur, data: u8.subarray(dataPos, dataPos + size) });
      dataPos += size;
      t += dur;
    }
  }
}

/** 给裸 AAC 帧补 7 字节 ADTS 头：没有 WebCodecs 时靠 decodeAudioData 解 */
export function adtsHeader(info, frameLen) {
  const len = frameLen + 7;
  // ADTS 只能写 LC 等基础档；HE-AAC 交给解码器隐式识别 SBR
  const profile = Math.max(0, Math.min(3, (info.aot === 5 || info.aot === 29 ? 2 : info.aot || 2) - 1));
  const sfi = info.sfi != null ? info.sfi : Math.max(0, SAMPLE_RATES.indexOf(info.sampleRate));
  const ch = info.chanCfg || info.channels || 2;
  const h = new Uint8Array(7);
  h[0] = 0xff;
  h[1] = 0xf1;
  h[2] = ((profile & 3) << 6) | ((sfi & 15) << 2) | ((ch >> 2) & 1);
  h[3] = ((ch & 3) << 6) | ((len >> 11) & 3);
  h[4] = (len >> 3) & 0xff;
  h[5] = ((len & 7) << 5) | 0x1f;
  h[6] = 0xfc;
  return h;
}
