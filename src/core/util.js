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

// 生成占位 logo（频道名首字）
// loading="lazy"：频道列一次会建出整个分组的条目，不加这一句的话，开菜单那一瞬
// 会同时发出几百个台标请求——而屏上只看得见十几个。它们跟正在看的那路流
// 抢同一条线路（网关是按连接限速的，见 rangeLoad 头注释），还各占一个连接。
// 旧版 webOS 不认这个属性时会直接忽略，不会出错。
export function logoHtml(ch) {
  if (ch.logo) return `<img src="${esc(ch.logo)}" loading="lazy" decoding="async" onerror="this.style.display='none'" />`;
  const initial = (ch.name || '?').trim().charAt(0);
  return `<span style="font-size:28px;color:#5a6570">${esc(initial)}</span>`;
}
