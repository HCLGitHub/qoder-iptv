// 生成 webOS 应用图标：从 assets/app-icon-src.png 裁出图标主体后缩放输出
//   icon.png      80x80
//   largeIcon.png 130x130
// 不依赖任何第三方库，使用 Node 内置 zlib 手写 PNG 解码/编码。
// 运行：node scripts/gen-icons.mjs  （已挂到 npm 的 prebuild / predev）
import { deflateSync, inflateSync } from 'zlib';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'assets/app-icon-src.png');

/* ---------------- PNG 编解码基础 ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// 解码 PNG，返回 { width, height, rgba }。仅支持 8bit 非隔行的 RGB/RGBA/灰度。
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (depth !== 8) throw new Error('仅支持 8bit 位深，当前为 ' + depth);
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = px.slice(y * stride, y * stride + stride);
    const prev = y > 0 ? px.slice((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      out[i] = v & 0xff;
    }
  }

  // 统一展开成 RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 1) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s];
      rgba[d + 3] = 255;
    } else if (channels === 2) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s];
      rgba[d + 3] = px[s + 1];
    } else if (channels === 3) {
      rgba[d] = px[s];
      rgba[d + 1] = px[s + 1];
      rgba[d + 2] = px[s + 2];
      rgba[d + 3] = 255;
    } else {
      px.copy(rgba, d, s, s + 4);
    }
  }
  return { width, height, rgba };
}

/* ---------------- 图标加工 ---------------- */

// 自动定位图标主体：只统计"有颜色"的像素（饱和度足够高）。
// 素材四周是浅灰底且右下角带白灰色水印，它们饱和度都很低，因此不会被计入，
// 裁出主体的同时水印也就被去掉了。
function findSubjectBox({ width, height, rgba }) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      // 阈值取得偏高，好让主体边缘的抗锯齿过渡像素（紫/蓝与浅灰的混色）不被计入，
      // 否则裁剪框会比圆角方块大一圈，圆角外的浅灰底就会露出来
      if (sat > 0.5 && max > 60) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, size: Math.min(width, height) };
  // 收成正方形（以较长边为准并居中），保证图标不变形
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const size = Math.max(w, h);
  let x = Math.round(x0 - (size - w) / 2);
  let y = Math.round(y0 - (size - h) / 2);
  x = Math.max(0, Math.min(x, width - size));
  y = Math.max(0, Math.min(y, height - size));
  return { x, y, size };
}

// 面积平均缩放（box filter）：把源图的 box 区域缩到 out×out
function resizeArea(src, box, out) {
  const dst = Buffer.alloc(out * out * 4);
  const scale = box.size / out;
  for (let dy = 0; dy < out; dy++) {
    const sy0 = box.y + dy * scale;
    const sy1 = sy0 + scale;
    const iy0 = Math.floor(sy0);
    const iy1 = Math.min(src.height - 1, Math.ceil(sy1) - 1);
    for (let dx = 0; dx < out; dx++) {
      const sx0 = box.x + dx * scale;
      const sx1 = sx0 + scale;
      const ix0 = Math.floor(sx0);
      const ix1 = Math.min(src.width - 1, Math.ceil(sx1) - 1);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = iy0; sy <= iy1; sy++) {
        for (let sx = ix0; sx <= ix1; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.rgba[i];
          g += src.rgba[i + 1];
          b += src.rgba[i + 2];
          n++;
        }
      }
      const d = (dy * out + dx) * 4;
      dst[d] = Math.round(r / n);
      dst[d + 1] = Math.round(g / n);
      dst[d + 2] = Math.round(b / n);
      dst[d + 3] = 255;
    }
  }
  return dst;
}

// 圆角外区域设为透明（4x4 超采样做边缘抗锯齿），避免素材四角的浅灰底露出来
function applyRoundedAlpha(rgba, size, radiusRatio = 0.22) {
  const r = size * radiusRatio;
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          // 到圆角矩形的最近圆心距离判定
          const cx = Math.min(Math.max(px, r), size - r);
          const cy = Math.min(Math.max(py, r), size - r);
          const dx = px - cx;
          const dy = py - cy;
          if (dx * dx + dy * dy <= r * r) inside++;
        }
      }
      const i = (y * size + x) * 4 + 3;
      rgba[i] = Math.round((inside / (SS * SS)) * 255);
    }
  }
  return rgba;
}

/* ---------------- 主流程 ---------------- */

function main() {
  if (!existsSync(SRC)) {
    console.error('[gen-icons] 缺少图标素材：assets/app-icon-src.png');
    process.exit(1);
  }
  const src = decodePNG(readFileSync(SRC));
  const box = findSubjectBox(src);
  console.log(
    `[gen-icons] 素材 ${src.width}x${src.height}，裁出主体 ${box.size}x${box.size} @ (${box.x},${box.y})`
  );

  for (const [file, size] of [
    ['icon.png', 80],
    ['largeIcon.png', 130]
  ]) {
    const rgba = applyRoundedAlpha(resizeArea(src, box, size), size);
    writeFileSync(resolve(ROOT, file), encodePNG(size, size, rgba));
    console.log(`[gen-icons] ${file} (${size}x${size}) 已生成`);
  }
}

main();
