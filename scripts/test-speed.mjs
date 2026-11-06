// 单元测试：倍速引擎里的纯计算部分（移植自 YSC，加了回看要用的 MP2）
//
// 真机上出问题很难查，能在 node 里守住的先守住：
//   1. 改视频 init 刻度：只改视频轨、不碰原数据（hls.js 会把缓存的 init 再 append 一遍）
//   2. 音频 init / 分片解析：解码参数和每帧时间对得上
//   3. WSOLA：输出长度 = 输入 / 倍速，音调不变
//   4. 假 SourceBuffer：事件顺序和 buffered 跟真的一样，hls.js 的队列才推得动；
//      裸 audio/mpeg 按 sequence 模式顺延 timestampOffset
//   5. MP2 解码：和 ffmpeg 的输出对齐，强度立体声各声道用自己的比例因子
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rewriteVideoInit, parseAudioInit, parseFragments, parseAsc, adtsHeader, hasMoov } from '../src/player/speed/isobmff.js';
import { PcmStore, Wsola } from '../src/player/speed/pcm.js';
import { makeRanges, scaleRanges, addRange, removeRange } from '../src/player/speed/ranges.js';
import { classify, FakeAudioSB } from '../src/player/speed/engine.js';
import { parseMpegHeader, splitMpegFrames, Mp2Decoder } from '../src/player/speed/mp2.js';
import { AudioPipeline } from '../src/player/speed/audio.js';

/* ---------------- 造 MP4 的小工具 ---------------- */

function be32(v) {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}
function be16(v) {
  return [(v >>> 8) & 255, v & 255];
}
function box(type, ...parts) {
  const body = [];
  for (const p of parts) body.push(...p);
  return [...be32(body.length + 8), ...[...type].map((c) => c.charCodeAt(0)), ...body];
}
const zeros = (n) => new Array(n).fill(0);
const fourcc = (s) => [...s].map((c) => c.charCodeAt(0));

function mdhd(ts, v1 = false) {
  return v1
    ? box('mdhd', [1, 0, 0, 0], zeros(16), be32(ts), zeros(8), zeros(4))
    : box('mdhd', [0, 0, 0, 0], zeros(8), be32(ts), be32(0), zeros(4));
}
function hdlr(kind) {
  return box('hdlr', [0, 0, 0, 0], zeros(4), fourcc(kind), zeros(12), [0]);
}
function tkhd(id) {
  return box('tkhd', [0, 0, 0, 0], zeros(8), be32(id), zeros(68));
}
function esds(asc, oti = 0x40) {
  const dsi = [0x05, asc.length, ...asc];
  const dcd = [0x04, 13 + dsi.length, oti, 0x15, 0, 0, 0, ...zeros(8), ...dsi];
  const es = [0x03, 3 + dcd.length, 0, 1, 0, ...dcd];
  return box('esds', [0, 0, 0, 0], es);
}
function sampleEntry(type, ch, sr, ...kids) {
  return box(type, zeros(6), be16(1), zeros(8), be16(ch), be16(16), zeros(4), be32(sr * 65536), ...kids);
}
function mp4a(ch, sr, asc) {
  return sampleEntry('mp4a', ch, sr, esds(asc));
}
function audioTrak(id, ts, entry) {
  return box(
    'trak',
    tkhd(id),
    box('mdia', mdhd(ts), hdlr('soun'), box('minf', box('stbl', box('stsd', [0, 0, 0, 0], be32(1), entry))))
  );
}
function videoTrak(id, ts, v1) {
  return box('trak', tkhd(id), box('mdia', mdhd(ts, v1), hdlr('vide'), box('minf', box('stbl', box('stsd', [0, 0, 0, 0], be32(0))))));
}
function trex(id, dur, size) {
  return box('trex', [0, 0, 0, 0], be32(id), be32(1), be32(dur), be32(size), be32(0));
}
const ftyp = box('ftyp', fourcc('iso5'), be32(0), fourcc('iso5'));

/** 一个 moof+mdat：tfdt v1，trun 带 data_offset、每样本时长和大小 */
function fragment(id, t, frames) {
  const trunBody = [0, 0, 0x03, 0x01, ...be32(frames.length), ...be32(0)];
  for (const f of frames) trunBody.push(...be32(f.d), ...be32(f.data.length));
  const build = (off) => {
    const b = trunBody.slice();
    b.splice(8, 4, ...be32(off));
    return box(
      'moof',
      box('mfhd', [0, 0, 0, 0], be32(1)),
      box(
        'traf',
        box('tfhd', [0, 0x02, 0, 0], be32(id)),
        box('tfdt', [1, 0, 0, 0], be32(Math.floor(t / 4294967296)), be32(t >>> 0)),
        box('trun', b)
      )
    );
  };
  const moofLen = build(0).length;
  const moof = build(moofLen + 8);
  const payload = [];
  for (const f of frames) payload.push(...f.data);
  return [...moof, ...box('mdat', payload)];
}

/* ---------------- MP2 片段 ---------------- */

const fixture = (name) => new Uint8Array(fs.readFileSync(new URL('./fixtures/mp2/' + name, import.meta.url)));
const SINE_STEREO = fixture('sine-stereo-48k-192k.mp2'); // 25 帧 × 576 字节，左 440Hz/0.5 右 660Hz/0.3
const SINE_MONO = fixture('sine-mono-48k-64k.mp2'); // 25 帧 × 192 字节
const NOISE = fixture('noise-stereo-48k-64k.mp2');
const NOISE_REF = (() => {
  const b = fixture('noise-stereo-48k-64k.ref.f32');
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
})();

/** 整段顺序解完，返回 [L, R] */
function decodeAll(u8) {
  const { frames } = splitMpegFrames(u8);
  const n = frames.length * 1152;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const dec = new Mp2Decoder();
  frames.forEach((f, i) => assert.ok(dec.decode(f.data, L, R, i * 1152), '第 ' + i + ' 帧没解出来'));
  return [L, R];
}

/* ---------------- isobmff ---------------- */

test('rewriteVideoInit: 只改视频轨刻度，原数据不动', () => {
  const init = new Uint8Array([...ftyp, ...box('moov', videoTrak(1, 90000), audioTrak(2, 44100, mp4a(2, 44100, [0x12, 0x10])))]);
  const before = init.slice();
  const r = rewriteVideoInit(init, 1.5);
  assert.ok(r);
  assert.equal(r.scale, 1.5);
  assert.deepEqual(init, before, '原数据被改了：hls.js 再 append 一次会乘两遍');
  // 再改一次副本也只乘一次
  const again = rewriteVideoInit(init, 1.5);
  assert.deepEqual(again.data, r.data);
  // 音频轨刻度原样：改完以后照样能读出 44100
  assert.equal(parseAudioInit(r.data).timescale, 44100);
  const dv = new DataView(r.data.buffer);
  const pos = r.data.findIndex((_, i) => String.fromCharCode(...r.data.subarray(i, i + 4)) === 'mdhd');
  assert.equal(dv.getUint32(pos + 4 + 12), 135000);
});

test('rewriteVideoInit: mdhd v1、没有视频轨返回 null、刻度太小时报出真实倍率', () => {
  const v1 = new Uint8Array([...ftyp, ...box('moov', videoTrak(1, 1000, true))]);
  assert.equal(rewriteVideoInit(v1, 1.25).scale, 1.25);
  const audioOnly = new Uint8Array([...ftyp, ...box('moov', audioTrak(1, 48000, mp4a(2, 48000, [0x11, 0x90])))]);
  assert.equal(rewriteVideoInit(audioOnly, 2), null);
  const coarse = new Uint8Array([...ftyp, ...box('moov', videoTrak(1, 25))]);
  const r = rewriteVideoInit(coarse, 1.5);
  assert.equal(r.scale, 38 / 25); // 偏 1.3%，引擎据此回退
});

test('parseAudioInit: mp4a/esds 读出 AAC-LC 44.1k 双声道和 trex 默认值', () => {
  const init = new Uint8Array([
    ...ftyp,
    ...box('moov', audioTrak(7, 44100, mp4a(2, 44100, [0x12, 0x10])), box('mvex', trex(7, 1024, 0)))
  ]);
  assert.ok(hasMoov(init));
  const info = parseAudioInit(init);
  assert.equal(info.trackId, 7);
  assert.equal(info.timescale, 44100);
  assert.equal(info.codec, 'mp4a.40.2');
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.channels, 2);
  assert.deepEqual([...info.asc], [0x12, 0x10]);
  assert.deepEqual(info.trex, { duration: 1024, size: 0 });
});

test('parseAudioInit: 杜比 ac-3 codec 留空；MPEG 音频（esds 0x6B/0x69、.mp3 样本项）认成 mpeg', () => {
  const ac3 = sampleEntry('ac-3', 6, 48000);
  assert.equal(parseAudioInit(new Uint8Array([...box('moov', audioTrak(1, 48000, ac3))])).codec, '');
  for (const oti of [0x6b, 0x69]) {
    const mp3 = sampleEntry('mp4a', 2, 44100, esds([0x12, 0x10], oti));
    assert.equal(parseAudioInit(new Uint8Array([...box('moov', audioTrak(1, 44100, mp3))])).codec, 'mpeg');
  }
  // hls.js 不能直接建 audio/mpeg 时会封成 fMP4 的 '.mp3' 样本项
  const dotMp3 = parseAudioInit(new Uint8Array([...box('moov', audioTrak(4, 48000, sampleEntry('.mp3', 1, 48000)))]));
  assert.equal(dotMp3.codec, 'mpeg');
  assert.equal(dotMp3.trackId, 4);
  assert.equal(dotMp3.channels, 1);
  assert.equal(dotMp3.sampleRate, 48000);
});

test('parseAsc: HE-AAC 与 48k', () => {
  assert.deepEqual(parseAsc([0x11, 0x90]), { aot: 2, sfi: 3, sampleRate: 48000, chanCfg: 2 });
  assert.equal(parseAsc([0x2b, 0x92, 0x08, 0x00]).aot, 5);
});

test('parseFragments: 拆样本、tfdt v1 大时间戳、只来了 moof 的尾巴留给下次', () => {
  const big = 2 ** 33 + 1024; // 超过 32 位
  const frames = [
    { d: 1024, data: [1, 2, 3] },
    { d: 1024, data: [4, 5] },
    { d: 1000, data: [6] }
  ];
  const seg = fragment(3, big, frames);
  const { samples, rest } = parseFragments(new Uint8Array(seg), { trackId: 3, trex: null });
  assert.equal(rest, null);
  assert.deepEqual(
    samples.map((s) => [s.t, s.d, [...s.data]]),
    [
      [big, 1024, [1, 2, 3]],
      [big + 1024, 1024, [4, 5]],
      [big + 2048, 1000, [6]]
    ]
  );
  // 别的轨的 traf 跳过
  assert.equal(parseFragments(new Uint8Array(seg), { trackId: 9 }).samples.length, 0);
  // 两段拼一起，第二段 mdat 没到
  const second = fragment(3, 0, frames);
  const moofOnly = second.slice(0, second.length - (8 + 6));
  const r2 = parseFragments(new Uint8Array([...seg, ...moofOnly]), { trackId: 3 });
  assert.equal(r2.samples.length, 3);
  assert.equal(r2.rest.length, moofOnly.length);
});

test('adtsHeader: 各位与长度', () => {
  const h = adtsHeader({ aot: 2, sfi: 4, chanCfg: 2 }, 100);
  assert.equal(h[0], 0xff);
  assert.equal(h[1], 0xf1);
  assert.equal(h[2] >> 6, 1); // profile = aot - 1
  assert.equal((h[2] >> 2) & 15, 4);
  assert.equal(((h[2] & 1) << 2) | (h[3] >> 6), 2);
  const len = ((h[3] & 3) << 11) | (h[4] << 3) | (h[5] >> 5);
  assert.equal(len, 107);
});

/* ---------------- ranges ---------------- */

test('ranges: 合并相邻、删除切段、缩放、越界抛 IndexSizeError', () => {
  let l = addRange([], 0, 2);
  l = addRange(l, 2.03, 4, 0.05);
  assert.deepEqual(l, [[0, 4]]);
  l = addRange(l, 10, 12);
  l = addRange(l, 5, 6);
  assert.deepEqual(l, [[0, 4], [5, 6], [10, 12]]);
  l = removeRange(l, 1, 5.5);
  assert.deepEqual(l, [[0, 1], [5.5, 6], [10, 12]]);
  const tr = scaleRanges(makeRanges(l), 2);
  assert.equal(tr.length, 3);
  assert.equal(tr.end(2), 24);
  assert.throws(() => tr.start(3), { name: 'IndexSizeError' });
});

/* ---------------- PCM / WSOLA ---------------- */

function sine(sr, sec, hz) {
  const n = Math.round(sr * sec);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / sr);
  return a;
}

test('PcmStore: 按秒插入、连续性、缺口补 0、覆盖重插', () => {
  const st = new PcmStore();
  const sr = 1000;
  st.insert(0, [new Float32Array(500).fill(1)], sr);
  st.insert(0.52, [new Float32Array(480).fill(2)], sr); // 20ms 缝，算连续
  st.insert(2, [new Float32Array(100).fill(3)], sr);
  assert.equal(st.contiguousEnd(0), 1000);
  assert.equal(st.contiguousEnd(1500), 1500); // 不在任何块里
  const out = [new Float32Array(40)];
  st.read(490, 40, out);
  assert.equal(out[0][0], 1);
  assert.equal(out[0][15], 0); // 缝里补 0
  assert.equal(out[0][35], 2);
  // 同一段再来一遍（hls.js 回填），旧块被替换不重复
  st.insert(0, [new Float32Array(500).fill(5)], sr);
  assert.equal(st.blocks.length, 3);
  st.read(0, 1, out);
  assert.equal(out[0][0], 5);
  st.removeSec(1.9, 3);
  assert.equal(st.blocks.length, 2);
  assert.deepEqual(st.evictBefore(0.6), [0, 0.5]);
  assert.equal(st.blocks.length, 1);
});

function zeroCrossHz(a, sr) {
  let n = 0;
  for (let i = 1; i < a.length; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) n++;
  return n / 2 / (a.length / sr);
}

function peakOf(a) {
  let p = 0;
  for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
  return p;
}

for (const speed of [1.5, 2, 0.5]) {
  test('WSOLA ' + speed + '×: 输出时长 = 输入 / 倍速，音调不变', () => {
    const sr = 44100;
    const st = new PcmStore();
    const sig = sine(sr, 4, 440);
    st.insert(0, [sig, sig.slice()], sr);
    const w = new Wsola(st, speed);
    w.reset(0);
    const chunks = [];
    let out;
    while ((out = w.process(4))) chunks.push(out);
    const total = chunks.reduce((a, c) => a + c[0].length, 0);
    const consumed = w.pos; // 名义输入位置
    // 产出的每个输出采样对应 speed 个输入采样
    assert.ok(Math.abs(consumed / total - speed) < 0.01, 'ratio ' + consumed / total);
    assert.ok(consumed > sig.length * 0.9 - (w.N + w.D) * 2, '输入没吃完：' + consumed);
    const flat = new Float32Array(total);
    let p = 0;
    for (const c of chunks) {
      flat.set(c[0], p);
      p += c[0].length;
    }
    // 跳过开头的淡入
    const mid = flat.subarray(Math.round(sr * 0.1), total - Math.round(sr * 0.05));
    const hz = zeroCrossHz(mid, sr);
    assert.ok(Math.abs(hz - 440) < 8, 'pitch ' + hz);
    // 音量稳定：Hann 半帧重叠和为 1，WSOLA 对齐后不该有明显起伏
    const peak = peakOf(mid);
    assert.ok(peak > 0.45 && peak < 0.56, 'peak ' + peak);
  });
}

test('WSOLA: 输入没到返回 null，nudge 挪名义位置', () => {
  const st = new PcmStore();
  st.insert(0, [new Float32Array(2000)], 44100);
  const w = new Wsola(st, 1.5);
  w.reset(0);
  assert.equal(w.process(4), null);
  w.nudge(100);
  assert.equal(w.pos, 100);
});

/* ---------------- MP2：帧头 / 切帧 ---------------- */

test('parseMpegHeader: 各层各版本的码率、采样率、帧长', () => {
  const h = parseMpegHeader(new Uint8Array([0xff, 0xfd, 0xa4, 0x00]), 0);
  assert.deepEqual(
    [h.version, h.layer, h.bitrate, h.sampleRate, h.channels, h.crc, h.samples, h.frameLength],
    [3, 2, 192, 48000, 2, false, 1152, 576]
  );
  // 44.1k 带 padding、带 CRC、联合立体声
  const p = parseMpegHeader(new Uint8Array([0xff, 0xfc, 0x92, 0x60]), 0);
  assert.deepEqual([p.bitrate, p.sampleRate, p.padding, p.crc, p.mode, p.modeExt, p.frameLength], [160, 44100, 1, true, 1, 2, 523]);
  const mono = parseMpegHeader(SINE_MONO, 0);
  assert.deepEqual([mono.channels, mono.bitrate, mono.frameLength], [1, 64, 192]);
  const l3 = parseMpegHeader(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), 0);
  assert.deepEqual([l3.layer, l3.bitrate, l3.sampleRate, l3.frameLength], [3, 128, 44100, 417]);
  const m2 = parseMpegHeader(new Uint8Array([0xff, 0xf3, 0x80, 0x00]), 0);
  assert.deepEqual([m2.version, m2.layer, m2.bitrate, m2.sampleRate, m2.samples, m2.frameLength], [2, 3, 64, 22050, 576, 208]);
  const l1 = parseMpegHeader(new Uint8Array([0xff, 0xff, 0x90, 0x00]), 0);
  assert.deepEqual([l1.layer, l1.bitrate, l1.samples, l1.frameLength], [1, 288, 384, 312]);
  // 不是帧头：没同步字、保留版本、保留层、free format、坏码率、保留采样率、数据不够 4 字节
  for (const b of [
    [0xff, 0x7d, 0xa4, 0],
    [0xff, 0xed, 0xa4, 0],
    [0xff, 0xf9, 0xa4, 0],
    [0xff, 0xfd, 0x04, 0],
    [0xff, 0xfd, 0xf4, 0],
    [0xff, 0xfd, 0xac, 0],
    [0xff, 0xfd, 0xa4]
  ]) {
    assert.equal(parseMpegHeader(new Uint8Array(b), 0), null, b.map((x) => x.toString(16)).join(' '));
  }
});

test('splitMpegFrames: 跳过前面的垃圾重新同步，末尾半帧放 rest', () => {
  const two = SINE_STEREO.subarray(0, 576 * 2);
  const tail = SINE_STEREO.subarray(576 * 2, 576 * 2 + 100);
  const u8 = new Uint8Array([1, 2, 3, 0xff, 0x00, ...two, ...tail]);
  const { frames, rest } = splitMpegFrames(u8);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].data, two.subarray(0, 576));
  assert.deepEqual(frames[1].data, two.subarray(576));
  assert.deepEqual(rest, tail);
  // 整帧刚好对齐：没有 rest
  const all = splitMpegFrames(SINE_STEREO);
  assert.equal(all.frames.length, 25);
  assert.equal(all.rest, null);
});

/* ---------------- MP2：解码 ---------------- */

test('Mp2Decoder: 立体声正弦，左右声道音调、音量对得上没串', () => {
  const [L, R] = decodeAll(SINE_STEREO);
  const a = Math.round(48000 * 0.05);
  const b = L.length - Math.round(48000 * 0.05);
  const l = L.subarray(a, b);
  const r = R.subarray(a, b);
  assert.ok(Math.abs(zeroCrossHz(l, 48000) - 440) < 5, 'L ' + zeroCrossHz(l, 48000));
  assert.ok(Math.abs(zeroCrossHz(r, 48000) - 660) < 5, 'R ' + zeroCrossHz(r, 48000));
  assert.ok(Math.abs(peakOf(l) - 0.5) < 0.03, 'L peak ' + peakOf(l));
  assert.ok(Math.abs(peakOf(r) - 0.3) < 0.03, 'R peak ' + peakOf(r));
});

test('Mp2Decoder: 单声道两边一样', () => {
  const [L, R] = decodeAll(SINE_MONO);
  assert.deepEqual(L, R);
  const mid = L.subarray(2400, L.length - 2400);
  assert.ok(Math.abs(zeroCrossHz(mid, 48000) - 440) < 5);
  assert.ok(Math.abs(peakOf(mid) - 0.5) < 0.03, 'peak ' + peakOf(mid));
});

test('Mp2Decoder: 低码率噪声（粗量化器）和 ffmpeg 解出来的一致', () => {
  const [L, R] = decodeAll(NOISE);
  const F = 12;
  const out = [L.subarray(F * 1152, (F + 1) * 1152), R.subarray(F * 1152, (F + 1) * 1152)];
  for (let c = 0; c < 2; c++) {
    const ref = NOISE_REF.subarray(c * 1152, (c + 1) * 1152);
    let sig = 0;
    let err = 0;
    for (let i = 0; i < 1152; i++) {
      sig += ref[i] * ref[i];
      err += (ref[i] - out[c][i]) ** 2;
    }
    const snr = 10 * Math.log10(sig / (err || 1e-30));
    assert.ok(snr > 50, '声道 ' + c + ' SNR ' + snr.toFixed(1) + 'dB');
  }
});

test('Mp2Decoder: 不是 MPEG-1 Layer II 返回 false，输出不动', () => {
  const dec = new Mp2Decoder();
  const L = new Float32Array(1152).fill(7);
  const R = new Float32Array(1152).fill(7);
  const l3 = new Uint8Array(417);
  l3.set([0xff, 0xfb, 0x90, 0x00]);
  assert.equal(dec.decode(l3, L, R, 0), false);
  assert.equal(dec.decode(new Uint8Array(576), L, R, 0), false);
  assert.equal(L[0], 7);
  assert.equal(R[1151], 7);
});

class BitWriter {
  constructor(bytes) {
    this.u8 = new Uint8Array(bytes);
    this.pos = 0;
  }
  put(n, v) {
    for (let i = n - 1; i >= 0; i--) {
      if ((v >> i) & 1) this.u8[this.pos >> 3] |= 0x80 >> (this.pos & 7);
      this.pos++;
    }
  }
}

/**
 * 手搓一帧 192k/48k 的 Layer II（sblimit 27，高码率分配表）。
 * 只给 sb0（两声道各自分配）、sb5 和 sb12 分配比特；joint = 联合立体声 modeExt 0 → bound 4，
 * sb5/sb12 走强度立体声：量化值只传一份。plain = 普通立体声，同样的量化值给两个声道各传一遍。
 * 两个声道的比例因子故意不一样：解码对的话两帧输出逐采样相同。
 */
function layer2Frame(joint) {
  const nbal = (sb) => (sb < 11 ? 4 : sb < 23 ? 3 : 2);
  // 分配值 → 量化器（查 LUT3/LUT4 得来）
  const Q31 = { v: 4, levels: 31, group: 0, bits: 5 }; // sb0 行 3
  const Q3 = { v: 1, levels: 3, group: 1, bits: 5 }; // sb0 行 3
  const Q15 = { v: 5, levels: 15, group: 0, bits: 4 }; // sb5 行 2
  const Q9 = { v: 4, levels: 9, group: 1, bits: 10 }; // sb12 行 1
  const alloc = { 0: [Q31, Q3], 5: [Q15, Q15], 12: [Q9, Q9] };
  const scfsi = { 0: [0, 2], 5: [0, 2], 12: [1, 3] };
  const sf = {
    0: [[12, 14, 16], [18, 18, 18]],
    5: [[13, 15, 17], [24, 24, 24]],
    12: [[15, 15, 30], [21, 27, 27]]
  };
  const code = (sb, c, g, k, levels) => (g * 7 + sb * 3 + c * 5 + k * 11) % levels;
  const bound = joint ? 4 : 27;

  const w = new BitWriter(576);
  for (const b of [0xff, 0xfd, 0xa4, joint ? 0x40 : 0x00]) w.put(8, b);
  for (let sb = 0; sb < 27; sb++) {
    const a = alloc[sb];
    if (sb < bound) {
      w.put(nbal(sb), a ? a[0].v : 0);
      w.put(nbal(sb), a ? a[1].v : 0);
    } else {
      w.put(nbal(sb), a ? a[0].v : 0);
    }
  }
  for (const sb of [0, 5, 12]) for (let c = 0; c < 2; c++) w.put(2, scfsi[sb][c]);
  for (const sb of [0, 5, 12]) {
    for (let c = 0; c < 2; c++) {
      const f = sf[sb][c];
      const s = scfsi[sb][c];
      const list = s === 0 ? f : s === 1 ? [f[0], f[2]] : s === 2 ? [f[0]] : [f[0], f[1]];
      for (const x of list) w.put(6, x);
    }
  }
  const putCodes = (sb, c, src, g) => {
    const q = alloc[sb][c];
    const cs = [0, 1, 2].map((k) => code(sb, src, g, k, q.levels));
    if (q.group) w.put(q.bits, cs[0] + cs[1] * q.levels + cs[2] * q.levels * q.levels);
    else for (const x of cs) w.put(q.bits, x);
  };
  for (let g = 0; g < 12; g++) {
    for (const sb of [0, 5, 12]) {
      if (sb < 4) {
        putCodes(sb, 0, 0, g);
        putCodes(sb, 1, 1, g);
      } else if (joint) {
        putCodes(sb, 0, 0, g);
      } else {
        putCodes(sb, 0, 0, g);
        putCodes(sb, 1, 0, g);
      }
    }
  }
  return w.u8;
}

test('Mp2Decoder: 强度立体声子带两声道共用量化值、各乘自己的比例因子', () => {
  const run = (u8) => {
    const L = new Float32Array(1152);
    const R = new Float32Array(1152);
    assert.ok(new Mp2Decoder().decode(u8, L, R, 0));
    return [L, R];
  };
  const joint = layer2Frame(true);
  const plain = layer2Frame(false);
  assert.equal(parseMpegHeader(joint, 0).mode, 1);
  assert.equal(parseMpegHeader(plain, 0).mode, 0);
  const [jl, jr] = run(joint);
  const [pl, pr] = run(plain);
  assert.ok(peakOf(jl) > 0.01 && peakOf(jr) > 0.01, '没解出声音');
  assert.ok(peakOf(jl) < 1 && peakOf(jr) < 1, '削顶了，比对不出差别');
  assert.deepEqual(jl, pl);
  assert.deepEqual(jr, pr);
  assert.notDeepEqual(jl, jr);
});

/* ---------------- engine: 归类 / 假音频 SB ---------------- */

test('classify: 音频 / 视频 / 混合轨', () => {
  assert.equal(classify('audio/mp4;codecs=mp4a.40.2'), 'audio');
  assert.equal(classify('audio/mpeg'), 'audio');
  assert.equal(classify('video/mp4;codecs=avc1.64001f'), 'video');
  assert.equal(classify('video/mp4;codecs="avc1.64001f,mp4a.40.2"'), 'muxed');
  assert.equal(classify('video/mp4;codecs=hvc1.1.6.L120.90'), 'video');
});

function fakeEngine() {
  const log = { fail: [], init: [], push: [], remove: [] };
  return {
    log,
    dead: false,
    fail: (r) => log.fail.push(r),
    audio: {
      setInit: (i) => log.init.push(i),
      push: (s, ts, off) => log.push.push({ n: s.length, ts, off }),
      remove: (a, b) => log.remove.push([a, b])
    }
  };
}

const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('FakeAudioSB: 事件顺序、init+分片、buffered 用 timestampOffset 换算', async () => {
  const eng = fakeEngine();
  const sb = new FakeAudioSB(eng, 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(sb.mode, 'segments');
  const ev = [];
  for (const k of ['updatestart', 'update', 'updateend']) sb.addEventListener(k, () => ev.push(k + ':' + sb.updating));
  const init = new Uint8Array([...ftyp, ...box('moov', audioTrak(1, 48000, mp4a(2, 48000, [0x11, 0x90])))]);
  sb.appendBuffer(init);
  assert.equal(sb.updating, true);
  assert.throws(() => sb.appendBuffer(init), { name: 'InvalidStateError' });
  await wait();
  assert.deepEqual(ev, ['updatestart:true', 'update:false', 'updateend:false']);
  assert.equal(eng.log.init[0].codec, 'mp4a.40.2');

  sb.timestampOffset = 10;
  const frames = Array.from({ length: 47 }, () => ({ d: 1024, data: [1, 2, 3, 4] }));
  sb.appendBuffer(new Uint8Array(fragment(1, 48000, frames)));
  await wait();
  assert.deepEqual(eng.log.push[0], { n: 47, ts: 48000, off: 10 });
  assert.equal(sb.timestampOffset, 10, 'segments 模式下 offset 不该顺延');
  assert.equal(sb.buffered.length, 1);
  assert.equal(sb.buffered.start(0), 11);
  assert.ok(Math.abs(sb.buffered.end(0) - (11 + (47 * 1024) / 48000)) < 1e-9);

  sb.remove(0, 11.5);
  await wait();
  assert.deepEqual(eng.log.remove[0], [0, 11.5]);
  assert.equal(sb.buffered.start(0), 11.5);
  assert.deepEqual(eng.log.fail, []);
});

test('FakeAudioSB: 不认的音频直接报 audio-codec，但事件照发不卡 hls.js 队列', async () => {
  const eng = fakeEngine();
  new FakeAudioSB(eng, 'audio/webm;codecs=opus');
  assert.deepEqual(eng.log.fail, ['audio-codec']);
  const eng2 = fakeEngine();
  const sb = new FakeAudioSB(eng2, 'audio/mp4;codecs=ac-3');
  let ended = 0;
  sb.addEventListener('updateend', () => ended++);
  const ac3 = sampleEntry('ac-3', 6, 48000);
  sb.appendBuffer(new Uint8Array([...box('moov', audioTrak(1, 48000, ac3))]));
  await wait();
  assert.equal(ended, 1);
  assert.deepEqual(eng2.log.fail, ['audio-codec']);
});

test('FakeAudioSB audio/mpeg: sequence 模式，timestampOffset 按帧顺延，半帧拼到下一次', async () => {
  const eng = fakeEngine();
  const sb = new FakeAudioSB(eng, 'audio/mpeg');
  assert.equal(sb.mode, 'sequence');
  assert.deepEqual(eng.log.fail, []);
  const F = 576;
  const dt = 1152 / 48000;

  sb.timestampOffset = 10;
  sb.appendBuffer(SINE_STEREO.subarray(0, F * 3 + 300));
  await wait();
  assert.deepEqual(eng.log.push[0], { n: 3, ts: 48000, off: 10 });
  assert.equal(eng.log.init[0].codec, 'mpeg');
  assert.equal(eng.log.init[0].sampleRate, 48000);
  assert.equal(eng.log.init[0].channels, 2);
  assert.ok(Math.abs(sb.timestampOffset - (10 + 3 * dt)) < 1e-9);

  // 剩下半帧 + 一整帧：拼上前面那 300 字节正好两帧
  sb.appendBuffer(SINE_STEREO.subarray(F * 3 + 300, F * 5));
  await wait();
  assert.equal(eng.log.push[1].n, 2);
  assert.ok(Math.abs(eng.log.push[1].off - (10 + 3 * dt)) < 1e-9);
  assert.ok(Math.abs(sb.timestampOffset - (10 + 5 * dt)) < 1e-9);
  assert.equal(sb.buffered.length, 1);
  assert.equal(sb.buffered.start(0), 10);
  assert.ok(Math.abs(sb.buffered.end(0) - (10 + 5 * dt)) < 1e-9);

  // 来了半帧之后 hls.js 改 offset（拖动）：半帧接不上新位置，扔掉
  sb.appendBuffer(SINE_STEREO.subarray(F * 5, F * 5 + 300));
  await wait();
  assert.equal(eng.log.push.length, 2);
  sb.timestampOffset = 60;
  sb.appendBuffer(SINE_STEREO.subarray(F * 10, F * 12));
  await wait();
  assert.deepEqual(eng.log.push[2], { n: 2, ts: 48000, off: 60 });
  assert.equal(sb.buffered.length, 2);
  assert.equal(sb.buffered.start(1), 60);
  assert.deepEqual(eng.log.fail, []);
});

test('FakeAudioSB audio/mpeg: MP3 / MPEG-2 报 audio-codec；changeType 能在两种输入间切', async () => {
  const l3 = new Uint8Array(417 * 2);
  l3.set([0xff, 0xfb, 0x90, 0x00], 0);
  l3.set([0xff, 0xfb, 0x90, 0x00], 417);
  const eng = fakeEngine();
  const sb = new FakeAudioSB(eng, 'audio/mpeg');
  sb.appendBuffer(l3);
  await wait();
  assert.deepEqual(eng.log.fail, ['audio-codec']);
  assert.equal(eng.log.push.length, 0);

  const eng2 = fakeEngine();
  const sb2 = new FakeAudioSB(eng2, 'audio/mp4;codecs=mp4a.40.2');
  sb2.changeType('audio/mpeg');
  assert.equal(sb2.mode, 'sequence');
  sb2.appendBuffer(SINE_STEREO.subarray(0, 576));
  await wait();
  assert.equal(eng2.log.push[0].n, 1);
  assert.deepEqual(eng2.log.fail, []);
});

/* ---------------- AudioPipeline：MP2 分片解码队列 ---------------- */

/** node 里没有 AudioContext：排期那半边不跑，只验解码入库 */
function makePipeline() {
  const video = new EventTarget();
  video.paused = true;
  const fails = [];
  const ap = new AudioPipeline({ video, speed: 1.5, path: 'webcodecs', realTime: () => 0, onFail: (r) => fails.push(r) });
  ap.setInit({ codec: 'mpeg', sampleRate: 48000, channels: 2, timescale: 48000, asc: null });
  return { ap, fails };
}

function mpegSamples(u8, from = 0, to = Infinity) {
  return splitMpegFrames(u8)
    .frames.slice(from, to)
    .map((f, i) => ({ t: (from + i) * 1152, d: 1152, data: f.data }));
}

async function drain(ap) {
  for (let i = 0; i < 400 && ap._mpQ.length; i++) await wait(2);
  assert.equal(ap._mpQ.length, 0, '解码队列没跑完');
}

test('AudioPipeline mp2: 分两批推，入库的 PCM 和一口气解的逐采样相同', async () => {
  const { ap, fails } = makePipeline();
  try {
    assert.equal(ap.stats.path, 'mp2');
    // 两批之间时间连续：滤波器状态要接着用，不能复位
    ap.push(mpegSamples(SINE_STEREO, 0, 12), 48000, 10);
    ap.push(mpegSamples(SINE_STEREO, 12), 48000, 10);
    await drain(ap);
    assert.deepEqual(fails, []);
    assert.equal(ap.stats.decoded, 25);
    assert.equal(ap.stats.decErrors, 0);
    const blocks = ap.store.blocks;
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].s0, 480000);
    assert.equal(blocks[1].s0, 480000 + 12 * 1152);
    const [L, R] = decodeAll(SINE_STEREO);
    const got = (c) => {
      const a = new Float32Array(25 * 1152);
      a.set(blocks[0].data[c], 0);
      a.set(blocks[1].data[c], 12 * 1152);
      return a;
    };
    assert.deepEqual(got(0), L);
    assert.deepEqual(got(1), R);
  } finally {
    ap.destroy();
  }
});

test('AudioPipeline mp2: remove 掉还在排队的批次；MP3 报 audio-codec；连着坏三批报 audio-decode', async () => {
  const { ap, fails } = makePipeline();
  try {
    ap.push(mpegSamples(SINE_STEREO, 0, 5), 48000, 0);
    ap.remove(0, Infinity);
    await drain(ap);
    assert.equal(ap.store.blocks.length, 0);
    assert.equal(ap._mpNext, null);

    const l3 = new Uint8Array(417);
    l3.set([0xff, 0xfb, 0x90, 0x00]);
    ap.push([{ t: 0, d: 1152, data: l3 }], 48000, 0);
    assert.deepEqual(fails, ['audio-codec']);
    assert.equal(ap._mpQ.length, 0);

    // 一批里偶尔一帧坏的照常入库
    const mixed = mpegSamples(SINE_STEREO, 0, 4);
    mixed[1] = { t: 1152, d: 1152, data: new Uint8Array(576) };
    ap.push(mixed, 48000, 0);
    await drain(ap);
    assert.equal(ap.store.blocks.length, 1);
    assert.equal(ap.stats.decErrors, 1);

    for (let k = 0; k < 3; k++) ap.push([{ t: k * 1152, d: 1152, data: new Uint8Array(576) }], 48000, 5);
    await drain(ap);
    assert.deepEqual(fails, ['audio-codec', 'audio-decode']);
    assert.equal(ap.store.blocks.length, 1);
  } finally {
    ap.destroy();
  }
});
