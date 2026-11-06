// MPEG-1 Layer II（MP2）解码：回看 TS 里的音轨多是 MP2，浏览器自带的解码接口不一定认，倍速时自己解。
//
// 移植自 jsmpeg 的 src/mp2.js（MIT License, Copyright (c) 2017 Dominic Szablewski），
// 它又基于 Martin J. Fiedler 的 kjmp2。和原版的区别：
//   - 直接从 Uint8Array 解一整帧，不走它的环形 BitBuffer；
//   - 只解 MPEG-1 Layer II，MPEG-2 低采样率和 Layer I/III 交给上层回退；
//   - 强度立体声子带：量化值两个声道共用，但各自乘自己的比例因子（原版直接抄左声道的结果）；
//   - 合成滤波累加用浮点，响的片段不会整数溢出。

const BITRATE_V1 = [
  null,
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
];
const BITRATE_V2 = [
  null,
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
];
// 下标是头里的 version 位：3 = MPEG-1，2 = MPEG-2，0 = MPEG-2.5
const SAMPLE_RATE = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]];

/**
 * 解析 MPEG 音频帧头（4 字节）。不是合法帧头返回 null。
 * version 用头里的原始位（3 = MPEG-1），layer 是真实层号 1/2/3。
 */
export function parseMpegHeader(u8, p) {
  if (p + 4 > u8.length || u8[p] !== 0xff || (u8[p + 1] & 0xe0) !== 0xe0) return null;
  const b1 = u8[p + 1];
  const b2 = u8[p + 2];
  const b3 = u8[p + 3];
  const version = (b1 >> 3) & 3;
  const lbits = (b1 >> 1) & 3;
  if (version === 1 || lbits === 0) return null;
  const layer = 4 - lbits;
  const bri = b2 >> 4;
  const sri = (b2 >> 2) & 3;
  // 0 是 free format，帧长没法从头里算，当坏数据
  if (bri === 0 || bri === 15 || sri === 3) return null;
  const bitrate = (version === 3 ? BITRATE_V1 : BITRATE_V2)[layer][bri];
  const sampleRate = SAMPLE_RATE[version][sri];
  const padding = (b2 >> 1) & 1;
  const mode = b3 >> 6;
  let samples;
  let frameLength;
  if (layer === 1) {
    samples = 384;
    frameLength = (Math.floor((12000 * bitrate) / sampleRate) + padding) * 4;
  } else {
    samples = layer === 3 && version !== 3 ? 576 : 1152;
    frameLength = Math.floor((samples * 125 * bitrate) / sampleRate) + padding;
  }
  return {
    version,
    layer,
    bri,
    sri,
    bitrate,
    sampleRate,
    padding,
    mode,
    modeExt: (b3 >> 4) & 3,
    channels: mode === 3 ? 1 : 2,
    crc: !(b1 & 1),
    samples,
    frameLength
  };
}

/**
 * 把一段裸 MPEG 音频切成整帧。帧头对不上就逐字节往后找同步字；
 * 末尾不够一帧的那截放进 rest，下次 append 拼上。
 * @returns {{frames:Array<{h:object,data:Uint8Array}>, rest:Uint8Array|null}}
 */
export function splitMpegFrames(u8) {
  const frames = [];
  const n = u8.length;
  let p = 0;
  while (p + 4 <= n) {
    const h = parseMpegHeader(u8, p);
    if (!h) {
      p++;
      continue;
    }
    if (p + h.frameLength > n) break;
    frames.push({ h, data: u8.subarray(p, p + h.frameLength) });
    p += h.frameLength;
  }
  return { frames, rest: p < n ? u8.slice(p) : null };
}

/* ---------------- 量化表（ISO 11172-3 附录 B.2，kjmp2 的压缩写法） ---------------- */

// 每声道码率 → 码率档
const LUT1 = [
  [0, 0, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2], // 单声道：32 48 56 64 80 96 112 128 160 192 224 256 320 384
  [0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 2] // 立体声：按每声道码率
];
// 码率档 × 采样率 → 分配表（高位 64 = 高码率表）| sblimit
const TAB_A = 27 | 64;
const TAB_B = 30 | 64;
const TAB_C = 8;
const TAB_D = 12;
const LUT2 = [
  //  44.1k  48k    32k
  [TAB_C, TAB_C, TAB_D],
  [TAB_A, TAB_A, TAB_A],
  [TAB_B, TAB_A, TAB_B]
];
// 分配表 × 子带 → 高 4 位 nbal，低 4 位 LUT4 的行
const LUT3 = [
  [0x44, 0x44, 0x34, 0x34, 0x34, 0x34, 0x34, 0x34, 0x34, 0x34, 0x34, 0x34],
  [
    0x43, 0x43, 0x43, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20
  ]
];
// 行 × allocation 值 → 量化器编号（从 1 起，0 = 这个子带没分配比特）
const LUT4 = [
  [0, 1, 2, 17],
  [0, 1, 2, 3, 4, 5, 6, 17],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17],
  [0, 1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
  [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
];
const QUANT = [
  { levels: 3, group: 1, bits: 5 },
  { levels: 5, group: 1, bits: 7 },
  { levels: 7, group: 0, bits: 3 },
  { levels: 9, group: 1, bits: 10 },
  { levels: 15, group: 0, bits: 4 },
  { levels: 31, group: 0, bits: 5 },
  { levels: 63, group: 0, bits: 6 },
  { levels: 127, group: 0, bits: 7 },
  { levels: 255, group: 0, bits: 8 },
  { levels: 511, group: 0, bits: 9 },
  { levels: 1023, group: 0, bits: 10 },
  { levels: 2047, group: 0, bits: 11 },
  { levels: 4095, group: 0, bits: 12 },
  { levels: 8191, group: 0, bits: 13 },
  { levels: 16383, group: 0, bits: 14 },
  { levels: 32767, group: 0, bits: 15 },
  { levels: 65535, group: 0, bits: 16 }
];
const SCALEFACTOR_BASE = [0x02000000, 0x01965fea, 0x01428a30];

// 合成窗（kjmp2 的定点系数，原样照抄）
const SYNTHESIS_WINDOW = [
  0, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -1,
  -1, -1, -1, -1.5, -1.5, -2, -2, -2.5,
  -2.5, -3, -3.5, -3.5, -4, -4.5, -5, -5.5,
  -6.5, -7, -8, -8.5, -9.5, -10.5, -12, -13,
  -14.5, -15.5, -17.5, -19, -20.5, -22.5, -24.5, -26.5,
  -29, -31.5, -34, -36.5, -39.5, -42.5, -45.5, -48.5,
  -52, -55.5, -58.5, -62.5, -66, -69.5, -73.5, -77,
  -80.5, -84.5, -88, -91.5, -95, -98, -101, -104,
  106.5, 109, 111, 112.5, 113.5, 114, 114, 113.5,
  112, 110.5, 107.5, 104, 100, 94.5, 88.5, 81.5,
  73, 63.5, 53, 41.5, 28.5, 14.5, -1, -18,
  -36, -55.5, -76.5, -98.5, -122, -147, -173.5, -200.5,
  -229.5, -259.5, -290.5, -322.5, -355.5, -389.5, -424, -459.5,
  -495.5, -532, -568.5, -605, -641.5, -678, -714, -749,
  -783.5, -817, -849, -879.5, -908.5, -935, -959.5, -981,
  -1000.5, -1016, -1028.5, -1037.5, -1042.5, -1043.5, -1040, -1031.5,
  1018.5, 1000, 976, 946.5, 911, 869.5, 822, 767.5,
  707, 640, 565.5, 485, 397, 302.5, 201, 92.5,
  -22.5, -144, -272.5, -407, -547.5, -694, -846, -1003,
  -1165, -1331.5, -1502, -1675.5, -1852.5, -2031.5, -2212.5, -2394,
  -2576.5, -2758.5, -2939.5, -3118.5, -3294.5, -3467.5, -3635.5, -3798.5,
  -3955, -4104.5, -4245.5, -4377.5, -4499, -4609.5, -4708, -4792.5,
  -4863.5, -4919, -4958, -4979.5, -4983, -4967.5, -4931.5, -4875,
  -4796, -4694.5, -4569.5, -4420, -4246, -4046, -3820, -3567,
  3287, 2979.5, 2644, 2280.5, 1888, 1467.5, 1018.5, 541,
  35, -499, -1061, -1650, -2266.5, -2909, -3577, -4270,
  -4987.5, -5727.5, -6490, -7274, -8077.5, -8899.5, -9739, -10594.5,
  -11464.5, -12347, -13241, -14144.5, -15056, -15973.5, -16895.5, -17820,
  -18744.5, -19668, -20588, -21503, -22410.5, -23308.5, -24195, -25068.5,
  -25926.5, -26767, -27589, -28389, -29166.5, -29919, -30644.5, -31342,
  -32009.5, -32645, -33247, -33814.5, -34346, -34839.5, -35295, -35710,
  -36084.5, -36417.5, -36707.5, -36954, -37156.5, -37315, -37428, -37496,
  37519, 37496, 37428, 37315, 37156.5, 36954, 36707.5, 36417.5,
  36084.5, 35710, 35295, 34839.5, 34346, 33814.5, 33247, 32645,
  32009.5, 31342, 30644.5, 29919, 29166.5, 28389, 27589, 26767,
  25926.5, 25068.5, 24195, 23308.5, 22410.5, 21503, 20588, 19668,
  18744.5, 17820, 16895.5, 15973.5, 15056, 14144.5, 13241, 12347,
  11464.5, 10594.5, 9739, 8899.5, 8077.5, 7274, 6490, 5727.5,
  4987.5, 4270, 3577, 2909, 2266.5, 1650, 1061, 499,
  -35, -541, -1018.5, -1467.5, -1888, -2280.5, -2644, -2979.5,
  3287, 3567, 3820, 4046, 4246, 4420, 4569.5, 4694.5,
  4796, 4875, 4931.5, 4967.5, 4983, 4979.5, 4958, 4919,
  4863.5, 4792.5, 4708, 4609.5, 4499, 4377.5, 4245.5, 4104.5,
  3955, 3798.5, 3635.5, 3467.5, 3294.5, 3118.5, 2939.5, 2758.5,
  2576.5, 2394, 2212.5, 2031.5, 1852.5, 1675.5, 1502, 1331.5,
  1165, 1003, 846, 694, 547.5, 407, 272.5, 144,
  22.5, -92.5, -201, -302.5, -397, -485, -565.5, -640,
  -707, -767.5, -822, -869.5, -911, -946.5, -976, -1000,
  1018.5, 1031.5, 1040, 1043.5, 1042.5, 1037.5, 1028.5, 1016,
  1000.5, 981, 959.5, 935, 908.5, 879.5, 849, 817,
  783.5, 749, 714, 678, 641.5, 605, 568.5, 532,
  495.5, 459.5, 424, 389.5, 355.5, 322.5, 290.5, 259.5,
  229.5, 200.5, 173.5, 147, 122, 98.5, 76.5, 55.5,
  36, 18, 1, -14.5, -28.5, -41.5, -53, -63.5,
  -73, -81.5, -88.5, -94.5, -100, -104, -107.5, -110.5,
  -112, -113.5, -114, -114, -113.5, -112.5, -111, -109,
  106.5, 104, 101, 98, 95, 91.5, 88, 84.5,
  80.5, 77, 73.5, 69.5, 66, 62.5, 58.5, 55.5,
  52, 48.5, 45.5, 42.5, 39.5, 36.5, 34, 31.5,
  29, 26.5, 24.5, 22.5, 20.5, 19, 17.5, 15.5,
  14.5, 13, 12, 10.5, 9.5, 8.5, 8, 7,
  6.5, 5.5, 5, 4.5, 4, 3.5, 3.5, 3,
  2.5, 2.5, 2, 2, 1.5, 1.5, 1, 1,
  1, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5
];

/** 32 点 DCT，写进 V 环形缓冲 d[dp..dp+63]（kjmp2/jsmpeg 原样照抄） */
function matrixTransform(s, ss, d, dp) {
  let t01, t02, t03, t04, t05, t06, t07, t08, t09, t10, t11, t12,
   t13, t14, t15, t16, t17, t18, t19, t20, t21, t22, t23, t24,
   t25, t26, t27, t28, t29, t30, t31, t32, t33;

  t01 = s[ 0][ss] + s[31][ss]; t02 = (s[ 0][ss] - s[31][ss]) * 0.500602998235;
  t03 = s[ 1][ss] + s[30][ss]; t04 = (s[ 1][ss] - s[30][ss]) * 0.505470959898;
  t05 = s[ 2][ss] + s[29][ss]; t06 = (s[ 2][ss] - s[29][ss]) * 0.515447309923;
  t07 = s[ 3][ss] + s[28][ss]; t08 = (s[ 3][ss] - s[28][ss]) * 0.53104259109;
  t09 = s[ 4][ss] + s[27][ss]; t10 = (s[ 4][ss] - s[27][ss]) * 0.553103896034;
  t11 = s[ 5][ss] + s[26][ss]; t12 = (s[ 5][ss] - s[26][ss]) * 0.582934968206;
  t13 = s[ 6][ss] + s[25][ss]; t14 = (s[ 6][ss] - s[25][ss]) * 0.622504123036;
  t15 = s[ 7][ss] + s[24][ss]; t16 = (s[ 7][ss] - s[24][ss]) * 0.674808341455;
  t17 = s[ 8][ss] + s[23][ss]; t18 = (s[ 8][ss] - s[23][ss]) * 0.744536271002;
  t19 = s[ 9][ss] + s[22][ss]; t20 = (s[ 9][ss] - s[22][ss]) * 0.839349645416;
  t21 = s[10][ss] + s[21][ss]; t22 = (s[10][ss] - s[21][ss]) * 0.972568237862;
  t23 = s[11][ss] + s[20][ss]; t24 = (s[11][ss] - s[20][ss]) * 1.16943993343;
  t25 = s[12][ss] + s[19][ss]; t26 = (s[12][ss] - s[19][ss]) * 1.48416461631;
  t27 = s[13][ss] + s[18][ss]; t28 = (s[13][ss] - s[18][ss]) * 2.05778100995;
  t29 = s[14][ss] + s[17][ss]; t30 = (s[14][ss] - s[17][ss]) * 3.40760841847;
  t31 = s[15][ss] + s[16][ss]; t32 = (s[15][ss] - s[16][ss]) * 10.1900081235;

  t33 = t01 + t31; t31 = (t01 - t31) * 0.502419286188;
  t01 = t03 + t29; t29 = (t03 - t29) * 0.52249861494;
  t03 = t05 + t27; t27 = (t05 - t27) * 0.566944034816;
  t05 = t07 + t25; t25 = (t07 - t25) * 0.64682178336;
  t07 = t09 + t23; t23 = (t09 - t23) * 0.788154623451;
  t09 = t11 + t21; t21 = (t11 - t21) * 1.06067768599;
  t11 = t13 + t19; t19 = (t13 - t19) * 1.72244709824;
  t13 = t15 + t17; t17 = (t15 - t17) * 5.10114861869;
  t15 = t33 + t13; t13 = (t33 - t13) * 0.509795579104;
  t33 = t01 + t11; t01 = (t01 - t11) * 0.601344886935;
  t11 = t03 + t09; t09 = (t03 - t09) * 0.899976223136;
  t03 = t05 + t07; t07 = (t05 - t07) * 2.56291544774;
  t05 = t15 + t03; t15 = (t15 - t03) * 0.541196100146;
  t03 = t33 + t11; t11 = (t33 - t11) * 1.30656296488;
  t33 = t05 + t03; t05 = (t05 - t03) * 0.707106781187;
  t03 = t15 + t11; t15 = (t15 - t11) * 0.707106781187;
  t03 += t15;
  t11 = t13 + t07; t13 = (t13 - t07) * 0.541196100146;
  t07 = t01 + t09; t09 = (t01 - t09) * 1.30656296488;
  t01 = t11 + t07; t07 = (t11 - t07) * 0.707106781187;
  t11 = t13 + t09; t13 = (t13 - t09) * 0.707106781187;
  t11 += t13; t01 += t11;
  t11 += t07; t07 += t13;
  t09 = t31 + t17; t31 = (t31 - t17) * 0.509795579104;
  t17 = t29 + t19; t29 = (t29 - t19) * 0.601344886935;
  t19 = t27 + t21; t21 = (t27 - t21) * 0.899976223136;
  t27 = t25 + t23; t23 = (t25 - t23) * 2.56291544774;
  t25 = t09 + t27; t09 = (t09 - t27) * 0.541196100146;
  t27 = t17 + t19; t19 = (t17 - t19) * 1.30656296488;
  t17 = t25 + t27; t27 = (t25 - t27) * 0.707106781187;
  t25 = t09 + t19; t19 = (t09 - t19) * 0.707106781187;
  t25 += t19;
  t09 = t31 + t23; t31 = (t31 - t23) * 0.541196100146;
  t23 = t29 + t21; t21 = (t29 - t21) * 1.30656296488;
  t29 = t09 + t23; t23 = (t09 - t23) * 0.707106781187;
  t09 = t31 + t21; t31 = (t31 - t21) * 0.707106781187;
  t09 += t31; t29 += t09; t09 += t23; t23 += t31;
  t17 += t29; t29 += t25; t25 += t09; t09 += t27;
  t27 += t23; t23 += t19; t19 += t31;
  t21 = t02 + t32; t02 = (t02 - t32) * 0.502419286188;
  t32 = t04 + t30; t04 = (t04 - t30) * 0.52249861494;
  t30 = t06 + t28; t28 = (t06 - t28) * 0.566944034816;
  t06 = t08 + t26; t08 = (t08 - t26) * 0.64682178336;
  t26 = t10 + t24; t10 = (t10 - t24) * 0.788154623451;
  t24 = t12 + t22; t22 = (t12 - t22) * 1.06067768599;
  t12 = t14 + t20; t20 = (t14 - t20) * 1.72244709824;
  t14 = t16 + t18; t16 = (t16 - t18) * 5.10114861869;
  t18 = t21 + t14; t14 = (t21 - t14) * 0.509795579104;
  t21 = t32 + t12; t32 = (t32 - t12) * 0.601344886935;
  t12 = t30 + t24; t24 = (t30 - t24) * 0.899976223136;
  t30 = t06 + t26; t26 = (t06 - t26) * 2.56291544774;
  t06 = t18 + t30; t18 = (t18 - t30) * 0.541196100146;
  t30 = t21 + t12; t12 = (t21 - t12) * 1.30656296488;
  t21 = t06 + t30; t30 = (t06 - t30) * 0.707106781187;
  t06 = t18 + t12; t12 = (t18 - t12) * 0.707106781187;
  t06 += t12;
  t18 = t14 + t26; t26 = (t14 - t26) * 0.541196100146;
  t14 = t32 + t24; t24 = (t32 - t24) * 1.30656296488;
  t32 = t18 + t14; t14 = (t18 - t14) * 0.707106781187;
  t18 = t26 + t24; t24 = (t26 - t24) * 0.707106781187;
  t18 += t24; t32 += t18;
  t18 += t14; t26 = t14 + t24;
  t14 = t02 + t16; t02 = (t02 - t16) * 0.509795579104;
  t16 = t04 + t20; t04 = (t04 - t20) * 0.601344886935;
  t20 = t28 + t22; t22 = (t28 - t22) * 0.899976223136;
  t28 = t08 + t10; t10 = (t08 - t10) * 2.56291544774;
  t08 = t14 + t28; t14 = (t14 - t28) * 0.541196100146;
  t28 = t16 + t20; t20 = (t16 - t20) * 1.30656296488;
  t16 = t08 + t28; t28 = (t08 - t28) * 0.707106781187;
  t08 = t14 + t20; t20 = (t14 - t20) * 0.707106781187;
  t08 += t20;
  t14 = t02 + t10; t02 = (t02 - t10) * 0.541196100146;
  t10 = t04 + t22; t22 = (t04 - t22) * 1.30656296488;
  t04 = t14 + t10; t10 = (t14 - t10) * 0.707106781187;
  t14 = t02 + t22; t02 = (t02 - t22) * 0.707106781187;
  t14 += t02; t04 += t14; t14 += t10; t10 += t02;
  t16 += t04; t04 += t08; t08 += t14; t14 += t28;
  t28 += t10; t10 += t20; t20 += t02; t21 += t16;
  t16 += t32; t32 += t04; t04 += t06; t06 += t08;
  t08 += t18; t18 += t14; t14 += t30; t30 += t28;
  t28 += t26; t26 += t10; t10 += t12; t12 += t20;
  t20 += t24; t24 += t02;

  d[dp + 48] = -t33;
  d[dp + 49] = d[dp + 47] = -t21;
  d[dp + 50] = d[dp + 46] = -t17;
  d[dp + 51] = d[dp + 45] = -t16;
  d[dp + 52] = d[dp + 44] = -t01;
  d[dp + 53] = d[dp + 43] = -t32;
  d[dp + 54] = d[dp + 42] = -t29;
  d[dp + 55] = d[dp + 41] = -t04;
  d[dp + 56] = d[dp + 40] = -t03;
  d[dp + 57] = d[dp + 39] = -t06;
  d[dp + 58] = d[dp + 38] = -t25;
  d[dp + 59] = d[dp + 37] = -t08;
  d[dp + 60] = d[dp + 36] = -t11;
  d[dp + 61] = d[dp + 35] = -t18;
  d[dp + 62] = d[dp + 34] = -t09;
  d[dp + 63] = d[dp + 33] = -t14;
  d[dp + 32] = -t05;
  d[dp +  0] = t05; d[dp + 31] = -t30;
  d[dp +  1] = t30; d[dp + 30] = -t27;
  d[dp +  2] = t27; d[dp + 29] = -t28;
  d[dp +  3] = t28; d[dp + 28] = -t07;
  d[dp +  4] = t07; d[dp + 27] = -t26;
  d[dp +  5] = t26; d[dp + 26] = -t23;
  d[dp +  6] = t23; d[dp + 25] = -t10;
  d[dp +  7] = t10; d[dp + 24] = -t15;
  d[dp +  8] = t15; d[dp + 23] = -t12;
  d[dp +  9] = t12; d[dp + 22] = -t19;
  d[dp + 10] = t19; d[dp + 21] = -t20;
  d[dp + 11] = t20; d[dp + 20] = -t13;
  d[dp + 12] = t13; d[dp + 19] = -t24;
  d[dp + 13] = t24; d[dp + 18] = -t31;
  d[dp + 14] = t31; d[dp + 17] = -t02;
  d[dp + 15] = t02; d[dp + 16] =  0.0;
}

/** 按位读，读过头补 0（坏帧不至于抛异常） */
class Bits {
  constructor() {
    this.u8 = null;
    this.pos = 0;
    this.end = 0;
  }
  set(u8, bytePos) {
    this.u8 = u8;
    this.pos = bytePos * 8;
    this.end = u8.length;
  }
  /** n ≤ 16 */
  read(n) {
    const u8 = this.u8;
    const e = this.end;
    const p = this.pos;
    const i = p >> 3;
    const w = ((i < e ? u8[i] : 0) << 16) | ((i + 1 < e ? u8[i + 1] : 0) << 8) | (i + 2 < e ? u8[i + 2] : 0);
    this.pos = p + n;
    return (w >>> (24 - (p & 7) - n)) & ((1 << n) - 1);
  }
  skip(n) {
    this.pos += n;
  }
}

/**
 * 定点反量化，结果约 ±2^15。重建值按标准是 (levels-1-2c)/levels；
 * kjmp2 原式除的是 levels+1，粗量化器（3/5/9 级）会小一截，和 ffmpeg 对比时噪声段只有十几 dB。
 */
function dequant(q, sfi, codes, out) {
  let sf = 0;
  if (sfi !== 63) {
    const shift = (sfi / 3) | 0;
    sf = (SCALEFACTOR_BASE[sfi % 3] + ((1 << shift) >> 1)) >> shift;
  }
  const scale = (65536 / q.levels) | 0;
  const adj = ((q.levels + 1) >> 1) - 1;
  for (let k = 0; k < 3; k++) {
    const val = (adj - codes[k]) * scale;
    out[k] = (val * (sf >> 12) + ((val * (sf & 4095) + 2048) >> 12)) >> 12;
  }
}

function zero3(a) {
  a[0] = a[1] = a[2] = 0;
}

export class Mp2Decoder {
  constructor() {
    this.bits = new Bits();
    this.D = new Float64Array(1024);
    this.D.set(SYNTHESIS_WINDOW, 0);
    this.D.set(SYNTHESIS_WINDOW, 512);
    this.V = [new Float64Array(1024), new Float64Array(1024)];
    this.U = new Float64Array(32);
    this.VPos = 0;
    this.alloc = [new Array(32).fill(null), new Array(32).fill(null)];
    this.scfsi = [new Uint8Array(32), new Uint8Array(32)];
    this.sf = [[], []];
    this.sample = [[], []];
    for (let c = 0; c < 2; c++) {
      for (let sb = 0; sb < 32; sb++) {
        this.sf[c].push([0, 0, 0]);
        this.sample[c].push([0, 0, 0]);
      }
    }
    this.codes = [0, 0, 0];
  }

  /** 时间轴跳了（拖动、补片）就清滤波器状态，免得把上一段的尾巴混进来 */
  reset() {
    this.V[0].fill(0);
    this.V[1].fill(0);
    this.VPos = 0;
  }

  _alloc(sb, tab3) {
    const t = LUT3[tab3][sb];
    const qi = LUT4[t & 15][this.bits.read(t >> 4)];
    return qi ? QUANT[qi - 1] : null;
  }

  _codes(q) {
    const c = this.codes;
    const bits = this.bits;
    if (q.group) {
      let v = bits.read(q.bits);
      c[0] = v % q.levels;
      v = (v / q.levels) | 0;
      c[1] = v % q.levels;
      c[2] = (v / q.levels) | 0;
    } else {
      c[0] = bits.read(q.bits);
      c[1] = bits.read(q.bits);
      c[2] = bits.read(q.bits);
    }
    return c;
  }

  /**
   * 解一帧，1152 个采样写进 L/R 的 [pos, pos+1152)（单声道两边一样）。
   * 不是 MPEG-1 Layer II 返回 false，L/R 不动。
   */
  decode(data, L, R, pos) {
    const h = parseMpegHeader(data, 0);
    if (!h || h.version !== 3 || h.layer !== 2) return false;
    const bits = this.bits;
    bits.set(data, 4);
    if (h.crc) bits.skip(16);
    const mono = h.mode === 3;
    let bound = h.mode === 1 ? (h.modeExt + 1) << 2 : mono ? 0 : 32;
    let tab3 = LUT2[LUT1[mono ? 0 : 1][h.bri - 1]][h.sri];
    const sblimit = tab3 & 63;
    tab3 >>= 6;
    if (bound > sblimit) bound = sblimit;
    const chs = mono ? 1 : 2;
    const alloc = this.alloc;
    const scfsi = this.scfsi;
    const sf = this.sf;
    const sample = this.sample;

    for (let sb = 0; sb < bound; sb++) {
      alloc[0][sb] = this._alloc(sb, tab3);
      alloc[1][sb] = this._alloc(sb, tab3);
    }
    for (let sb = bound; sb < sblimit; sb++) alloc[0][sb] = alloc[1][sb] = this._alloc(sb, tab3);

    for (let sb = 0; sb < sblimit; sb++) {
      for (let c = 0; c < chs; c++) if (alloc[c][sb]) scfsi[c][sb] = bits.read(2);
    }
    for (let sb = 0; sb < sblimit; sb++) {
      for (let c = 0; c < chs; c++) {
        if (!alloc[c][sb]) continue;
        const f = sf[c][sb];
        switch (scfsi[c][sb]) {
          case 0:
            f[0] = bits.read(6);
            f[1] = bits.read(6);
            f[2] = bits.read(6);
            break;
          case 1:
            f[0] = f[1] = bits.read(6);
            f[2] = bits.read(6);
            break;
          case 2:
            f[0] = f[1] = f[2] = bits.read(6);
            break;
          default:
            f[0] = bits.read(6);
            f[1] = f[2] = bits.read(6);
        }
      }
    }

    const D = this.D;
    const U = this.U;
    let out = pos;
    for (let part = 0; part < 3; part++) {
      for (let gr = 0; gr < 4; gr++) {
        for (let sb = 0; sb < bound; sb++) {
          for (let c = 0; c < 2; c++) {
            const q = alloc[c][sb];
            if (q) dequant(q, sf[c][sb][part], this._codes(q), sample[c][sb]);
            else zero3(sample[c][sb]);
          }
        }
        for (let sb = bound; sb < sblimit; sb++) {
          const q = alloc[0][sb];
          if (!q) {
            zero3(sample[0][sb]);
            zero3(sample[1][sb]);
            continue;
          }
          const codes = this._codes(q);
          dequant(q, sf[0][sb][part], codes, sample[0][sb]);
          if (!mono) dequant(q, sf[1][sb][part], codes, sample[1][sb]);
        }
        for (let sb = sblimit; sb < 32; sb++) {
          zero3(sample[0][sb]);
          zero3(sample[1][sb]);
        }

        for (let p = 0; p < 3; p++) {
          this.VPos = (this.VPos - 64) & 1023;
          for (let c = 0; c < chs; c++) {
            const V = this.V[c];
            matrixTransform(sample[c], p, V, this.VPos);
            U.fill(0);
            let dIndex = 512 - (this.VPos >> 1);
            let vIndex = (this.VPos % 128) >> 1;
            while (vIndex < 1024) {
              for (let i = 0; i < 32; ++i) U[i] += D[dIndex++] * V[vIndex++];
              vIndex += 128 - 32;
              dIndex += 64 - 32;
            }
            vIndex = 128 - 32 + 1024 - vIndex;
            dIndex -= 512 - 32;
            while (vIndex < 1024) {
              for (let i = 0; i < 32; ++i) U[i] += D[dIndex++] * V[vIndex++];
              vIndex += 128 - 32;
              dIndex += 64 - 32;
            }
            const dst = c === 0 ? L : R;
            for (let j = 0; j < 32; j++) {
              // jsmpeg 的窗系数是 kjmp2 的一半、极性也反了：这里乘回来，和 ffmpeg 解出来的对齐
              const v = U[j] / -1073709056;
              dst[out + j] = v > 1 ? 1 : v < -1 ? -1 : v;
            }
          }
          if (mono) R.set(L.subarray(out, out + 32), out);
          out += 32;
        }
      }
    }
    return true;
  }
}
