// 通用工具函数
import { t } from './i18n.js';

export function pad2(n) {
  return String(n).padStart(2, '0');
}

// HH:MM
export function fmtTime(ms) {
  if (isNaN(ms)) return '';
  const d = new Date(ms);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// HH:MM:SS
export function fmtClock(d = new Date()) {
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

// YYYY-MM-DD 周X（英文下为 YYYY-MM-DD Tue）
function weekLabel(d) {
  return t('date.weekFmt', { d: t('date.week.' + d.getDay()) });
}
export function fmtDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${weekLabel(d)}`;
}

// 简短日期标签：今天 / 明天 / 昨天 / MM-DD 周X
export function fmtDayLabel(dayOffset) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  if (dayOffset === 0) return t('date.today');
  if (dayOffset === 1) return t('date.tomorrow');
  if (dayOffset === -1) return t('date.yesterday');
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${weekLabel(d)}`;
}

// HTML 转义
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LOGO_TINTS = 6;
// 加载失败过的台标地址：同一地址不再反复请求（电视上整组挂掉的图每开一次菜单就是几百个超时）
const failedLogos = new Set();
const FAILED_LOGO_MAX = 500;

export function isLogoFailed(url) {
  return failedLogos.has(url);
}

export function markLogoFailed(url) {
  if (url && failedLogos.size < FAILED_LOGO_MAX) failedLogos.add(url);
}

// 文字台标：西文/数字开头取首段（去掉连字符，如 CCTV-5+ → CCTV5+），否则取前两个字（湖南卫视 → 湖南）
export function logoText(name) {
  const s = String(name || '').replace(/^[^\p{L}\p{N}]+/u, '');
  const latin = s.match(/^[A-Za-z0-9+\-]+/);
  if (latin) {
    const code = latin[0].replace(/-/g, '').slice(0, 6);
    if (code) return code;
  }
  const chars = Array.from(s).filter((c) => /[\p{L}\p{N}]/u.test(c));
  return chars.slice(0, 2).join('') || '?';
}

// 文字台标的宽度档（按字宽估算：汉字 1em、西文约 0.62em），CSS 按档位选字号
function logoWidthClass(text) {
  let w = 0;
  for (const c of text) w += c.charCodeAt(0) > 0x2e7f ? 1 : 0.62;
  return w <= 2 ? 'w-s' : w <= 3.2 ? 'w-m' : 'w-l';
}

function logoTint(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % LOGO_TINTS;
}

// 台标：有图出图，没图或图挂了显示文字台标（图片 onerror 时自删，CSS 让后面的文字块露出来）
// loading="lazy"：频道列一次会建出整个分组的条目，不加这一句的话，开菜单那一瞬
// 会同时发出几百个台标请求——而屏上只看得见十几个。它们跟正在看的那路流
// 抢同一条线路（网关是按连接限速的，见 rangeLoad 头注释），还各占一个连接。
// 旧版 webOS 不认这个属性时会直接忽略，不会出错。
export function logoHtml(ch) {
  const text = logoText(ch.name);
  const tile = `<span class="logo-txt logo-c${logoTint(ch.name)} ${logoWidthClass(text)}">${esc(text)}</span>`;
  if (!ch.logo || isLogoFailed(ch.logo)) return tile;
  return `<img src="${esc(ch.logo)}" loading="lazy" decoding="async" onerror="this.remove()" />` + tile;
}
